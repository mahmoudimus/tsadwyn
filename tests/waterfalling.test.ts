/**
 * Phase 22 — T-2200: Version waterfalling (closest-version fallback)
 *
 * When a client requests a version that doesn't exactly match any defined version,
 * waterfalling falls back to the closest version that is <= the requested date.
 * This uses binary search when apiVersionFormat is "date".
 *
 * Run: npx vitest run tests/waterfalling.test.ts
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { z } from "zod";

import {
  Tsadwyn,
  Version,
  VersionBundle,
  VersionChange,
  VersionedRouter,
  schema,
  convertResponseToPreviousVersionFor,
  ResponseInfo,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Setup: a 3-version app with distinct responses per version
// ---------------------------------------------------------------------------

function createWaterfallingApp(enableWaterfalling: boolean) {
  const ItemResource = z.object({
    id: z.string(),
    name: z.string(),
    version_marker: z.string(),
  }).named("WF_ItemResource");

  // v2024-06-01 -> v2024-11-01: version_marker changed
  class V3Change extends VersionChange {
    description = "V3 adds version_marker field";
    instructions = [
      schema(ItemResource).field("version_marker").didntExist,
    ];

    r1 = convertResponseToPreviousVersionFor(ItemResource)(
      (res: ResponseInfo) => {
        delete res.body.version_marker;
      },
    );
  }

  // v2024-01-01 -> v2024-06-01: name was called "title"
  class V2Change extends VersionChange {
    description = "Renamed title to name";
    instructions = [
      schema(ItemResource).field("name").had({ name: "title" }),
    ];

    r1 = convertResponseToPreviousVersionFor(ItemResource)(
      (res: ResponseInfo) => {
        res.body.title = res.body.name;
        delete res.body.name;
      },
    );
  }

  const router = new VersionedRouter();
  router.get("/items/:id", null, ItemResource, async (req) => {
    return { id: req.params.id, name: "Widget", version_marker: "v3" };
  });

  const options: any = {
    versions: new VersionBundle(
      new Version("2024-11-01", V3Change),
      new Version("2024-06-01", V2Change),
      new Version("2024-01-01"),
    ),
  };

  if (enableWaterfalling) {
    options.enableWaterfalling = true;
  }

  const app = new Tsadwyn(options);
  app.generateAndIncludeVersionedRouters(router);

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("version waterfalling", () => {
  it("falls back to closest older version when waterfalling is enabled", async () => {
    const app = createWaterfallingApp(true);
    const server = app.expressApp;

    // Request with version 2024-03-15 (between v1=2024-01-01 and v2=2024-06-01)
    // Should fall back to 2024-01-01 (the closest older version)
    const res = await request(server)
      .get("/items/test1")
      .set("x-api-version", "2024-03-15");

    // Should get a 200 (not 422) because waterfalling found a matching version
    expect(res.status).toBe(200);
    // Should get v1's response shape (title instead of name, no version_marker)
    expect(res.body.title).toBe("Widget");
    expect(res.body.name).toBeUndefined();
    expect(res.body.version_marker).toBeUndefined();
  });

  it("falls back to v2 for dates between v2 and v3", async () => {
    const app = createWaterfallingApp(true);
    const server = app.expressApp;

    // Request with version 2024-08-15 (between v2=2024-06-01 and v3=2024-11-01)
    // Should fall back to 2024-06-01
    const res = await request(server)
      .get("/items/test2")
      .set("x-api-version", "2024-08-15");

    expect(res.status).toBe(200);
    // v2 shape: "name" field exists but no "version_marker"
    expect(res.body.name).toBe("Widget");
    expect(res.body.version_marker).toBeUndefined();
  });

  it("uses exact match when waterfalling is enabled and version is exact", async () => {
    const app = createWaterfallingApp(true);
    const server = app.expressApp;

    // Request with an exact version should use that version directly
    const res = await request(server)
      .get("/items/test3")
      .set("x-api-version", "2024-11-01");

    expect(res.status).toBe(200);
    // v3 shape: has name and version_marker
    expect(res.body.name).toBe("Widget");
    expect(res.body.version_marker).toBe("v3");
  });

  it("returns 422 when no version is older than the requested version", async () => {
    const app = createWaterfallingApp(true);
    const server = app.expressApp;

    // Request with version 2023-01-01 (older than all defined versions)
    // There's no defined version <= 2023-01-01, so it should return 422
    const res = await request(server)
      .get("/items/test4")
      .set("x-api-version", "2023-01-01");

    expect(res.status).toBe(422);
  });

  it("is disabled by default — unknown version returns 422", async () => {
    const app = createWaterfallingApp(false);
    const server = app.expressApp;

    // Without enableWaterfalling, any version that doesn't exactly match returns 422
    const res = await request(server)
      .get("/items/test5")
      .set("x-api-version", "2024-03-15");

    expect(res.status).toBe(422);
    expect(res.body.detail).toContain("Invalid API version");
  });

  it("exact versions still work without waterfalling", async () => {
    const app = createWaterfallingApp(false);
    const server = app.expressApp;

    // Without waterfalling, exact versions should still work
    const res = await request(server)
      .get("/items/test6")
      .set("x-api-version", "2024-01-01");

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Widget");
  });

  it("falls back to latest when waterfall date is after all versions", async () => {
    const app = createWaterfallingApp(true);
    const server = app.expressApp;

    // Request with version 2025-01-01 (newer than all defined versions)
    // Should fall back to the latest (2024-11-01)
    const res = await request(server)
      .get("/items/test7")
      .set("x-api-version", "2025-01-01");

    expect(res.status).toBe(200);
    // Should get v3's response shape (name + version_marker)
    expect(res.body.name).toBe("Widget");
    expect(res.body.version_marker).toBe("v3");
  });
});
