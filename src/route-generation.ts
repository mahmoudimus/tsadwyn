import { Router, Request, Response, NextFunction } from "express";
import { ZodObject, ZodTypeAny } from "zod";
import type { RouteDefinition, VersionedRouter } from "./router.js";
import type { VersionBundle, VersionChange } from "./structure/versions.js";
import { RequestInfo, ResponseInfo } from "./structure/data.js";
import { ZodSchemaRegistry, generateVersionedSchemas } from "./schema-generation.js";

/**
 * Build a ZodSchemaRegistry from the route definitions.
 * Collects all named Zod schemas used in request/response positions.
 */
function buildRegistryFromRoutes(routes: RouteDefinition[]): ZodSchemaRegistry {
  const registry = new ZodSchemaRegistry();

  for (const route of routes) {
    if (route.requestSchema && (route.requestSchema as any)._tsadwynName) {
      registry.register(
        (route.requestSchema as any)._tsadwynName,
        route.requestSchema,
      );
    }
    if (route.responseSchema && (route.responseSchema as any)._tsadwynName) {
      registry.register(
        (route.responseSchema as any)._tsadwynName,
        route.responseSchema,
      );
    }
  }

  return registry;
}

/**
 * Look up the original (head/latest) schema name for a route's request or response schema.
 */
function getSchemaName(schema: ZodTypeAny | null): string | null {
  if (!schema) return null;
  return (schema as any)._tsadwynName || null;
}

/**
 * Generate versioned Express routers from a VersionedRouter and VersionBundle.
 *
 * For each version, this:
 * 1. Creates versioned copies of Zod schemas with field alterations applied.
 * 2. Creates an Express Router with routes that use version-specific validation.
 * 3. Wires up request migration (old version -> latest) and response migration
 *    (latest -> old version) callbacks.
 *
 * Returns a Map of version string -> Express Router.
 */
export function generateVersionedRouters(
  versionedRouter: VersionedRouter,
  versions: VersionBundle,
): Map<string, Router> {
  const baseRegistry = buildRegistryFromRoutes(versionedRouter.routes);
  const versionedSchemas = generateVersionedSchemas(versions, baseRegistry);
  const result = new Map<string, Router>();

  for (const version of versions.versions) {
    const router = Router();
    const registry = versionedSchemas.get(version.value);

    for (const routeDef of versionedRouter.routes) {
      const expressMethod = routeDef.method.toLowerCase() as
        | "get"
        | "post"
        | "put"
        | "patch"
        | "delete";

      // Determine the versioned request schema for validation
      const requestSchemaName = getSchemaName(routeDef.requestSchema);
      let versionedRequestSchema: ZodTypeAny | null = null;
      if (requestSchemaName && registry?.has(requestSchemaName)) {
        versionedRequestSchema = registry.get(requestSchemaName)!.schema;
      } else {
        versionedRequestSchema = routeDef.requestSchema;
      }

      // Build the request migration chain: from this version forward to latest.
      // We need to run migration callbacks from versions newer than the current one,
      // walking from oldest to newest (i.e., reversed version order, starting after current).
      const requestMigrations = collectRequestMigrations(
        versions,
        version.value,
        requestSchemaName,
      );

      // Build the response migration chain: from latest back to this version.
      // We run migration callbacks from the latest version down to (but not including)
      // the current version.
      const responseSchemaName = getSchemaName(routeDef.responseSchema);
      const responseMigrations = collectResponseMigrations(
        versions,
        version.value,
        responseSchemaName,
      );

      const handler = createVersionedHandler(
        routeDef,
        versionedRequestSchema,
        requestMigrations,
        responseMigrations,
      );

      router[expressMethod](routeDef.path, handler);
    }

    result.set(version.value, router);
  }

  return result;
}

/**
 * Collect request migration functions that need to run to convert a request
 * from `currentVersion` to the latest version.
 *
 * We iterate from the current version forward (through newer versions),
 * collecting migration callbacks. In the version list (latest first),
 * the current version is at some index; we need migrations from versions
 * that are newer (lower index).
 *
 * Walking reversed versions (oldest first): start after current, go to end.
 */
