/**
 * Pending-app fixture dedicated to runInfo tests -- mirrors cli-pending-app
 * but avoids the codegen test shared-module issue (codegen's flow consumes
 * `_pendingRouters` by calling `_performInitialization`, which would leave
 * the app fully initialized by the time runInfo runs against the same
 * module-cached instance).
 */
import { z } from "zod";
import {
  Tsadwyn,
  Version,
  VersionBundle,
  VersionedRouter,
} from "../../src/index.js";

const Gadget = z
  .object({
    id: z.string(),
    code: z.string(),
  })
  .named("CliFixturePendingInfoGadget");

const router = new VersionedRouter();
router.get("/gadgets/:id", null, Gadget, async (req: any) => ({
  id: req.params.id,
  code: "g",
}));

export const app = new Tsadwyn({
  versions: new VersionBundle(new Version("2023-06-01")),
});

(app as any)._pendingRouters = [router];
