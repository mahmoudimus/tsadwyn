/**
 * Fixture with a Tsadwyn app that has no routers at all: no default-exported
 * routers, no `routers` export, and no `_pendingRouters` to initialize. The
 * CLI should report "No versioned routers were generated." and succeed.
 */
import {
  Tsadwyn,
  Version,
  VersionBundle,
} from "../../src/index.js";

export const app = new Tsadwyn({
  versions: new VersionBundle(new Version("2024-01-01")),
});
