import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { ZodObject, ZodTypeAny } from "zod";
import type { RouteDefinition, VersionedRouter, MiddlewareFunction } from "./router.js";
import { cloneRouteDefinition, _DELETED_ROUTE_TAG } from "./router.js";
import type { VersionBundle, VersionChange, Version } from "./structure/versions.js";
import type {
  EndpointDidntExistInstruction,
  EndpointExistedInstruction,
  EndpointHadInstruction,
  AlterEndpointSubInstruction,
} from "./structure/endpoints.js";
import {
  RequestInfo,
  ResponseInfo,
  AlterRequestBySchemaInstruction,
  AlterResponseBySchemaInstruction,
  AlterRequestByPathInstruction,
  AlterResponseByPathInstruction,
} from "./structure/data.js";
import { ZodSchemaRegistry, generateVersionedSchemas } from "./schema-generation.js";
import {
  CadwynHeadRequestValidationError,
  RouteAlreadyExistsError,
  RouterGenerationError,
  RouterPathParamsModifiedError,
  RouteByPathConverterDoesNotApplyToAnythingError,
  RouteRequestBySchemaConverterDoesNotApplyToAnythingError,
  RouteResponseBySchemaConverterDoesNotApplyToAnythingError,
  HttpError,
} from "./exceptions.js";
import { getSchemaName } from "./zod-extend.js";
import { AlterSchemaInstructionFactory } from "./structure/schemas.js";

/**
 * Build a ZodSchemaRegistry from the route definitions AND from schemas
 * referenced in version change instructions (T-2400). This ensures schemas
 * that appear only in `alter_schema_instructions` (e.g., nested schemas not
 * directly on a route) are also registered and versioned.
 */
function buildRegistryFromRoutes(
  routes: RouteDefinition[],
  versions?: VersionBundle,
): ZodSchemaRegistry {
  const registry = new ZodSchemaRegistry();

  // Register schemas from routes
  for (const route of routes) {
    const reqName = getSchemaName(route.requestSchema);
    if (reqName) {
      registry.register(reqName, route.requestSchema!);
    }
    const resName = getSchemaName(route.responseSchema);
    if (resName) {
      registry.register(resName, route.responseSchema!);
    }
  }

  // T-2400: Register schemas referenced in version change instructions
  // but not directly on any route. Uses the static _knownSchemas map
  // populated by `schema()` calls.
  if (versions) {
    const knownSchemas = AlterSchemaInstructionFactory._knownSchemas;

    for (const version of versions.versions) {
      for (const change of version.changes) {
        for (const instr of change._alterSchemaInstructions) {
          const name = (instr as any).schemaName as string | undefined;
          if (name && !registry.has(name) && knownSchemas.has(name)) {
            registry.register(name, knownSchemas.get(name)!);
          }
        }
      }
    }

    // Also check HeadVersion changes if present
    if (versions.headVersion) {
      for (const change of versions.headVersion.changes) {
        for (const instr of change._alterSchemaInstructions) {
          const name = (instr as any).schemaName as string | undefined;
          if (name && !registry.has(name) && knownSchemas.has(name)) {
            registry.register(name, knownSchemas.get(name)!);
          }
        }
      }
    }
  }

  return registry;
}

/**
 * Collect all schema names that are used as request or response bodies in routes.
 */
function collectUsedSchemaNames(routes: RouteDefinition[]): { request: Set<string>; response: Set<string> } {
  const request = new Set<string>();
  const response = new Set<string>();

  for (const route of routes) {
    const reqName = getSchemaName(route.requestSchema);
    if (reqName) request.add(reqName);
    const resName = getSchemaName(route.responseSchema);
    if (resName) response.add(resName);
  }

  return { request, response };
}

/**
 * T-402: Validate that schemas mentioned in migration decorators are actually used.
 * Throws an error if checkUsage is true and the schema isn't found in any route.
 */
function validateSchemaUsage(versions: VersionBundle, routes: RouteDefinition[]): void {
  const used = collectUsedSchemaNames(routes);

  for (const version of versions.versions) {
    for (const change of version.changes) {
      // Check request by schema instructions
      for (const [schemaName, instrs] of change._alterRequestBySchemaInstructions) {
        for (const instr of instrs) {
          if (instr.checkUsage && !used.request.has(schemaName)) {
            throw new RouteRequestBySchemaConverterDoesNotApplyToAnythingError(
              `Request migration for schema "${schemaName}" (method "${instr.methodName}") ` +
              `does not apply to any route. The schema is not used as a request body in any registered route. ` +
              `Set checkUsage: false to suppress this error.`,
            );
          }
        }
      }

      // Check response by schema instructions
      for (const [schemaName, instrs] of change._alterResponseBySchemaInstructions) {
        for (const instr of instrs) {
          if (instr.checkUsage && !used.response.has(schemaName)) {
            throw new RouteResponseBySchemaConverterDoesNotApplyToAnythingError(
              `Response migration for schema "${schemaName}" (method "${instr.methodName}") ` +
              `does not apply to any route. The schema is not used as a response body in any registered route. ` +
              `Set checkUsage: false to suppress this error.`,
            );
          }
        }
      }
    }
  }
}

