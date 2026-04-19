/**
 * `migratePayloadToVersion` — standalone helper that reshapes a head-shape
 * payload for a pinned client version by replaying the response migrations
 * (schema-based AND/OR path-based) registered between head and `targetVersion`.
 *
 * Primary use case: outbound webhook dispatch. `convertResponseToPreviousVersionFor`
 * only fires for in-flight HTTP responses; a background job dispatching
 * outbound webhooks needs to run the same migration chain against a handcrafted
 * payload before delivering it to a pinned client's registered webhook URL.
 *
 * Supports both migration forms:
 *   - Schema-based: `convertResponseToPreviousVersionFor(Schema)(fn)` — keyed
 *     by the registered `.named()` schema name, addressed via `schemaName`.
 *   - Path-based:  `convertResponseToPreviousVersionFor(path, methods)(fn)` —
 *     keyed by path + HTTP methods, addressed by passing `opts.path` (and
 *     optionally `opts.methods` to restrict to a method subset).
 *
 * Pass neither (or just `schemaName`) for the common webhook-by-schema case.
 * Pass `opts.path` when the consumer registered path-based migrations and
 * their webhook dispatch corresponds to a known route path. Passing both
 * runs both kinds in the order the in-flight dispatcher would: each
 * version's migrations fire once for the version boundary.
 */

import type { VersionBundle } from "./structure/versions.js";
import { ResponseInfo } from "./structure/data.js";
import { TsadwynStructureError } from "./exceptions.js";

export interface MigratePayloadOptions {
  /** When supplied, also apply path-based migrations keyed on this path. */
  path?: string;
  /**
   * Restrict path-based migrations to these HTTP methods. Default: apply
   * every path-based migration registered at `path` regardless of method
   * (common when the caller is dispatching webhooks and doesn't have an
   * HTTP method to gate on).
   */
  methods?: readonly string[];
}

/**
 * Reshape `payload` from the current head shape to the shape expected at
 * `targetVersion`, applying the same response migrations the framework
 * would run for an in-flight HTTP response at that version. Input is
 * deep-cloned so callers can pass a reference safely.
 *
 * Throws `TsadwynStructureError` when `targetVersion` is not in the
 * `VersionBundle`.
 */
export function migratePayloadToVersion<T = unknown>(
  schemaName: string,
  payload: T,
  targetVersion: string,
  versions: VersionBundle,
  opts: MigratePayloadOptions = {},
): T {
  const idx = versions.versionValues.indexOf(targetVersion);
  if (idx === -1) {
    throw new TsadwynStructureError(
      `migratePayloadToVersion: targetVersion "${targetVersion}" is not in the VersionBundle. ` +
        `Known versions: [${versions.versionValues.join(", ")}].`,
    );
  }

  // Deep clone so the input payload isn't mutated by transformers.
  const cloned =
    payload === null || payload === undefined
      ? payload
      : (JSON.parse(JSON.stringify(payload)) as T);

  // Target is head → no migrations need to run.
  if (idx === 0) return cloned;

  const responseInfo = new ResponseInfo(cloned, 200);
  const methodFilter = opts.methods
    ? new Set(opts.methods.map((m) => m.toUpperCase()))
    : null;

  // Walk versions newest → oldest, stopping just before the target. Each
  // iteration applies one version's migrations to the accumulating
  // payload, producing the shape at the next-older version.
  for (let i = 0; i < idx; i++) {
    const version = versions.versions[i];
    for (const change of version.changes) {
      // Schema-based: directly keyed on schemaName.
      const schemaInstrs =
        change._alterResponseBySchemaInstructions.get(schemaName);
      if (schemaInstrs) {
        for (const instr of schemaInstrs) {
          instr.transformer(responseInfo);
        }
      }

      // Path-based: fire when the caller supplied a matching `opts.path`.
      // Without `opts.path`, path-based migrations are silently skipped —
      // the caller's schemaName doesn't tell us which path the payload
      // would have come from.
      if (opts.path !== undefined) {
        const pathInstrs = change._alterResponseByPathInstructions.get(
          opts.path,
        );
        if (pathInstrs) {
          for (const instr of pathInstrs) {
            if (methodFilter) {
              let intersects = false;
              for (const m of instr.methods) {
                if (methodFilter.has(m)) {
                  intersects = true;
                  break;
                }
              }
              if (!intersects) continue;
            }
            instr.transformer(responseInfo);
          }
        }
      }
    }
  }

  return responseInfo.body as T;
}
