/**
 * `simulateRoute` — answer "is tsadwyn responsible for this request, and
 * what would it do?" without dispatching. Matches the exact same route
 * table dispatch would use, explains every candidate match, surfaces the
 * migration chain that would fire, and optionally previews the up-migrated
 * request body.
 */

import type { Request } from "express";
import type { RouteDefinition } from "./router.js";
import { _DELETED_ROUTE_TAG } from "./router.js";
import type { VersionBundle } from "./structure/versions.js";
import { RequestInfo, ResponseInfo } from "./structure/data.js";
import { getSchemaName } from "./zod-extend.js";

export interface SimulateRouteOptions {
  method: string;
  path: string;
  /** Explicit version — takes precedence over headers and default. */
  version?: string;
  /** Request headers (e.g., x-api-version). */
  headers?: Record<string, string | string[] | undefined>;
  /** Optional body — enables `upMigratedBody` preview. */
  body?: unknown;
}

export interface RouteCandidate {
  method: string;
  path: string;
  matched: boolean;
  reason: string;
  regex: string;
  params?: Record<string, string>;
}

export interface MatchedRouteSummary {
  method: string;
  path: string;
  params: Record<string, string>;
  handler: string;
  schemaName: string | null;
}

export interface FallthroughSummary {
  reason: string;
  availableAtOtherVersions: string[];
  closestMisses: Array<{ method: string; path: string; diff: string }>;
}

export interface MigrationSummary {
  schemaName: string | null;
  fromVersion: string;
  toVersion: string;
  path: string;
}

export interface SimulationResult {
  resolvedVersion: string;
  matchedRoute: MatchedRouteSummary | null;
  candidates: RouteCandidate[];
  requestMigrations: MigrationSummary[];
  responseMigrations: MigrationSummary[];
  fallthrough: FallthroughSummary | null;
  upMigratedBody?: unknown;
}

interface SimulateApp {
  versions: VersionBundle;
  apiVersionHeaderName?: string;
  apiVersionDefaultValue?:
    | string
    | ((req: Request) => string | Promise<string>)
    | null;
  readonly _versionedRoutes?: Map<string, RouteDefinition[]>;
}

interface PathMatchResult {
  matched: boolean;
  params?: Record<string, string>;
  reason: string;
  regex: string;
}

/**
 * Simplified path matcher that mirrors path-to-regexp's first-match behavior
 * for the subset of patterns tsadwyn exposes: literal segments and `:param`
 * captures. Built in-house so we don't have to pin the consumer's
 * path-to-regexp version to get matching parity.
 */
function matchPath(pattern: string, input: string): PathMatchResult {
  const patternSegments = pattern.split("/").filter((s) => s.length > 0);
  const inputSegments = input.split("/").filter((s) => s.length > 0);

  // Build a pseudo-regex for introspection output.
  const regexParts = patternSegments.map((s) =>
    s.startsWith(":") ? `(?<${s.slice(1)}>[^/]+)` : s,
  );
  const regex = `^/${regexParts.join("/")}$`;

  if (patternSegments.length !== inputSegments.length) {
    const diff = inputSegments.length - patternSegments.length;
    if (diff > 0) {
      const extra = inputSegments.slice(patternSegments.length).join("/");
      return {
        matched: false,
        reason: `extra segments beyond match: /${extra}`,
        regex,
      };
    }
    const missing = patternSegments.slice(inputSegments.length).join("/");
    return {
      matched: false,
      reason: `missing segments: /${missing}`,
      regex,
    };
  }

  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegments.length; i++) {
    const p = patternSegments[i];
    const v = inputSegments[i];
    if (p.startsWith(":")) {
      params[p.slice(1)] = v;
    } else if (p !== v) {
      return {
        matched: false,
        reason: `segment ${i} mismatch: expected "${p}", got "${v}"`,
        regex,
      };
    }
  }
  return { matched: true, reason: "exact match", regex, params };
}

function closestMissDiff(pattern: string, input: string): string {
  const pSeg = pattern.split("/").filter((s) => s.length > 0);
  const iSeg = input.split("/").filter((s) => s.length > 0);
  if (pSeg.length < iSeg.length) {
    const extra = iSeg.slice(pSeg.length).join("/");
    return `one extra segment: /${extra}`;
  }
  if (pSeg.length > iSeg.length) {
    return `shorter by ${pSeg.length - iSeg.length} segment(s)`;
  }
  return "segment content differs";
}