/**
 * T-1604: Validate that path-based converters reference paths and methods that actually exist in routes.
 */
function validatePathConverterUsage(versions: VersionBundle, routes: RouteDefinition[]): void {
  // Build a set of "path|METHOD" for quick lookup
  const routePathMethods = new Set<string>();
  for (const route of routes) {
    const normalizedPath = route.path.replace(/\/+$/, "");
    routePathMethods.add(`${normalizedPath}|${route.method.toUpperCase()}`);
  }

  for (const version of versions.versions) {
    for (const change of version.changes) {
      // Check _alterRequestByPathInstructions
      for (const [path, instrs] of change._alterRequestByPathInstructions) {
        for (const instr of instrs) {
          const normalizedPath = path.replace(/\/+$/, "");
          const missingMethods: string[] = [];
          for (const method of instr.methods) {
            if (!routePathMethods.has(`${normalizedPath}|${method}`)) {
              missingMethods.push(method);
            }
          }
          if (missingMethods.length === instr.methods.size) {
            throw new RouteByPathConverterDoesNotApplyToAnythingError(
              `Request path converter "${instr.methodName}" ` +
              `failed to find routes with path "${path}" and methods [${[...instr.methods].join(", ")}]. ` +
              "This means that you are trying to apply this converter to non-existing endpoint(s). " +
              "Please, check whether the path and methods are correct.",
            );
          }
        }
      }

      // Check _alterResponseByPathInstructions
      for (const [path, instrs] of change._alterResponseByPathInstructions) {
        for (const instr of instrs) {
          const normalizedPath = path.replace(/\/+$/, "");
          const missingMethods: string[] = [];
          for (const method of instr.methods) {
            if (!routePathMethods.has(`${normalizedPath}|${method}`)) {
              missingMethods.push(method);
            }
          }
          if (missingMethods.length === instr.methods.size) {
            throw new RouteByPathConverterDoesNotApplyToAnythingError(
              `Response path converter "${instr.methodName}" ` +
              `failed to find routes with path "${path}" and methods [${[...instr.methods].join(", ")}]. ` +
              "This means that you are trying to apply this converter to non-existing endpoint(s). " +
              "Please, check whether the path and methods are correct.",
            );
          }
        }
      }
    }
  }
}

/**
 * A migration callback plus its migrateHttpErrors flag (for response migrations).
 */
interface ResponseMigration {
  transformer: (response: ResponseInfo) => void;
  migrateHttpErrors: boolean;
}

/**
 * A request migration callback.
 */
interface RequestMigration {
  transformer: (request: RequestInfo) => void;
}

/**
 * Extract path parameters from an Express-style path (e.g. "/users/:id" -> ["id"]).
 */
function extractPathParams(path: string): string[] {
  const params: string[] = [];
  const regex = /:([^/]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(path)) !== null) {
    params.push(match[1]);
  }
  return params;
}

/**
 * Find routes matching a given path, methods, optional funcName, and deleted state.
 */
function getRoutes(
  routes: RouteDefinition[],
  endpointPath: string,
  endpointMethods: string[],
  funcName: string | null,
  isDeleted: boolean,
): RouteDefinition[] {
  const normalizedPath = endpointPath.replace(/\/+$/, "");
  const methodSet = new Set(endpointMethods.map((m) => m.toUpperCase()));

  return routes.filter((route) => {
    const routePath = route.path.replace(/\/+$/, "");
    const routeMethod = route.method.toUpperCase();
    const routeIsDeleted = route.tags.includes(_DELETED_ROUTE_TAG);

    return (
      routePath === normalizedPath &&
      methodSet.has(routeMethod) &&
      (funcName === null || route.funcName === funcName) &&
      routeIsDeleted === isDeleted
    );
  });
}

/**
 * Apply endpoint changes from a version's VersionChanges to a set of route definitions.
 * This modifies routes in-place (marking as deleted, restoring, changing attributes).
 */
