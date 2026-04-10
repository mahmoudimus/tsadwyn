import { describe, it, expect } from "vitest";
import request from "supertest";
import { z } from "zod";
import crypto from "node:crypto";

import {
  Cadwyn,
  Version,
  VersionBundle,
  VersionChange,
  VersionedRouter,
  schema,
  convertRequestToNextVersionFor,
  convertResponseToPreviousVersionFor,
  RequestInfo,
  ResponseInfo,
} from "../src/index.js";

/**
 * Concurrent request tests.
 *
 * Verifies that AsyncLocalStorage properly isolates version context
 * when multiple requests with different version headers arrive concurrently.
 */

const ItemRequest = z
  .object({
    tags: z.array(z.string()),
  })
  .named("ConcItemRequest");

const ItemResource = z
  .object({
    id: z.string().uuid(),
    tags: z.array(z.string()),
  })
  .named("ConcItemResource");

const database: Record<string, any> = {};

class ChangeTagsToSingle extends VersionChange {
  description = "Changed tags from array to single tag string";

  instructions = [
    schema(ItemRequest).field("tags").had({ name: "tag", type: z.string() }),
    schema(ItemResource).field("tags").had({ name: "tag", type: z.string() }),
  ];

  @convertRequestToNextVersionFor(ItemRequest)
  migrateRequest(req: RequestInfo) {
    req.body.tags = [req.body.tag];
    delete req.body.tag;
  }

  @convertResponseToPreviousVersionFor(ItemResource)
  migrateResponse(res: ResponseInfo) {
    res.body.tag = res.body.tags[0];
    delete res.body.tags;
  }
}

function createConcurrencyApp() {
  for (const key of Object.keys(database)) {
    delete database[key];
  }

  const router = new VersionedRouter();

  router.post("/items", ItemRequest, ItemResource, async (req: any) => {
    // Add a small artificial delay to increase chance of interleaving
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));
    const id = crypto.randomUUID();
    database[id] = { id, tags: req.body.tags };
    return database[id];
  });

  router.get("/items/:itemId", null, ItemResource, async (req: any) => {
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));
    return database[req.params.itemId];
  });

  const app = new Cadwyn({
    versions: new VersionBundle(
      new Version("2001-01-01", ChangeTagsToSingle),
      new Version("2000-01-01"),
    ),
  });
  app.generateAndIncludeVersionedRouters(router);
  return app;
}

describe("concurrent version requests", () => {
  const app = createConcurrencyApp();

  it("handles many concurrent requests with different versions", async () => {
    const iterations = 20;
    const promises: Promise<any>[] = [];

    for (let i = 0; i < iterations; i++) {
      if (i % 2 === 0) {
        // New version: sends { tags: [...] }, expects { tags: [...] }
        promises.push(
          request(app.expressApp)
            .post("/items")
            .set("x-api-version", "2001-01-01")
            .send({ tags: [`new-${i}`] })
            .then((res) => ({
              version: "2001-01-01",
              index: i,
              status: res.status,
              body: res.body,
            })),
        );
      } else {
        // Old version: sends { tag: "..." }, expects { tag: "..." }
        promises.push(
          request(app.expressApp)
            .post("/items")
            .set("x-api-version", "2000-01-01")
            .send({ tag: `old-${i}` })
            .then((res) => ({
              version: "2000-01-01",
              index: i,
              status: res.status,
              body: res.body,
            })),
        );
      }
    }

    const results = await Promise.all(promises);

    for (const result of results) {
      expect(result.status).toBe(200);

      if (result.version === "2001-01-01") {
        // New version response should have tags array
        expect(result.body.tags).toEqual([`new-${result.index}`]);
        expect(result.body.tag).toBeUndefined();
      } else {
        // Old version response should have tag string
        expect(result.body.tag).toBe(`old-${result.index}`);
        expect(result.body.tags).toBeUndefined();
      }
    }
  });

  it("isolates version context between concurrent GET and POST requests", async () => {
    // Seed a user via new version
    const createRes = await request(app.expressApp)
      .post("/items")
      .set("x-api-version", "2001-01-01")
      .send({ tags: ["alpha", "beta"] });

    expect(createRes.status).toBe(200);
    const itemId = createRes.body.id;

    // Fire concurrent GETs with different versions
    const [newGet, oldGet] = await Promise.all([
      request(app.expressApp)
        .get(`/items/${itemId}`)
        .set("x-api-version", "2001-01-01"),
      request(app.expressApp)
        .get(`/items/${itemId}`)
        .set("x-api-version", "2000-01-01"),
    ]);

    // New version should get array
    expect(newGet.status).toBe(200);
    expect(newGet.body.tags).toEqual(["alpha", "beta"]);
    expect(newGet.body.tag).toBeUndefined();

    // Old version should get single string
    expect(oldGet.status).toBe(200);
    expect(oldGet.body.tag).toBe("alpha");
    expect(oldGet.body.tags).toBeUndefined();
  });

  it("handles a burst of requests alternating versions rapidly", async () => {
    // Stress test: 50 concurrent requests with random 0-10ms artificial delays
    // inside each handler. Bump the timeout to 15s to accommodate supertest
    // socket reuse under load.
    const count = 50;
    const promises: Promise<any>[] = [];

    for (let i = 0; i < count; i++) {
      const version = i % 3 === 0 ? "2000-01-01" : "2001-01-01";

      if (version === "2000-01-01") {
        promises.push(
          request(app.expressApp)
            .post("/items")
            .set("x-api-version", version)
            .send({ tag: `burst-old-${i}` }),
        );
      } else {
        promises.push(
          request(app.expressApp)
            .post("/items")
            .set("x-api-version", version)
            .send({ tags: [`burst-new-${i}`] }),
        );
      }
    }

    const results = await Promise.all(promises);

    for (let i = 0; i < count; i++) {
      const version = i % 3 === 0 ? "2000-01-01" : "2001-01-01";
      const res = results[i];

      expect(res.status).toBe(200);

      if (version === "2000-01-01") {
        expect(res.body.tag).toBe(`burst-old-${i}`);
        expect(res.body.tags).toBeUndefined();
      } else {
        expect(res.body.tags).toEqual([`burst-new-${i}`]);
        expect(res.body.tag).toBeUndefined();
      }
    }
  }, 15000);
});