export function simulateRoute(
  app: SimulateApp,
  opts: SimulateRouteOptions,
): SimulationResult {
  const versionedRoutes = (app as any)._versionedRoutes as
    | Map<string, RouteDefinition[]>
    | undefined;

  if (!versionedRoutes) {
    throw new Error(
      "simulateRoute: app has no _versionedRoutes — did you call generateAndIncludeVersionedRouters()?",
    );
  }

  // Resolve version: explicit > headers > apiVersionDefaultValue > head.
  const versionHeaderName = (app.apiVersionHeaderName ?? "x-api-version").toLowerCase();
  const headerValue =
    opts.headers?.[versionHeaderName] ??
    opts.headers?.[versionHeaderName.toUpperCase()];
  let resolvedVersion: string | undefined = opts.version;
  if (!resolvedVersion && typeof headerValue === "string") {
    resolvedVersion = headerValue;
  }
  if (!resolvedVersion && typeof app.apiVersionDefaultValue === "string") {
    resolvedVersion = app.apiVersionDefaultValue;
  }
  // Note: intentionally do NOT resolve async apiVersionDefaultValue here.
  // simulateRoute is synchronous so consumers can call it at any time
  // (CLI, REPL, test, debugger) without juggling Promises. When the
  // default is a function, we fall back to head — if consumers want the
  // async-resolver value they pass `version` explicitly.
  if (!resolvedVersion) {
    resolvedVersion = app.versions.versionValues[0];
  }

  const routesAtVersion =
    versionedRoutes.get(resolvedVersion) ?? [];

  const inputMethod = opts.method.toUpperCase();
  const candidates: RouteCandidate[] = [];
  let matchedRoute: MatchedRouteSummary | null = null;

  for (const route of routesAtVersion) {
    if (route.tags.includes(_DELETED_ROUTE_TAG)) continue;
    const routeMethod = route.method.toUpperCase();
    const match = matchPath(route.path, opts.path);

    const candidate: RouteCandidate = {
      method: routeMethod,
      path: route.path,
      matched: false,
      reason: "",
      regex: match.regex,
      params: match.params,
    };

    if (routeMethod !== inputMethod) {
      candidate.matched = false;
      candidate.reason = match.matched
        ? `method mismatch: expected ${routeMethod}, got ${inputMethod}`
        : `method mismatch (${routeMethod})`;
    } else if (match.matched) {
      candidate.matched = true;
      if (matchedRoute !== null) {
        // An earlier candidate already matched — this one is shadowed
        // by registration order (path-to-regexp is first-match-wins).
        candidate.reason = `shadowed by earlier match ${matchedRoute.path} (first-match-wins)`;
      } else {
        candidate.reason = "exact match";
        matchedRoute = {
          method: routeMethod,
          path: route.path,
          params: match.params ?? {},
          handler: route.funcName ?? route.handler.name ?? "<anonymous>",
          schemaName: getSchemaName(route.responseSchema) ?? null,
        };
      }
    } else {
      candidate.matched = false;
      candidate.reason = match.reason;
    }

    candidates.push(candidate);
  }

  // Compute migration chain for the matched route (if any).
  let requestMigrations: MigrationSummary[] = [];
  let responseMigrations: MigrationSummary[] = [];
  let upMigratedBody: unknown = undefined;

  if (matchedRoute) {
    const routeDef = routesAtVersion.find(
      (r) =>
        r.path === matchedRoute!.path &&
        r.method.toUpperCase() === matchedRoute!.method,
    );
    if (routeDef) {
      const reqSchemaName = getSchemaName(routeDef.requestSchema);
      const resSchemaName = getSchemaName(routeDef.responseSchema);

      // Request migrations: client → head
      const reversedIdx = app.versions.reversedVersionValues.indexOf(
        resolvedVersion,
      );
      if (reversedIdx !== -1) {
        for (
          let i = reversedIdx + 1;
          i < app.versions.reversedVersions.length;
          i++
        ) {
          const v = app.versions.reversedVersions[i];
          for (const change of v.changes) {
            if (reqSchemaName) {
              const instrs =
                change._alterRequestBySchemaInstructions.get(reqSchemaName);
              if (instrs) {
                for (const _instr of instrs) {
                  requestMigrations.push({
                    schemaName: reqSchemaName,
                    fromVersion: resolvedVersion,
                    toVersion: v.value,
                    path: matchedRoute.path,
                  });
                }
              }
            }
            const pathInstrs =
              change._alterRequestByPathInstructions.get(matchedRoute.path);
            if (pathInstrs) {
              for (const instr of pathInstrs) {
                if (instr.methods.has(matchedRoute.method)) {
                  requestMigrations.push({
                    schemaName: null,
                    fromVersion: resolvedVersion,
                    toVersion: v.value,
                    path: matchedRoute.path,
                  });
                }
              }
            }
          }
        }
      }

      // Response migrations: head → client
      const clientIdx = app.versions.versionValues.indexOf(resolvedVersion);
      if (clientIdx !== -1) {
        for (let i = 0; i < clientIdx; i++) {
          const v = app.versions.versions[i];
          for (const change of v.changes) {
            if (resSchemaName) {
              const instrs =
                change._alterResponseBySchemaInstructions.get(resSchemaName);
              if (instrs) {
                for (const _instr of instrs) {
                  responseMigrations.push({
                    schemaName: resSchemaName,
                    fromVersion: v.value,
                    toVersion: resolvedVersion,
                    path: matchedRoute.path,
                  });
                }
              }
            }
            const pathInstrs =
              change._alterResponseByPathInstructions.get(matchedRoute.path);
            if (pathInstrs) {
              for (const instr of pathInstrs) {
                if (instr.methods.has(matchedRoute.method)) {
                  responseMigrations.push({
                    schemaName: null,
                    fromVersion: v.value,
                    toVersion: resolvedVersion,
                    path: matchedRoute.path,
                  });
                }
              }
            }
          }
        }
      }

      // Up-migrate the supplied body preview.
      if (opts.body !== undefined && opts.body !== null) {
        const cloned = JSON.parse(JSON.stringify(opts.body));
        const requestInfo = new RequestInfo(cloned, {}, {}, {}, null);
        if (reversedIdx !== -1) {
          for (
            let i = reversedIdx + 1;
            i < app.versions.reversedVersions.length;
            i++
          ) {
            const v = app.versions.reversedVersions[i];
            for (const change of v.changes) {
              if (reqSchemaName) {
                const instrs =
                  change._alterRequestBySchemaInstructions.get(reqSchemaName);
                if (instrs) {
                  for (const instr of instrs) {
                    instr.transformer(requestInfo);
                  }
                }
              }
              const pathInstrs =
                change._alterRequestByPathInstructions.get(matchedRoute.path);
              if (pathInstrs) {
                for (const instr of pathInstrs) {
                  if (instr.methods.has(matchedRoute.method)) {
                    instr.transformer(requestInfo);
                  }
                }
              }
            }
          }
        }
        upMigratedBody = requestInfo.body;
      }
    }
  }

  // Fallthrough: if nothing matched, compute diagnostic info.
  let fallthrough: FallthroughSummary | null = null;
  if (!matchedRoute) {
    const availableAtOtherVersions: string[] = [];
    const closestMisses: FallthroughSummary["closestMisses"] = [];

    for (const otherVersion of app.versions.versionValues) {
      if (otherVersion === resolvedVersion) continue;
      const otherRoutes = versionedRoutes.get(otherVersion) ?? [];
      for (const route of otherRoutes) {
        if (route.tags.includes(_DELETED_ROUTE_TAG)) continue;
        if (route.method.toUpperCase() !== inputMethod) continue;
        const match = matchPath(route.path, opts.path);
        if (match.matched) {
          if (!availableAtOtherVersions.includes(otherVersion)) {
            availableAtOtherVersions.push(otherVersion);
          }
        }
      }
    }

    // Closest misses: same-method routes in the target version whose
    // path is one segment longer/shorter than the input.
    for (const route of routesAtVersion) {
      if (route.tags.includes(_DELETED_ROUTE_TAG)) continue;
      if (route.method.toUpperCase() !== inputMethod) continue;
      const diff = closestMissDiff(route.path, opts.path);
      if (diff === "one extra segment" || diff.startsWith("one extra segment")) {
        closestMisses.push({
          method: route.method.toUpperCase(),
          path: route.path,
          diff,
        });
      }
    }

    fallthrough = {
      reason: `no registered route matches ${inputMethod} ${opts.path} at version ${resolvedVersion}`,
      availableAtOtherVersions,
      closestMisses,
    };
  }

  return {
    resolvedVersion,
    matchedRoute,
    candidates,
    requestMigrations,
    responseMigrations,
    fallthrough,
    upMigratedBody,
  };
}
