/**
 * Fixture app for CLI coverage tests.
 *
 * Exports a default Tsadwyn instance with two versions and one versioned
 * schema migration so the `codegen` and `info` CLI commands have something
 * real to report on.
 */
import { z } from "zod";
import {
  Tsadwyn,
  Version,
  VersionBundle,
  VersionChange,
  VersionedRouter,
  schema,
} from "../../src/index.js";

const Thing = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .named("CliFixtureThing");

const router = new VersionedRouter();
router.get("/things/:id", null, Thing, async (req: any) => ({
  id: req.params.id,
  name: "example",
}));
router.post("/things", Thing, Thing, async (req: any) => req.body);

class RenameThingName extends VersionChange {
  description = "Rename name -> label on Thing";
  instructions = [
    schema(Thing).field("name").had({ name: "label", type: z.string() }),
  ];
}

const app = new Tsadwyn({
  versions: new VersionBundle(
    new Version("2001-01-01", RenameThingName),
    new Version("2000-01-01"),
  ),
});
app.generateAndIncludeVersionedRouters(router);

export default app;
