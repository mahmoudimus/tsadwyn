/**
 * T-1701: Standalone response migration utility.
 *
 * Runs the response migration chain for a given schema from the latest version
 * down to a target version, outside of a request context. Useful for webhooks,
 * background jobs, and event streams.
 */

import { TsadwynError } from "./exceptions.js";
import { ResponseInfo } from "./structure/data.js";
import type { VersionBundle } from "./structure/versions.js";

/**
 * Migrate a response body from the latest version down to `targetVersion`.
 *
 * This applies all response migration callbacks (schema-based) from the latest
 * version down to `targetVersion`, in the same order that would be used during
 * a normal versioned response.
 *
 * @param body - The response body in the latest version's shape
 * @param schemaName - The registered name of the schema (as passed to `.named()`)
 * @param targetVersion - The API version to migrate down to
 * @param versionBundle - The VersionBundle containing all version definitions
 * @returns The migrated response body in the target version's shape
 */
export function migrateResponseBody(
  body: any,
  schemaName: string,
  targetVersion: string,
  versionBundle: VersionBundle,
): any {
  // Validate that the target version exists
  if (!versionBundle.versionValues.includes(targetVersion)) {
    throw new TsadwynError(
      `Version "${targetVersion}" not found in version bundle. ` +
      `Available versions: [${versionBundle.versionValues.join(", ")}]`,
    );
  }

  // Create a ResponseInfo with status 200 (standalone migration is always success)
  const responseInfo = new ResponseInfo(
    // Deep-clone to avoid mutating the caller's data
    typeof body === "object" && body !== null
      ? JSON.parse(JSON.stringify(body))
      : body,
    200,
  );

  // Walk from latest (index 0) to just before targetVersion (exclusive),
  // applying response migrations for the given schema.
  const targetIdx = versionBundle.versionValues.indexOf(targetVersion);

  for (let i = 0; i < targetIdx; i++) {
    const version = versionBundle.versions[i];
    for (const change of version.changes) {
      const instrs = change._alterResponseBySchemaInstructions.get(schemaName);
      if (instrs) {
        for (const instr of instrs) {
          // In standalone mode, status is always 200, but respect migrateHttpErrors anyway
          if (responseInfo.statusCode >= 300 && !instr.migrateHttpErrors) {
            continue;
          }
          instr.transformer(responseInfo);
        }
      }
    }
  }

  return responseInfo.body;
}