function applyEndpointChangesToRoutes(
  routes: RouteDefinition[],
  version: Version,
  routesThatNeverExisted: RouteDefinition[],
): void {
  for (const change of version.changes) {
    for (const instruction of change._alterEndpointInstructions) {
      const originalRoutes = getRoutes(
        routes,
        instruction.path,
        instruction.methods,
        instruction.funcName,
        false,
      );

      if (instruction.kind === "endpoint_didnt_exist") {
        const deletedRoutes = getRoutes(
          routes,
          instruction.path,
          instruction.methods,
          instruction.funcName,
          true,
        );
        if (deletedRoutes.length > 0) {
          throw new RouterGenerationError(
            `Endpoint "[${instruction.methods.join(", ")}] ${instruction.path}" you tried to delete ` +
            `was already deleted in a newer version. If you really have two routes with the same ` +
            `paths and methods, please use endpoint(..., funcName) to distinguish between them.`,
          );
        }
        if (originalRoutes.length === 0) {
          throw new RouterGenerationError(
            `Endpoint "[${instruction.methods.join(", ")}] ${instruction.path}" you tried to delete ` +
            `doesn't exist in a newer version.`,
          );
        }
        for (const route of originalRoutes) {
          route.tags.push(_DELETED_ROUTE_TAG);
        }
      } else if (instruction.kind === "endpoint_existed") {
        if (originalRoutes.length > 0) {
          throw new RouterGenerationError(
            `Endpoint "[${instruction.methods.join(", ")}] ${instruction.path}" you tried to restore ` +
            `already existed in a newer version. If you really have two routes with the same ` +
            `paths and methods, please use endpoint(..., funcName) to distinguish between them.`,
          );
        }
        const deletedRoutes = getRoutes(
          routes,
          instruction.path,
          instruction.methods,
          instruction.funcName,
          true,
        );
        if (deletedRoutes.length === 0) {
          throw new RouterGenerationError(
            `Endpoint "[${instruction.methods.join(", ")}] ${instruction.path}" you tried to restore ` +
            `wasn't among the deleted routes.`,
          );
        }
        // T-1605: If multiple deleted routes match and no funcName was specified, throw ambiguity error
        if (deletedRoutes.length > 1 && instruction.funcName === null) {
          throw new RouteAlreadyExistsError(
            ...deletedRoutes.map((r) => `${r.method} ${r.path} [${r.funcName || "(anonymous)"}]`),
          );
        }
        for (const deletedRoute of deletedRoutes) {
          const tagIdx = deletedRoute.tags.indexOf(_DELETED_ROUTE_TAG);
          if (tagIdx !== -1) {
            deletedRoute.tags.splice(tagIdx, 1);
          }
          const neverExistedIdx = routesThatNeverExisted.findIndex(
            (r) =>
              r.path.replace(/\/+$/, "") === deletedRoute.path.replace(/\/+$/, "") &&
              r.method.toUpperCase() === deletedRoute.method.toUpperCase(),
          );
          if (neverExistedIdx !== -1) {
            routesThatNeverExisted.splice(neverExistedIdx, 1);
          }
        }
      } else if (instruction.kind === "endpoint_had") {
        if (originalRoutes.length === 0) {
          throw new RouterGenerationError(
            `Endpoint "[${instruction.methods.join(", ")}] ${instruction.path}" you tried to change ` +
            `doesn't exist.`,
          );
        }
        for (const route of originalRoutes) {
          applyEndpointHadInstruction(instruction, route);
        }
      }
    }
  }
}

/**
 * Apply a single EndpointHadInstruction to a route definition.
 * T-1603: Detects no-op changes where all attribute values already match the route.
 * T-2204: When apiVersionLocation is "path", strip version path params from comparison.
 */
function applyEndpointHadInstruction(
  instruction: EndpointHadInstruction,
  route: RouteDefinition,
  apiVersionLocation?: string,
  versionValues?: string[],
): void {
  const attrs = instruction.attributes;

  // T-1603: Check if every specified attribute is already the same value (no-op).
  let allNoOps = true;
  let hasAnyAttr = false;
  if (attrs.path !== undefined) {
    hasAnyAttr = true;
    if (attrs.path !== route.path) allNoOps = false;
  }
  if (attrs.methods !== undefined) {
    hasAnyAttr = true;
    const newMethod = attrs.methods[0]?.toUpperCase() ?? route.method;
    if (newMethod !== route.method) allNoOps = false;
  }
  if (attrs.statusCode !== undefined) {
    hasAnyAttr = true;
    if (attrs.statusCode !== route.statusCode) allNoOps = false;
  }
  if (attrs.deprecated !== undefined) {
    hasAnyAttr = true;
    if (attrs.deprecated !== route.deprecated) allNoOps = false;
  }
  if (attrs.summary !== undefined) {
    hasAnyAttr = true;
    if (attrs.summary !== route.summary) allNoOps = false;
  }
  if (attrs.description !== undefined) {
    hasAnyAttr = true;
    if (attrs.description !== route.description) allNoOps = false;
  }
  if (attrs.tags !== undefined) {
    hasAnyAttr = true;
    const currentUserTags = route.tags.filter((t) => !t.startsWith("_TSADWYN"));
    const tagsMatch = currentUserTags.length === attrs.tags.length &&
      currentUserTags.every((t, i) => t === attrs.tags![i]);
    if (!tagsMatch) allNoOps = false;
  }
  if (attrs.operationId !== undefined) {
    hasAnyAttr = true;
    if (attrs.operationId !== route.operationId) allNoOps = false;
  }
  if (attrs.includeInSchema !== undefined) {
    hasAnyAttr = true;
    if (attrs.includeInSchema !== route.includeInSchema) allNoOps = false;
  }
  if (attrs.responses !== undefined) {
    hasAnyAttr = true;
    if (JSON.stringify(attrs.responses) !== JSON.stringify(route.responses)) allNoOps = false;
  }
  if (attrs.callbacks !== undefined) {
    hasAnyAttr = true;
    if (JSON.stringify(attrs.callbacks) !== JSON.stringify(route.callbacks)) allNoOps = false;
  }

  if (hasAnyAttr && allNoOps) {
    throw new RouterGenerationError(
      `Endpoint "[${instruction.methods.join(", ")}] ${route.path}" version change has no effect. ` +
      "All specified attributes already match the current route values. " +
      "This means your version change is a no-op and can be removed.",
    );
  }

  if (attrs.path !== undefined) {
    let originalParams = extractPathParams(route.path).sort();
    let newParams = extractPathParams(attrs.path).sort();

    // T-2204: When apiVersionLocation is "path", exclude any path parameter
    // whose value matches a known version value from the comparison.
    if (apiVersionLocation === "path" && versionValues && versionValues.length > 0) {
      const versionSet = new Set(versionValues);
      originalParams = originalParams.filter((p) => !versionSet.has(p));
      newParams = newParams.filter((p) => !versionSet.has(p));
    }

    if (
      originalParams.length !== newParams.length ||
      !originalParams.every((p, i) => p === newParams[i])
    ) {
      throw new RouterPathParamsModifiedError(
        `When altering the path of "[${instruction.methods.join(", ")}] ${route.path}", ` +
        `you have tried to change its path params from [${originalParams.join(", ")}] ` +
        `to [${newParams.join(", ")}]. It is not allowed to change the path params of a route ` +
        `because the endpoint was created to handle the old path params.`,
      );
    }
    route.path = attrs.path;
  }
  if (attrs.methods !== undefined) {
    route.method = attrs.methods[0]?.toUpperCase() ?? route.method;
  }
  if (attrs.statusCode !== undefined) {
    route.statusCode = attrs.statusCode;
  }
  if (attrs.deprecated !== undefined) {
    route.deprecated = attrs.deprecated;
  }
  if (attrs.summary !== undefined) {
    route.summary = attrs.summary;
  }
  if (attrs.description !== undefined) {
    route.description = attrs.description;
  }
  if (attrs.tags !== undefined) {
    const internalTags = route.tags.filter((t) => t.startsWith("_TSADWYN"));
    route.tags = [...internalTags, ...attrs.tags];
  }
  if (attrs.operationId !== undefined) {
    route.operationId = attrs.operationId;
  }
  if (attrs.includeInSchema !== undefined) {
    route.includeInSchema = attrs.includeInSchema;
  }
  if (attrs.responses !== undefined) {
    route.responses = attrs.responses;
  }
  if (attrs.callbacks !== undefined) {
    route.callbacks = attrs.callbacks;
  }
}

