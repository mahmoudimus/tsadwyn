/**
 * Fixture app for CLI coverage tests that uses a named `app` export instead
 * of a default export. Also exports `routers` so the CLI's router-forwarding
 * code path is exercised.
 */
import { z } from "zod";
import {
  Cadwyn,
  Version,
  VersionBundle,
  VersionedRouter,
} from "../../src/index.js";

const Pet = z
  .object({
    id: z.string(),
    kind: z.string(),
  })
  .named("CliFixturePet");

const router = new VersionedRouter();
router.get("/pets/:id", null, Pet, async (req: any) => ({
  id: req.params.id,
  kind: "dog",
}));

export const app = new Cadwyn({
  versions: new VersionBundle(new Version("2020-01-01")),
});

// Intentionally do NOT call generateAndIncludeVersionedRouters here -- the
// CLI is expected to forward `routers` into the generator.
export const routers = [router];
