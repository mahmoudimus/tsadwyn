/**
 * Fully duck-typed "app" that implements the minimal surface the CLI needs
 * without being a real Tsadwyn instance. Exercises defensive fallbacks in the
 * CLI for apps where `_versionedRouters` contains entries whose routers
 * have no `.stack` property, and where version objects are missing
 * `_alterSchemaInstructions` / `changes` entirely.
 */
export const app = {
  generateAndIncludeVersionedRouters: () => {
    // no-op
  },
  versions: {
    versionValues: ["duck-version-a", "duck-version-b"],
    versions: [
      // A version object with no `changes` property at all -- exercises the
      // `version.changes ?? []` default.
      {},
      // A version object with a `changes` entry that has no
      // `_alterSchemaInstructions` property -- exercises that default too.
      {
        changes: [
          {
            /* no _alterSchemaInstructions */
          },
          // And one with an instructions array where one entry has a
          // non-string schemaName (exercises the typeof guard).
          {
            _alterSchemaInstructions: [{ schemaName: 42 }, { schemaName: "DuckSchema" }],
          },
        ],
      },
    ],
  },
  _versionedRouters: new Map<string, any>([
    // One entry with no `.stack` so runInfo reports `routeCount: null` and
    // the "unknown" render branch in renderInfoPayload is exercised.
    ["duck-version-a", { note: "router without stack" }],
    // Second entry is a real-ish router with a stack.
    ["duck-version-b", { stack: [{ route: {} }, { route: {} }] }],
  ]),
};