/**
 * Generate versioned Express routers from a VersionedRouter and VersionBundle.
 *
 * For each version, this:
 * 1. Creates versioned copies of Zod schemas with field alterations applied.
 * 2. Applies endpoint instructions (didntExist, existed, had) to routes.
 * 3. Creates an Express Router with routes that use version-specific validation.
 * 4. Wires up request migration (old version -> latest) and response migration
 *    (latest -> old version) callbacks.
 *
 * Returns a Map of version string -> Express Router.
 */
/**
 * Result of generating versioned routers, including per-version route snapshots.
 */
export interface VersionedRouterResult {
  routers: Map<string, Router>;
  /** Per-version route definitions (after endpoint changes have been applied). */
  versionedRoutes: Map<string, RouteDefinition[]>;
  /** Per-version webhook route definitions (documentation-only, not Express endpoints). */
  versionedWebhookRoutes: Map<string, RouteDefinition[]>;
}

export function generateVersionedRouters(
  versionedRouter: VersionedRouter,
  versions: VersionBundle,
  dependencyOverrides?: Map<Function, Function>,
  /**
   * Webhook routes to include in the versioning pipeline. They participate in
   * schema generation and endpoint lifecycle (didntExist/existed/had) but are
   * NOT mounted as Express endpoints. Per-version webhook route snapshots are
   * returned in `versionedWebhookRoutes`.
   */
  webhookRoutes?: RouteDefinition[],
): VersionedRouterResult {
  // Combine regular + webhook routes for validation and schema discovery
  const allRoutes = webhookRoutes
    ? [...versionedRouter.routes, ...webhookRoutes]
    : versionedRouter.routes;

  // T-402: Validate schema usage against all routes (regular + webhook)
  validateSchemaUsage(versions, allRoutes);

  // T-1604: Validate path-based converter usage against all routes
  validatePathConverterUsage(versions, allRoutes);

  const baseRegistry = buildRegistryFromRoutes(allRoutes, versions);
  const versionedSchemas = generateVersionedSchemas(versions, baseRegistry);
  const result = new Map<string, Router>();
  const versionedRoutes = new Map<string, RouteDefinition[]>();
  const versionedWebhookRoutes = new Map<string, RouteDefinition[]>();

  // Track routes marked with onlyExistsInOlderVersions that must be restored
  const routesThatNeverExisted: RouteDefinition[] = versionedRouter.routes
    .filter((r) => r.tags.includes(_DELETED_ROUTE_TAG))
    .map((r) => cloneRouteDefinition(r));

  // Keep track of which paths are webhook-only (not mounted as Express endpoints)
  const webhookPaths = new Set(
    (webhookRoutes ?? []).map((r) => `${r.method.toUpperCase()}:${r.path.replace(/^\/+/, "")}`),
  );

  // Start with a copy of regular + webhook routes combined (endpoint instructions apply to both)
  const combinedRoutes = [...versionedRouter.routes, ...(webhookRoutes ?? [])];
  let currentRoutes = combinedRoutes.map((r) => cloneRouteDefinition(r));

  for (const version of versions.versions) {
    const router = Router();
    const registry = versionedSchemas.get(version.value);

    // Mount only non-deleted, non-webhook routes for this version
    for (const routeDef of currentRoutes) {
      if (routeDef.tags.includes(_DELETED_ROUTE_TAG)) {
        continue; // Skip deleted routes
      }
      // Skip webhook routes — they're documentation-only, not Express endpoints
      const routeKey = `${routeDef.method.toUpperCase()}:${routeDef.path.replace(/^\/+/, "")}`;
      if (webhookPaths.has(routeKey)) {
        continue;
      }
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
      const requestMigrations = collectRequestMigrations(
        versions,
        version.value,
        requestSchemaName,
        routeDef.path,
        routeDef.method,
      );

      // Build the response migration chain: from latest back to this version.
      const responseSchemaName = getSchemaName(routeDef.responseSchema);
      const responseMigrations = collectResponseMigrations(
        versions,
        version.value,
        responseSchemaName,
        routeDef.path,
        routeDef.method,
      );

      // T-406: The head (latest) request schema for re-validation after migration
      const headRequestSchema = routeDef.requestSchema;

      // T-601: Determine versioned query schema
      const rawQuerySchema = routeDef.querySchema ?? null;
      const querySchemaName = getSchemaName(rawQuerySchema);
      let versionedQuerySchema: ZodTypeAny | null = null;
      if (querySchemaName && registry?.has(querySchemaName)) {
        versionedQuerySchema = registry.get(querySchemaName)!.schema;
      } else {
        versionedQuerySchema = rawQuerySchema;
      }

      const handler = createVersionedHandler(
        routeDef,
        versionedRequestSchema,
        requestMigrations,
        responseMigrations,
        headRequestSchema,
        version.value,
        dependencyOverrides,
        versionedQuerySchema,
      );

      // T-602: Collect middleware (router-level + route-level)
      const routerMw = versionedRouter.routerMiddleware ?? [];
      const routeMw = routeDef.middleware ?? [];
      const allMiddleware: MiddlewareFunction[] = [
        ...routerMw,
        ...routeMw,
      ];

      if (allMiddleware.length > 0) {
        router[expressMethod](routeDef.path, ...allMiddleware, handler);
      } else {
        router[expressMethod](routeDef.path, handler);
      }
    }

    result.set(version.value, router);
    // Snapshot the current routes for this version, split into regular and webhook
    const regularSnapshot: RouteDefinition[] = [];
    const webhookSnapshot: RouteDefinition[] = [];
    for (const r of currentRoutes) {
      const rKey = `${r.method.toUpperCase()}:${r.path.replace(/^\/+/, "")}`;
      if (webhookPaths.has(rKey)) {
        webhookSnapshot.push(cloneRouteDefinition(r));
      } else {
        regularSnapshot.push(cloneRouteDefinition(r));
      }
    }
    versionedRoutes.set(version.value, regularSnapshot);
    versionedWebhookRoutes.set(version.value, webhookSnapshot);

    // Apply endpoint changes for this version to produce routes for the next-older version
    const nextRoutes = currentRoutes.map((r) => cloneRouteDefinition(r));
    applyEndpointChangesToRoutes(nextRoutes, version, routesThatNeverExisted);
    currentRoutes = nextRoutes;
  }

  // After all versions: check that all onlyExistsInOlderVersions routes were restored
  if (routesThatNeverExisted.length > 0) {
    const descriptions = routesThatNeverExisted.map(
      (r) => `${r.method} ${r.path}`,
    );
    throw new RouterGenerationError(
      "Every route you mark with onlyExistsInOlderVersions must be restored " +
      "in one of the older versions. Otherwise you just need to delete it altogether. " +
      `The following routes were never restored: [${descriptions.join(", ")}]`,
    );
  }

  return { routers: result, versionedRoutes, versionedWebhookRoutes };
}

