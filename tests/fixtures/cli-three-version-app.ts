/**
 * Three-version fixture so the CLI's `(latest)` / `(oldest)` / "" middle-tag
 * paths in renderInfoPayload are all exercised.
 */
import { z } from "zod";
import {
  Cadwyn,
  Version,
  VersionBundle,
  VersionChange,
  VersionedRouter,
  schema,
} from "../../src/index.js";

const Item = z
  .object({
    id: z.string(),
    title: z.string(),
    author: z.string(),
  })
  .named("CliFixtureItem");

const router = new VersionedRouter();
router.get("/items/:id", null, Item, async (req: any) => ({
  id: req.params.id,
  title: "t",
  author: "a",
}));

// Two independent field renames on two newer versions.
class RenameTitleToHeadline extends VersionChange {
  description = "Rename title -> headline";
  instructions = [
    schema(Item).field("title").had({ name: "headline", type: z.string() }),
  ];
}

class RenameAuthorToWriter extends VersionChange {
  description = "Rename author -> writer";
  instructions = [
    schema(Item).field("author").had({ name: "writer", type: z.string() }),
  ];
}

const app = new Cadwyn({
  versions: new VersionBundle(
    new Version("2003-01-01", RenameTitleToHeadline),
    new Version("2002-01-01", RenameAuthorToWriter),
    new Version("2001-01-01"),
  ),
});
app.generateAndIncludeVersionedRouters(router);

export default app;
