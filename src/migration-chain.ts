/**
 * `inspectMigrationChain` — given a schema name and a client version, return
 * the ordered list of migrations that tsadwyn would run to migrate a request
 * (client → head) or response (head → client). Used by consumers debugging
 * "why is my v1 client receiving a v2-shape field?" without stepping through
 * code.
 */

import type { RouteDefinition } from "./router.js";
import type { VersionBundle } from "./structure/versions.js";
import { TsadwynStructureError } from "./exceptions.js";
import { getSchemaName } from "./zod-extend.js";

export interface InspectMigrationChainOptions {
  schemaName: string;
  clientVersion: string;
  direction: "request" | "response";
  /** Optionally scope to one path-based migration target. */
  path?: string;
  /** Paired with `path` to scope to a single method. */
  method?: string;
  /** Include migrations where migrateHttpErrors: true. Default: true. */
  includeErrorMigrations?: boolean;
}

export interface MigrationChainEntry {
  /** Version at which the VersionChange lives. */
  version: string;
  /** The class name of the VersionChange. */
  changeClassName: string;
  /** Schema-based (registered against a schema name) or path-based (registered against a path+methods). */
  kind: "schema-based" | "path-based";
  /** Method / function name (used for debugging + CLI display). */
  functionName: string;
  /** Present for schema-based entries. */
  schemaName?: string;
  /** Present for path-based entries. */
  path?: string;
  /** Present for path-based entries. */
  methods?: string[];
  /** Present for response migrations. */
  migrateHttpErrors?: boolean;
  /** Position in the resolved chain (0 = runs first). */
  order: number;
}

interface InspectApp {
  versions: VersionBundle;
  readonly _versionedRoutes?: Map<string, RouteDefinition[]>;
}

function schemaIsKnown(app: InspectApp, schemaName: string): boolean {
  const routesMap = (app as any)._versionedRoutes as
    | Map<string, RouteDefinition[]>
    | undefined;
  if (routesMap) {
    for (const routes of routesMap.values()) {
      for (const route of routes) {
        if (getSchemaName(route.requestSchema) === schemaName) return true;
        if (getSchemaName(route.responseSchema) === schemaName) return true;
      }
    }
  }
  // Also accept schemas referenced only in instruction sets.
  for (const version of app.versions.versions) {
    for (const change of version.changes) {
      if (
        change._alterResponseBySchemaInstructions.has(schemaName) ||
        change._alterRequestBySchemaInstructions.has(schemaName)
      ) {
        return true;
      }
    }
  }
  return false;
}

export function inspectMigrationChain(
  app: InspectApp,
  opts: InspectMigrationChainOptions,
): MigrationChainEntry[] {
  const {
    schemaName,
    clientVersion,
    direction,
    path,
    method,
    includeErrorMigrations = true,
  } = opts;
  const bundle = app.versions;

  if (!bundle.versionValues.includes(clientVersion)) {
    throw new TsadwynStructureError(
      `inspectMigrationChain: clientVersion "${clientVersion}" is not in the VersionBundle. ` +
        `Known versions: [${bundle.versionValues.join(", ")}].`,
    );
  }
  if (!schemaIsKnown(app, schemaName)) {
    throw new TsadwynStructureError(
      `inspectMigrationChain: schema "${schemaName}" is not registered on any route or instruction.`,
    );
  }

  const entries: MigrationChainEntry[] = [];
  const upperMethod = method?.toUpperCase();

  if (direction === "response") {
    // head → client: walk versionValues (newest-first) from index 0
    // up to (but excluding) clientVersion's index.
    const clientIdx = bundle.versionValues.indexOf(clientVersion);
    for (let i = 0; i < clientIdx; i++) {
      const v = bundle.versions[i];
      for (const change of v.changes) {
        // Schema-based
        const schemaInstrs =
          change._alterResponseBySchemaInstructions.get(schemaName);
        if (schemaInstrs) {
          for (const instr of schemaInstrs) {
            if (!includeErrorMigrations && instr.migrateHttpErrors) continue;
            entries.push({
              version: v.value,
              changeClassName: change.constructor.name,
              kind: "schema-based",
              functionName: instr.methodName,
              schemaName,
              migrateHttpErrors: instr.migrateHttpErrors,
              order: entries.length,
            });
          }
        }
        // Path-based (scoped by opts.path + opts.method)
        if (path) {
          const pathInstrs = change._alterResponseByPathInstructions.get(path);
          if (pathInstrs) {
            for (const instr of pathInstrs) {
              if (upperMethod && !instr.methods.has(upperMethod)) continue;
              if (!includeErrorMigrations && instr.migrateHttpErrors) continue;
              entries.push({
                version: v.value,
                changeClassName: change.constructor.name,
                kind: "path-based",
                functionName: instr.methodName,
                path: instr.path,
                methods: [...instr.methods],
                migrateHttpErrors: instr.migrateHttpErrors,
                order: entries.length,
              });
            }
          }
        }
      }
    }
  } else {
    // direction === 'request'. client → head: walk reversedVersions
    // (oldest-first) starting at index (reversedIdx + 1), i.e., the
    // version just newer than the client's pin, up through head.
    const reversedIdx = bundle.reversedVersionValues.indexOf(clientVersion);
    for (let i = reversedIdx + 1; i < bundle.reversedVersions.length; i++) {
      const v = bundle.reversedVersions[i];
      for (const change of v.changes) {
        // Schema-based
        const schemaInstrs =
          change._alterRequestBySchemaInstructions.get(schemaName);
        if (schemaInstrs) {
          for (const instr of schemaInstrs) {
            entries.push({
              version: v.value,
              changeClassName: change.constructor.name,
              kind: "schema-based",
              functionName: instr.methodName,
              schemaName,
              order: entries.length,
            });
          }
        }
        // Path-based
        if (path) {
          const pathInstrs = change._alterRequestByPathInstructions.get(path);
          if (pathInstrs) {
            for (const instr of pathInstrs) {
              if (upperMethod && !instr.methods.has(upperMethod)) continue;
              entries.push({
                version: v.value,
                changeClassName: change.constructor.name,
                kind: "path-based",
                functionName: instr.methodName,
                path: instr.path,
                methods: [...instr.methods],
                order: entries.length,
              });
            }
          }
        }
      }
    }
  }

  return entries;
}