/**
 * Collect request migration functions that need to run to convert a request
 * from `currentVersion` to the latest version.
 *
 * Includes both schema-based and path-based migrations.
 */
function collectRequestMigrations(
  versions: VersionBundle,
  currentVersion: string,
  requestSchemaName: string | null,
  routePath: string,
  routeMethod: string,
): RequestMigration[] {
  const migrations: RequestMigration[] = [];

  const idx = versions.reversedVersionValues.indexOf(currentVersion);
  if (idx === -1) return migrations;

  const upperMethod = routeMethod.toUpperCase();

  // Walk from the version after current toward the latest
  for (let i = idx + 1; i < versions.reversedVersions.length; i++) {
    const v = versions.reversedVersions[i];
    for (const change of v.changes) {
      // Schema-based migrations
      if (requestSchemaName) {
        const instrs = change._alterRequestBySchemaInstructions.get(requestSchemaName);
        if (instrs) {
          for (const instr of instrs) {
            migrations.push({ transformer: instr.transformer });
          }
        }
      }

      // T-400: Path-based migrations
      const pathInstrs = change._alterRequestByPathInstructions.get(routePath);
      if (pathInstrs) {
        for (const instr of pathInstrs) {
          if (instr.methods.has(upperMethod)) {
            migrations.push({ transformer: instr.transformer });
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
 * Includes both schema-based and path-based migrations.
 */
function collectResponseMigrations(
  versions: VersionBundle,
  currentVersion: string,
  responseSchemaName: string | null,
  routePath: string,
  routeMethod: string,
): ResponseMigration[] {
  const migrations: ResponseMigration[] = [];

  const idx = versions.versionValues.indexOf(currentVersion);
  if (idx === -1) return migrations;

  const upperMethod = routeMethod.toUpperCase();

  // Walk from latest (index 0) to just before currentVersion (exclusive)
  for (let i = 0; i < idx; i++) {
    const v = versions.versions[i];
    for (const change of v.changes) {
      // Schema-based migrations
      if (responseSchemaName) {
        const instrs = change._alterResponseBySchemaInstructions.get(responseSchemaName);
        if (instrs) {
          for (const instr of instrs) {
            migrations.push({
              transformer: instr.transformer,
              migrateHttpErrors: instr.migrateHttpErrors,
            });
          }
        }
      }

      // T-400: Path-based migrations
      const pathInstrs = change._alterResponseByPathInstructions.get(routePath);
      if (pathInstrs) {
        for (const instr of pathInstrs) {
          if (instr.methods.has(upperMethod)) {
            migrations.push({
              transformer: instr.transformer,
              migrateHttpErrors: instr.migrateHttpErrors,
            });
          }
        }
      }
    }
  }

  return migrations;
}

/**
 * Parse cookies from the Cookie header string.
 */
function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  const pairs = cookieHeader.split(";");
  for (const pair of pairs) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) continue;
    const name = pair.substring(0, eqIdx).trim();
    const value = pair.substring(eqIdx + 1).trim();
    if (name) cookies[name] = value;
  }
  return cookies;
}

/**
 * Detect if the request content-type is form data.
 */
function isFormContentType(contentType: string | undefined): "multipart" | "urlencoded" | false {
  if (!contentType) return false;
  if (contentType.includes("multipart/form-data")) return "multipart";
  if (contentType.includes("application/x-www-form-urlencoded")) return "urlencoded";
  return false;
}

/**
 * T-605: Check if a value is a non-JSON response that should be sent as-is.
 * Returns true for Buffer, ReadableStream, or when content-type is not JSON.
 */
function isNonJsonResponse(result: any): boolean {
  if (result === null || result === undefined) return false;
  if (Buffer.isBuffer(result)) return true;
  // Check for ReadableStream / Node.js Readable
  if (typeof result.pipe === "function") return true;
  return false;
}

/**
 * T-605: Send a non-JSON response appropriately.
 */
function sendNonJsonResponse(res: Response, result: any, statusCode: number): void {
  if (Buffer.isBuffer(result)) {
    res.status(statusCode);
    if (!res.getHeader("content-type")) {
      res.setHeader("content-type", "application/octet-stream");
    }
    res.setHeader("content-length", result.length.toString());
    res.end(result);
  } else if (typeof result.pipe === "function") {
    // ReadableStream / Node.js Readable
    res.status(statusCode);
    if (!res.getHeader("content-type")) {
      res.setHeader("content-type", "application/octet-stream");
    }
    result.pipe(res);
  } else if (typeof result === "string") {
    res.status(statusCode);
    if (!res.getHeader("content-type")) {
      res.setHeader("content-type", "text/plain");
    }
    const bodyBuf = Buffer.from(result, "utf-8");
    res.setHeader("content-length", bodyBuf.length.toString());
    res.end(result);
  }
}

/**
 * Create an Express handler that:
 * 1. T-600: Validates path parameters against paramsSchema
 * 2. T-601: Validates query parameters against querySchema
 * 3. Validates the request body against the version-specific schema
 * 4. Runs request migrations to convert to latest schema shape
 * 5. Re-validates migrated body against head schema (T-406)
 * 6. Invokes the original handler
 * 7. T-605: Handles non-JSON responses
 * 8. Runs response migrations to convert back to the requested version's shape
 * 9. T-606: Recalculates content-length after response migration
 * 10. Sends the response
 */
function createVersionedHandler(
  routeDef: RouteDefinition,
  versionedRequestSchema: ZodTypeAny | null,
  requestMigrations: RequestMigration[],
  responseMigrations: ResponseMigration[],
  headRequestSchema: ZodTypeAny | null,
  currentVersion: string,
  dependencyOverrides?: Map<Function, Function>,
  versionedQuerySchema?: ZodTypeAny | null,
): (req: Request, res: Response, next: NextFunction) => void {
  const successStatus = routeDef.statusCode ?? 200;

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // T-600: Validate path parameters
      if (routeDef.paramsSchema) {
        const paramsResult = routeDef.paramsSchema.safeParse(req.params);
        if (!paramsResult.success) {
          res.status(422).json({
            detail: paramsResult.error.errors,
          });
          return;
        }
        // Apply parsed params back (handles coercion)
        Object.assign(req.params, paramsResult.data);
      }

      // T-601: Validate query parameters
      const activeQuerySchema = versionedQuerySchema ?? routeDef.querySchema;
      if (activeQuerySchema) {
        const queryResult = activeQuerySchema.safeParse(req.query);
        if (!queryResult.success) {
          res.status(422).json({
            detail: queryResult.error.errors,
          });
          return;
        }
        // Apply parsed query back
        for (const [key, value] of Object.entries(queryResult.data as Record<string, any>)) {
          (req.query as any)[key] = value;
        }
      }

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
        // T-404: Detect and handle form data
        const contentType = req.headers["content-type"];
        const formType = isFormContentType(contentType);
        let form: Array<[string, string | File]> | null = null;

        if (formType === "urlencoded" && body && typeof body === "object") {
          form = Object.entries(body).map(([k, v]) => [k, String(v)] as [string, string]);
        } else if (formType === "multipart") {
          // T-1902: Parse multipart/form-data using multer's memory storage.
          // Note: file upload handling differs from Cadwyn's Starlette-based approach.
          // Starlette integrates multipart parsing natively, while here we rely on
          // multer's middleware. We run multer inline (as a promise) so that parsed
          // fields/files are available before request migrations execute.
          await new Promise<void>((resolve, reject) => {
            const upload = multer({ storage: multer.memoryStorage() });
            upload.any()(req, res, (err?: any) => {
              if (err) return reject(err);
              resolve();
            });
          });

          // Populate form with parsed fields
          form = [];
          if (req.body && typeof req.body === "object") {
            for (const [k, v] of Object.entries(req.body)) {
              form.push([k, String(v)] as [string, string]);
            }
          }
          // Include files as entries too (filename as the string value)
          if ((req as any).files && Array.isArray((req as any).files)) {
            for (const file of (req as any).files as Express.Multer.File[]) {
              form.push([file.fieldname, file.originalname] as [string, string]);
            }
          }
          body = req.body;
        }

        // T-405: Parse cookies from request
        const cookies = parseCookies(req.headers.cookie);

        const requestInfo = new RequestInfo(
          body,
          req.headers as Record<string, string>,
          req.query as Record<string, string>,
          cookies,
          form,
        );
        for (const migration of requestMigrations) {
          migration.transformer(requestInfo);
        }
        body = requestInfo.body;

        // T-405: Apply header changes back to the Express request
        for (const [key, value] of Object.entries(requestInfo.headers)) {
          req.headers[key.toLowerCase()] = value;
        }

        // T-405: Apply query param changes back
        for (const [key, value] of Object.entries(requestInfo.queryParams)) {
          (req.query as any)[key] = value;
        }

        // T-405: Apply cookie changes back (rebuild the cookie header)
        if (Object.keys(requestInfo.cookies).length > 0 || req.headers.cookie) {
          const cookieParts: string[] = [];
          for (const [name, value] of Object.entries(requestInfo.cookies)) {
            cookieParts.push(`${name}=${value}`);
          }
          req.headers.cookie = cookieParts.join("; ");
        }

        // T-406: Re-validate migrated body against head (latest) schema
        if (headRequestSchema && body !== undefined && body !== null) {
          const headParseResult = headRequestSchema.safeParse(body);
          if (!headParseResult.success) {
            throw new CadwynHeadRequestValidationError(
              headParseResult.error.errors,
              body,
              currentVersion,
            );
          }
          body = headParseResult.data;
        }
      }

      // Build a request-like object for the handler
      const handlerReq = {
        body,
        params: req.params,
        query: req.query,
        headers: req.headers,
      };

      // Call the handler (check dependency overrides first)
      const effectiveHandler = dependencyOverrides?.get(routeDef.handler) as
        | typeof routeDef.handler
        | undefined;
      const activeHandler = effectiveHandler || routeDef.handler;
      const result = await activeHandler(handlerReq);

      // T-605: Handle non-JSON responses
      if (isNonJsonResponse(result)) {
        sendNonJsonResponse(res, result, successStatus);
        return;
      }

      // T-605: Handle plain string responses
      if (typeof result === "string") {
        // Check if response migrations need to run on this
        if (responseMigrations.length === 0) {
          sendNonJsonResponse(res, result, successStatus);
          return;
        }
        // If there are migrations and it looks like JSON, try to parse and migrate
        try {
          const parsed = JSON.parse(result);
          // Falls through to JSON handling below with parsed body
          const responseBody = parsed;
          const responseInfo = new ResponseInfo(responseBody, successStatus);
          for (const migration of responseMigrations) {
            if (responseInfo.statusCode >= 300 && !migration.migrateHttpErrors) {
              continue;
            }
            migration.transformer(responseInfo);
          }
          _applyResponseInfoToExpressResponse(res, responseInfo);
          // T-606: Recalculate content-length
          const jsonBody = JSON.stringify(responseInfo.body);
          const bodyBuffer = Buffer.from(jsonBody, "utf-8");
          res.setHeader("content-length", bodyBuffer.length.toString());
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.status(responseInfo.statusCode).end(jsonBody);
          return;
        } catch {
          // Not JSON - send as string
          sendNonJsonResponse(res, result, successStatus);
          return;
        }
      }

      // T-403: Handle array and object response bodies - deep clone to avoid mutation
      const responseBody =
        typeof result === "object" && result !== null
          ? JSON.parse(JSON.stringify(result))
          : result;

      // Run response migrations (latest -> old version)
      if (responseMigrations.length > 0) {
        const responseInfo = new ResponseInfo(
          responseBody,
          successStatus,
        );
        for (const migration of responseMigrations) {
          // T-401: Skip response migration if status >= 300 and migrateHttpErrors is false
          if (responseInfo.statusCode >= 300 && !migration.migrateHttpErrors) {
            continue;
          }
          migration.transformer(responseInfo);
        }

        _applyResponseInfoToExpressResponse(res, responseInfo);

        // T-606: Recalculate content-length after response migration
        const jsonBody = JSON.stringify(responseInfo.body);
        const bodyBuffer = Buffer.from(jsonBody, "utf-8");
        res.setHeader("content-length", bodyBuffer.length.toString());
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.status(responseInfo.statusCode).end(jsonBody);
      } else {
        res.status(successStatus).json(result);
      }
    } catch (err) {
      // T-1900: Intercept HttpError (or error-like objects with statusCode) and
      // run response migrations with migrateHttpErrors=true before sending the
      // error response. This mirrors Cadwyn's HTTPException interception.
      if (_isHttpLikeError(err)) {
        const httpErr = err as { statusCode: number; body?: any; message?: string; headers?: Record<string, string> };
        const errStatusCode = httpErr.statusCode;
        const errBody = httpErr.body !== undefined
          ? httpErr.body
          : { detail: httpErr.message ?? "Internal Server Error" };
        const errHeaders = httpErr.headers ?? {};

        // Build a ResponseInfo from the error
        const responseInfo = new ResponseInfo(
          typeof errBody === "object" && errBody !== null
            ? JSON.parse(JSON.stringify(errBody))
            : errBody,
          errStatusCode,
        );

        // Run only response migrations that have migrateHttpErrors: true
        for (const migration of responseMigrations) {
          if (!migration.migrateHttpErrors) {
            continue;
          }
          migration.transformer(responseInfo);
        }

        // Apply headers from the original error
        for (const [key, value] of Object.entries(errHeaders)) {
          res.setHeader(key, value);
        }

        // Apply any headers/cookies set by response migrations
        _applyResponseInfoToExpressResponse(res, responseInfo);

        // Send the migrated error response
        const jsonBody = JSON.stringify(responseInfo.body);
        const bodyBuffer = Buffer.from(jsonBody, "utf-8");
        res.setHeader("content-length", bodyBuffer.length.toString());
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.status(responseInfo.statusCode).end(jsonBody);
        return;
      }

      // Non-HTTP errors continue to the Express error handler
      next(err);
    }
  };
}

