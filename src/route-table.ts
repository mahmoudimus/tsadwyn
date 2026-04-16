/**
 * `dumpRouteTable` — enumerate registered routes per version for debugging,
 * code review, and OpenAPI audit. Complements the `tsadwyn routes` CLI
 * subcommand.
 */

import type { RouteDefinition } from "./router.js";
import { _DELETED_ROUTE_TAG } from "./router.js";
import { getSchemaName } from "./zod-extend.js";

export interface DumpRouteTableOptions {
  /** Restrict output to one version. Default: all versions. */
  version?: string;
  /** Filter by HTTP method (case-insensitive). */
  method?: string;
  /** Filter by path — regex or substring. */
  pathMatches?: RegExp | string;
  /** Include routes with includeInSchema: false. Default: false. */
  includePrivate?: boolean;
}

export interface RouteTableEntry {
  version: string;
  method: string;
  path: string;
  handlerName: string | null;
  requestSchemaName: string | null;
  responseSchemaName: string | null;
  statusCode: number;
  deprecated: boolean;
  includeInSchema: boolean;
  tags: string[];
  middleware: string[];
}

/**
 * Minimal duck-type the helper needs from a Tsadwyn-like instance. Kept
 * loose so CLI callers and tests can mock without pulling a full Tsadwyn
 * import chain.
 */
interface DumpRouteTableApp {
  versions: { versionValues: readonly string[] };
  // Private on Tsadwyn but exposed via the getter; accessed through `as any`.
  readonly _versionedRoutes?: Map<string, RouteDefinition[]>;
}

function pathMatchesFilter(
  path: string,
  filter: RegExp | string | undefined,
): boolean {
  if (filter === undefined) return true;
  if (typeof filter === "string") return path.includes(filter);
  return filter.test(path);
}

function entryFromRoute(route: RouteDefinition, version: string): RouteTableEntry {
  return {
    version,
    method: route.method.toUpperCase(),
    path: route.path,
    handlerName: route.funcName ?? route.handler.name ?? null,
    requestSchemaName: getSchemaName(route.requestSchema) ?? null,
    responseSchemaName: getSchemaName(route.responseSchema) ?? null,
    statusCode: route.statusCode,
    deprecated: route.deprecated,
    includeInSchema: route.includeInSchema,
    tags: route.tags.filter((t) => !t.startsWith("_TSADWYN")),
    middleware: (route.middleware ?? []).map(
      (mw) => (mw as any).name || "<anonymous>",
    ),
  };
}

/**
 * Enumerate registered routes across versions. Returns a flat array with one
 * entry per route-per-version. Each entry carries its origin version on
 * `entry.version` so callers that want a per-version breakdown can `filter`.
 */
export function dumpRouteTable(
  app: DumpRouteTableApp,
  opts: DumpRouteTableOptions = {},
): RouteTableEntry[] {
  const versionedRoutes = (app as any)._versionedRoutes as
    | Map<string, RouteDefinition[]>
    | undefined;

  if (!versionedRoutes) {
    throw new Error(
      "dumpRouteTable: app has no _versionedRoutes — did you call generateAndIncludeVersionedRouters()?",
    );
  }

  const targetVersions = opts.version
    ? [opts.version]
    : [...app.versions.versionValues];

  const methodFilter = opts.method?.toUpperCase();
  const entries: RouteTableEntry[] = [];

  for (const version of targetVersions) {
    const routes = versionedRoutes.get(version);
    if (!routes) continue;
    for (const route of routes) {
      if (route.tags.includes(_DELETED_ROUTE_TAG)) continue;
      if (!opts.includePrivate && route.includeInSchema === false) continue;
      const routeMethod = route.method.toUpperCase();
      if (methodFilter && routeMethod !== methodFilter) continue;
      if (!pathMatchesFilter(route.path, opts.pathMatches)) continue;
      entries.push(entryFromRoute(route, version));
    }
  }

  return entries;
}
