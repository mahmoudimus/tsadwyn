/**
 * Route-shadowing detector.
 *
 * path-to-regexp (Express's routing library) is FIRST-MATCH-WINS. Registering
 * `GET /users/:id` before `GET /users/search` silently routes `/search` to
 * the `:id` handler, producing mystery 400s ("search is not a UUID") far
 * from the actual root cause. Production consumers hit this bug once per
 * real-world app.
 *
 * This module scans a flat `RouteDefinition[]` list in registration order
 * and detects cases where an earlier wildcard/parameterized path would
 * catch a later literal path on the same method. Reports one diagnostic
 * per shadow pair so the user can either reorder the registration or
 * acknowledge the intent (e.g., via `'silent'` mode).
 *
 * Detection strategy:
 *   - Build a "matcher" regex from each path pattern by replacing `:param`
 *     and `*` segments with wildcard fragments.
 *   - For each fully-literal later route, check whether any earlier route's
 *     matcher regex matches the literal path (same method).
 *   - Parameterized later routes are skipped: two overlapping wildcards
 *     are either a legit duplicate (Express will error) or both shadow
 *     each other ambiguously, which isn't the production bug pattern.
 *
 * This is a heuristic, not a full path-to-regexp reimplementation. It
 * catches the common case. When a consumer wants CI enforcement they can
 * set `onRouteShadowing: 'throw'`.
 */

import type { RouteDefinition } from "./router.js";
import { TsadwynStructureError } from "./exceptions.js";

export type RouteShadowingPolicy = "warn" | "throw" | "silent";

export interface RouteShadowingLogger {
  warn: (ctx: Record<string, unknown>, msg: string) => void;
}

export interface RouteShadow {
  /** The earlier-registered path that catches the later literal. */
  shadower: { method: string; path: string };
  /** The later-registered literal path that gets caught. */
  shadowed: { method: string; path: string };
}

/**
 * Walk `routes` in registration order and return every shadow pair.
 * Complexity: O(n²) per method. Routes with non-literal paths (wildcards,
 * params) are only considered as potential shadowers, not shadowees —
 * detecting overlapping-wildcard shadows requires a different heuristic
 * and is out of scope.
 */
export function detectRouteShadows(
  routes: ReadonlyArray<RouteDefinition>,
): RouteShadow[] {
  const shadows: RouteShadow[] = [];
  // Group routes by method preserving registration order.
  const byMethod = new Map<string, RouteDefinition[]>();
  for (const route of routes) {
    const method = route.method.toUpperCase();
    const bucket = byMethod.get(method) ?? [];
    bucket.push(route);
    byMethod.set(method, bucket);
  }

  for (const [method, bucket] of byMethod) {
    for (let i = 0; i < bucket.length; i++) {
      const later = bucket[i];
      if (isLiteralPath(later.path) === false) continue; // skip wildcard later-routes
      for (let j = 0; j < i; j++) {
        const earlier = bucket[j];
        if (isLiteralPath(earlier.path)) {
          // Both literal — either different paths (no shadow) or the exact
          // same path (Express errors on duplicate — not our problem here).
          continue;
        }
        if (matchesPath(earlier.path, later.path)) {
          shadows.push({
            shadower: { method, path: earlier.path },
            shadowed: { method, path: later.path },
          });
        }
      }
    }
  }

  return shadows;
}

/**
 * Apply the configured policy to the detected shadows. Separate from
 * detection so callers can log, throw, or format errors themselves.
 */
export function reportRouteShadows(
  shadows: ReadonlyArray<RouteShadow>,
  policy: RouteShadowingPolicy,
  logger?: RouteShadowingLogger,
): void {
  if (shadows.length === 0 || policy === "silent") return;

  const messages = shadows.map(
    (s) =>
      `${s.shadower.method} ${s.shadower.path} (registered earlier) shadows ` +
      `${s.shadowed.method} ${s.shadowed.path}. Reorder: register the literal ` +
      `path BEFORE the parameterized one.`,
  );

  if (policy === "throw") {
    throw new TsadwynStructureError(
      `Route shadowing detected:\n  - ${messages.join("\n  - ")}`,
    );
  }

  // warn — emit one log line per shadow so each is greppable.
  const out = logger?.warn ?? defaultWarnLogger;
  for (let i = 0; i < shadows.length; i++) {
    out(
      {
        shadower: shadows[i].shadower,
        shadowed: shadows[i].shadowed,
      },
      messages[i],
    );
  }
}

function defaultWarnLogger(
  ctx: Record<string, unknown>,
  msg: string,
): void {
  // Structured-first: keep the message + context both accessible at a
  // glance even when the consumer hasn't supplied a logger.
  // eslint-disable-next-line no-console
  console.warn(`[tsadwyn:route-shadowing] ${msg}`, ctx);
}

/**
 * A path is "literal" if it contains no path-to-regexp wildcard markers.
 * Anything with `:param`, `*`, or `(...)` regex groups is considered a
 * pattern, not a literal.
 */
function isLiteralPath(path: string): boolean {
  return !/[:*()\\]/.test(path);
}

/**
 * Build a matcher regex from a path-to-regexp pattern and test it against
 * a concrete literal path. Supports the subset of patterns tsadwyn users
 * actually write: `:param`, `:param(\\d+)`, `*`, and `(...)` groups.
 */
function matchesPath(pattern: string, literal: string): boolean {
  const regex = patternToRegex(pattern);
  return regex.test(literal);
}

function patternToRegex(pattern: string): RegExp {
  // Escape regex metacharacters OTHER than the ones we'll substitute for.
  // Strategy: walk the pattern and emit regex fragments.
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === ":") {
      // Param segment. Read the name, then optionally a `(...)` regex group.
      i++;
      while (i < pattern.length && /[A-Za-z0-9_]/.test(pattern[i])) i++;
      if (pattern[i] === "(") {
        // Capture the grouped regex and use it as the segment matcher.
        let depth = 1;
        i++;
        let inner = "";
        while (i < pattern.length && depth > 0) {
          if (pattern[i] === "(") depth++;
          else if (pattern[i] === ")") {
            depth--;
            if (depth === 0) break;
          }
          inner += pattern[i];
          i++;
        }
        i++; // skip closing )
        // Be conservative — treat user regex groups as `[^/]+` matchers so
        // an overly-restrictive user regex doesn't cause us to MISS a
        // shadow. Detection favors false-positive-warn over missed shadows.
        void inner;
        out += "[^/]+";
      } else {
        out += "[^/]+";
      }
      continue;
    }
    if (ch === "*") {
      // Match rest of path — one or more segments.
      out += ".*";
      i++;
      continue;
    }
    // Regex metacharacter escape.
    if (/[.+?^${}()|[\]\\]/.test(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
    i++;
  }
  return new RegExp("^" + out + "$");
}