/**
 * T-1900: Detect whether an error is an HTTP-like error that should be intercepted.
 * Returns true for HttpError instances or objects with a numeric statusCode in 300-599.
 */
function _isHttpLikeError(err: unknown): boolean {
  if (err instanceof HttpError) return true;
  if (
    err !== null &&
    typeof err === "object" &&
    "statusCode" in err &&
    typeof (err as any).statusCode === "number"
  ) {
    const code = (err as any).statusCode;
    return code >= 300 && code < 600;
  }
  return false;
}

/**
 * Apply ResponseInfo headers and cookies to an Express Response.
 */
function _applyResponseInfoToExpressResponse(res: Response, responseInfo: ResponseInfo): void {
  // T-405: Apply response header changes to Express response
  for (const [key, value] of Object.entries(responseInfo.headers)) {
    res.setHeader(key, value);
  }

  // T-405: Apply set/delete cookie changes
  for (const cookieRecord of responseInfo._cookiesToSet) {
    const opts: any = {};
    if (cookieRecord.options) {
      if (cookieRecord.options.domain) opts.domain = cookieRecord.options.domain;
      if (cookieRecord.options.path) opts.path = cookieRecord.options.path;
      if (cookieRecord.options.maxAge !== undefined) opts.maxAge = cookieRecord.options.maxAge;
      if (cookieRecord.options.httpOnly !== undefined) opts.httpOnly = cookieRecord.options.httpOnly;
      if (cookieRecord.options.secure !== undefined) opts.secure = cookieRecord.options.secure;
      if (cookieRecord.options.sameSite) opts.sameSite = cookieRecord.options.sameSite;
      if (cookieRecord.options.expires) opts.expires = cookieRecord.options.expires;
    }
    res.cookie(cookieRecord.name, cookieRecord.value, opts);
  }
  for (const cookieRecord of responseInfo._cookiesToDelete) {
    const opts: any = {};
    if (cookieRecord.options) {
      if (cookieRecord.options.domain) opts.domain = cookieRecord.options.domain;
      if (cookieRecord.options.path) opts.path = cookieRecord.options.path;
    }
    res.clearCookie(cookieRecord.name, opts);
  }
}
