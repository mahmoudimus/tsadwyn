/**
 * Fixture with a real runtime response migration so
 * `tsadwyn migrations` + inspectMigrationChain have something
 * non-empty to report.
 */
import { z } from "zod";
import {
  Tsadwyn,
  Version,
  VersionBundle,
  VersionChange,
  VersionedRouter,
  convertResponseToPreviousVersionFor,
  ResponseInfo,
} from "../../src/index.js";

const Thing = z
  .object({ id: z.string(), name: z.string() })
  .named("CliMigrationsFixture_Thing");

const router = new VersionedRouter();
router.get("/things/:id", null, Thing, async (req: any) => ({
  id: req.params.id,
  name: "example",
}));

class RenameThingNameToTitle extends VersionChange {
  description =
    "Initial version used `name`; 2001 renames to `title` and this " +
    "migration maps it back for initial-version clients.";
  instructions = [];

  r1 = convertResponseToPreviousVersionFor(Thing)((res: ResponseInfo) => {
    if (res.body && typeof res.body === "object" && res.body.title !== undefined) {
      res.body.name = res.body.title;
      delete res.body.title;
    }
  });
}

const app = new Tsadwyn({
  versions: new VersionBundle(
    new Version("2001-01-01", RenameThingNameToTitle),
    new Version("2000-01-01"),
  ),
});
app.generateAndIncludeVersionedRouters(router);

export default app;
