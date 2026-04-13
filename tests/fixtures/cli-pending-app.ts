/**
 * Fixture with a Tsadwyn app that has NOT yet been initialized
 * (generateAndIncludeVersionedRouters was not called at export time). Used to
 * exercise the CLI's `_pendingRouters` / `_performInitialization` fallback
 * path in both codegen and info.
 *
 * Note: a real Tsadwyn instance auto-initializes only when routers are passed,
 * so here we seed _pendingRouters manually to avoid coupling to private init
 * logic.
 */
import { z } from "zod";
import {
  Tsadwyn,
  Version,
  VersionBundle,
  VersionedRouter,
} from "../../src/index.js";

const Widget = z
  .object({
    id: z.string(),
    label: z.string(),
  })
  .named("CliFixtureWidget");

const router = new VersionedRouter();
router.get("/widgets/:id", null, Widget, async (req: any) => ({
  id: req.params.id,
  label: "w",
}));

export const app = new Tsadwyn({
  versions: new VersionBundle(new Version("2022-01-01")),
});

// Seed pending routers without finishing initialization so the CLI takes
// the `_pendingRouters` branch instead of the happy path.
(app as any)._pendingRouters = [router];
