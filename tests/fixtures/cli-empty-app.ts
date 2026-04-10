/**
 * Fixture with a Cadwyn app that has no routers at all: no default-exported
 * routers, no `routers` export, and no `_pendingRouters` to initialize. The
 * CLI should report "No versioned routers were generated." and succeed.
 */
import {
  Cadwyn,
  Version,
  VersionBundle,
} from "../../src/index.js";

export const app = new Cadwyn({
  versions: new VersionBundle(new Version("2024-01-01")),
});
