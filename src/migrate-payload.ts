/**
 * `migratePayloadToVersion` — standalone helper that reshapes a head-shape
 * payload for a pinned client version by replaying the schema-based response
 * migrations registered against `schemaName` between head and `targetVersion`.
 *
 * Primary use case: outbound webhook dispatch. `convertResponseToPreviousVersionFor`
 * only fires for in-flight HTTP responses; a background job dispatching
 * outbound webhooks needs to run the same migration chain against a handcrafted
 * payload before delivering it to a pinned client's registered webhook URL.
 */

import type { VersionBundle } from "./structure/versions.js";
import { ResponseInfo } from "./structure/data.js";
import { TsadwynStructureError } from "./exceptions.js";

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

  // Walk versions newest → oldest, stopping just before the target. Each
  // iteration applies one version's migrations to the accumulating
  // payload, producing the shape at the next-older version.
  for (let i = 0; i < idx; i++) {
    const version = versions.versions[i];
    for (const change of version.changes) {
      const instrs = change._alterResponseBySchemaInstructions.get(schemaName);
      if (!instrs) continue;
      for (const instr of instrs) {
        instr.transformer(responseInfo);
      }
    }
  }

  return responseInfo.body as T;
}
