/**
 * Fixture where the module exports a bare `routers` value (not an array).
 * Exercises the CLI's non-array `routers` normalization path.
 */
import { z } from "zod";
import {
  Tsadwyn,
  Version,
  VersionBundle,
  VersionedRouter,
} from "../../src/index.js";

const Foo = z
  .object({ id: z.string() })
  .named("CliFixtureFoo");

const single = new VersionedRouter();
single.get("/foo/:id", null, Foo, async (req: any) => ({ id: req.params.id }));

export const app = new Tsadwyn({
  versions: new VersionBundle(new Version("2010-01-01")),
});

// Export a single router -- NOT wrapped in an array. The CLI should handle
// this by normalizing to [single].
export const routers = single;
