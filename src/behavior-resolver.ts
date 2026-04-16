/**
 * `buildBehaviorResolver` — standardize the per-version behavior-map fallback
 * that every tsadwyn adopter rolls by hand. Closes the "consumer writes the
 * same 3-line function" gap identified in production.
 */

import { apiVersionStorage } from "./middleware.js";

export interface BuildBehaviorResolverOptions {
  /**
   * Telemetry policy for unknown-version lookups. Default: 'silent'.
   * - 'silent'     — never warn.
   * - 'warn-once'  — warn exactly once per unique unknown version string.
   * - 'warn-every' — warn on every unknown lookup.
   */
  onUnknown?: "silent" | "warn-once" | "warn-every";
  /** Optional structured logger. Required if `onUnknown !== 'silent'`. */
  logger?: {
    warn: (ctx: Record<string, unknown>, msg: string) => void;
  };
}

/**
 * Build a resolver that returns the per-version behavior for the current
 * request, falling back to `fallback` when the version is unknown or absent.
 *
 * The resolver reads the version from `apiVersionStorage`, so it MUST be
 * called inside a request scope (inside `versionPickingMiddleware.run()`).
 * When no version is in storage (e.g., unversioned paths), `fallback` is
 * returned silently regardless of `onUnknown` — absence is not an error.
 */
export function buildBehaviorResolver<B>(
  map: ReadonlyMap<string, B>,
  fallback: B,
  opts: BuildBehaviorResolverOptions = {},
): () => B {
  const onUnknown = opts.onUnknown ?? "silent";
  const logger = opts.logger;
  const warned = new Set<string>();
  // Snapshot the supported list once for warning context. Callers that add
  // entries to the map after construction will see a stale list — documented.
  const supportedVersions = [...map.keys()];

  return function resolve(): B {
    const version = apiVersionStorage.getStore();
    if (version === null || version === undefined) {
      return fallback;
    }
    if (map.has(version)) {
      return map.get(version)!;
    }
    if (onUnknown !== "silent" && logger) {
      const shouldWarn =
        onUnknown === "warn-every" ||
        (onUnknown === "warn-once" && !warned.has(version));
      if (shouldWarn) {
        if (onUnknown === "warn-once") warned.add(version);
        logger.warn(
          { version, supportedVersions },
          `Unknown API version "${version}"; using fallback behavior.`,
        );
      }
    }
    return fallback;
  };
}
