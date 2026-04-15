import { describe, it, expect } from "vitest";
import request from "supertest";
import { z } from "zod";
import {
  Tsadwyn,
  Version,
  VersionBundle,
  VersionedRouter,
  named,
} from "../src/index.js";

describe("RouteOptions.statusCode", () => {
  it("emits the configured status code on success", async () => {
    const router = new VersionedRouter();
    router.post(
      "/things",
      named(z.object({ name: z.string() }), "CreateThingReq"),
      named(z.object({ id: z.string() }), "CreateThingRes"),
      async () => ({ id: "new-thing" }),
      { statusCode: 201 },
    );

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .post("/things")
      .set("x-api-version", "2024-01-01")
      .send({ name: "hi" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: "new-thing" });
  });

  it("defaults to 200 when statusCode is omitted", async () => {
    const router = new VersionedRouter();
    router.get("/things/:id", null, null, async () => ({ id: "x" }));

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .get("/things/x")
      .set("x-api-version", "2024-01-01");

    expect(res.status).toBe(200);
  });

  it("accepts 202 for async-enqueue semantics", async () => {
    const router = new VersionedRouter();
    router.post(
      "/enqueue",
      null,
      named(z.object({ queued: z.boolean() }), "EnqueueRes"),
      async () => ({ queued: true }),
      { statusCode: 202 },
    );

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .post("/enqueue")
      .set("x-api-version", "2024-01-01");

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true });
  });
});

describe("named() helper", () => {
  it("tags a schema and returns it unchanged", async () => {
    const raw = z.object({ id: z.string() });
    const tagged = named(raw, "TaggedSchema");
    // Same instance, now registered.
    expect(tagged).toBe(raw);
    // The registered name is visible via the WeakMap registry.
    const { getSchemaName } = await import("../src/zod-extend.js");
    expect(getSchemaName(tagged)).toBe("TaggedSchema");
  });

  it("works with the .named() prototype method identically", async () => {
    const a = named(z.string(), "A");
    const b = z.string().named("B");
    const { getSchemaName } = await import("../src/zod-extend.js");
    expect(getSchemaName(a)).toBe("A");
    expect(getSchemaName(b)).toBe("B");
  });
});