function collectRequestMigrations(
  versions: VersionBundle,
  currentVersion: string,
  requestSchemaName: string | null,
): Array<(request: RequestInfo) => void> {
  const migrations: Array<(request: RequestInfo) => void> = [];

  // reversedVersions is oldest-first. Find current, then walk forward (toward latest).
  const idx = versions.reversedVersionValues.indexOf(currentVersion);
  if (idx === -1) return migrations;

  // Walk from the version after current toward the latest
  for (let i = idx + 1; i < versions.reversedVersions.length; i++) {
    const v = versions.reversedVersions[i];
    for (const change of v.changes) {
      if (requestSchemaName) {
        const instrs = change._alterRequestBySchemaInstructions.get(requestSchemaName);
        if (instrs) {
          for (const instr of instrs) {
            migrations.push(instr.transformer);
          }
        }
      }
    }
  }

  return migrations;
}

/**
 * Collect response migration functions that need to run to convert a response
 * from the latest version back to `currentVersion`.
 *
 * We iterate from the latest version toward the current version,
 * collecting migration callbacks for each version we pass through.
 *
 * versions.versions is latest-first. We iterate from index 0 up to (but not including)
 * the index of currentVersion.
 */
function collectResponseMigrations(
  versions: VersionBundle,
  currentVersion: string,
  responseSchemaName: string | null,
): Array<(response: ResponseInfo) => void> {
  const migrations: Array<(response: ResponseInfo) => void> = [];

  const idx = versions.versionValues.indexOf(currentVersion);
  if (idx === -1) return migrations;

  // Walk from latest (index 0) to just before currentVersion (exclusive)
  for (let i = 0; i < idx; i++) {
    const v = versions.versions[i];
    for (const change of v.changes) {
      if (responseSchemaName) {
        const instrs = change._alterResponseBySchemaInstructions.get(responseSchemaName);
        if (instrs) {
          for (const instr of instrs) {
            migrations.push(instr.transformer);
          }
        }
      }
    }
  }

  return migrations;
}

/**
 * Create an Express handler that:
 * 1. Validates the request body against the version-specific schema
 * 2. Runs request migrations to convert to latest schema shape
 * 3. Invokes the original handler
 * 4. Runs response migrations to convert back to the requested version's shape
 * 5. Sends the response
 */
function createVersionedHandler(
  routeDef: RouteDefinition,
  versionedRequestSchema: ZodTypeAny | null,
  requestMigrations: Array<(request: RequestInfo) => void>,
  responseMigrations: Array<(response: ResponseInfo) => void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      let body = req.body;

      // Validate request body against the versioned schema
      if (versionedRequestSchema && body !== undefined && body !== null) {
        const parseResult = versionedRequestSchema.safeParse(body);
        if (!parseResult.success) {
          res.status(422).json({
            detail: parseResult.error.errors,
          });
          return;
        }
        body = parseResult.data;
      }

      // Run request migrations (old version -> latest)
      if (requestMigrations.length > 0) {
        const requestInfo = new RequestInfo(
          body,
          req.headers as Record<string, string>,
          req.query as Record<string, string>,
        );
        for (const migrate of requestMigrations) {
          migrate(requestInfo);
        }
        body = requestInfo.body;
      }

      // Build a request-like object for the handler
      const handlerReq = {
        body,
        params: req.params,
        query: req.query,
        headers: req.headers,
      };

      // Call the original handler
      const result = await routeDef.handler(handlerReq);

      // Run response migrations (latest -> old version)
      if (responseMigrations.length > 0) {
        const responseInfo = new ResponseInfo(
          typeof result === "object" && result !== null
            ? JSON.parse(JSON.stringify(result))
            : result,
          200,
        );
        for (const migrate of responseMigrations) {
          migrate(responseInfo);
        }
        res.status(responseInfo.statusCode).json(responseInfo.body);
      } else {
        res.status(200).json(result);
      }
    } catch (err) {
      next(err);
    }
  };
}
