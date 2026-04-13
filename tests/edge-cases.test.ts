import { describe, it, expect } from "vitest";
import request from "supertest";
import { z } from "zod";
import crypto from "node:crypto";

import {
  Tsadwyn,
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
 * Edge case tests for tsadwyn.
 */

// --- Helpers: unique schemas for each test group ---

function createSimpleApp(
  ChangeClasses: Array<new () => VersionChange>,
  routerSetup: (router: VersionedRouter) => void,
) {
  const router = new VersionedRouter();
  routerSetup(router);

  const versionList: Version[] = [new Version("2000-01-01")];
  for (let i = 0; i < ChangeClasses.length; i++) {
    versionList.push(new Version(`${2001 + i}-01-01`, ChangeClasses[i]));
  }
  versionList.reverse();

  const app = new Tsadwyn({
    versions: new VersionBundle(...versionList),
  });
  app.generateAndIncludeVersionedRouters(router);
  return app;
}

// ----- Missing / Invalid version header -----

describe("missing version header", () => {
  const ThingResource = z
    .object({ id: z.string(), value: z.string() })
    .named("MissingHdrThingResource");

  const app = createSimpleApp([], (router) => {
    router.get("/things", null, ThingResource, async () => {
      return { id: "1", value: "hello" };
    });
  });

  it("defaults to latest version when no header is present", async () => {
    const res = await request(app.expressApp).get("/things");
    // No version header: should use latest (only) version and succeed
    expect(res.status).toBe(200);
    expect(res.body.value).toBe("hello");
  });
});

describe("invalid version header", () => {
  const ThingResource = z
    .object({ id: z.string(), value: z.string() })
    .named("InvalidHdrThingResource");

  const app = createSimpleApp([], (router) => {
    router.get("/things", null, ThingResource, async () => {
      return { id: "1", value: "hello" };
    });
  });

  it("returns 422 for an unknown version string", async () => {
    const res = await request(app.expressApp)
      .get("/things")
      .set("x-api-version", "9999-99-99");

    expect(res.status).toBe(422);
    expect(res.body.detail).toContain("Invalid API version");
  });

  it("returns 422 for a malformed version string", async () => {
    const res = await request(app.expressApp)
      .get("/things")
      .set("x-api-version", "not-a-version");

    expect(res.status).toBe(422);
    expect(res.body.detail).toContain("Invalid API version");
  });
});

// ----- Empty, null, and array request bodies -----

describe("empty and null request bodies", () => {
  const EmptyReqSchema = z.object({ name: z.string() }).named("EmptyBodyReq");
  const EmptyResSchema = z
    .object({ id: z.string(), name: z.string() })
    .named("EmptyBodyRes");

  class ChangeNameToTitle extends VersionChange {
    description = "Renamed name to title";
    instructions = [
      schema(EmptyReqSchema).field("name").had({ name: "title", type: z.string() }),
      schema(EmptyResSchema).field("name").had({ name: "title", type: z.string() }),
    ];

    @convertRequestToNextVersionFor(EmptyReqSchema)
    migrateReq(req: RequestInfo) {
      req.body.name = req.body.title;
      delete req.body.title;
    }

    @convertResponseToPreviousVersionFor(EmptyResSchema)
    migrateRes(res: ResponseInfo) {
      res.body.title = res.body.name;
      delete res.body.name;
    }
  }

  const app = createSimpleApp([ChangeNameToTitle], (router) => {
    router.post("/items", EmptyReqSchema, EmptyResSchema, async (req: any) => {
      return { id: "1", name: req.body.name };
    });
  });

  it("handles empty request body gracefully", async () => {
    const res = await request(app.expressApp)
      .post("/items")
      .set("x-api-version", "2001-01-01")
      .send({});

    // Empty body should fail schema validation (name is required)
    expect(res.status).toBe(422);
  });

  it("handles request with no Content-Type", async () => {
    const res = await request(app.expressApp)
      .post("/items")
      .set("x-api-version", "2001-01-01");

    // No body at all - should not crash
    expect([200, 422]).toContain(res.status);
  });
});

describe("array request body", () => {
  // The route expects an array of strings
  const ArrayReqSchema = z.array(z.string()).named("ArrayBodyReq");
  const ArrayResSchema = z
    .object({ count: z.number(), items: z.array(z.string()) })
    .named("ArrayBodyRes");

  const app = createSimpleApp([], (router) => {
    router.post("/batch", ArrayReqSchema, ArrayResSchema, async (req: any) => {
      return { count: req.body.length, items: req.body };
    });
  });

  it("handles array request body", async () => {
    const res = await request(app.expressApp)
      .post("/batch")
      .set("x-api-version", "2000-01-01")
      .send(["a", "b", "c"]);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.items).toEqual(["a", "b", "c"]);
  });
});

describe("array response body", () => {
  const app = createSimpleApp([], (router) => {
    router.get("/list", null, null, async () => {
      return [{ id: "1" }, { id: "2" }];
    });
  });

  it("handles array response body", async () => {
    const res = await request(app.expressApp)
      .get("/list")
      .set("x-api-version", "2000-01-01");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: "1" }, { id: "2" }]);
  });
});

// ----- Nested schema migration -----

describe("nested schema migration", () => {
  const AddressSchema = z.object({
    street: z.string(),
    city: z.string(),
  });

  const NestedReq = z
    .object({
      name: z.string(),
      address: AddressSchema,
    })
    .named("NestedMigReq");

  const NestedRes = z
    .object({
      id: z.string(),
      name: z.string(),
      address: AddressSchema,
    })
    .named("NestedMigRes");

  class AddZipCodeToAddress extends VersionChange {
    description = "Address gained a zip code in the latest version (but old version lacked it)";

    instructions = [
      // In old version, address was just street+city (no zip)
      // But since we can't alter nested objects via schema instructions directly,
      // we handle this via request/response migrations
    ];

    @convertRequestToNextVersionFor(NestedReq)
    migrateReq(req: RequestInfo) {
      // Old version didn't send zip; fill default
      if (req.body.address && !req.body.address.zip) {
        req.body.address.zip = "00000";
      }
    }

    @convertResponseToPreviousVersionFor(NestedRes)
    migrateRes(res: ResponseInfo) {
      // Strip zip from response for old version
      if (res.body.address) {
        delete res.body.address.zip;
      }
    }
  }

  const app = createSimpleApp([AddZipCodeToAddress], (router) => {
    router.post("/places", NestedReq, NestedRes, async (req: any) => {
      return {
        id: "place-1",
        name: req.body.name,
        address: req.body.address,
      };
    });
  });

  it("migrates nested objects in request body", async () => {
    const res = await request(app.expressApp)
      .post("/places")
      .set("x-api-version", "2000-01-01")
      .send({
        name: "Office",
        address: { street: "123 Main", city: "Springfield" },
      });

    expect(res.status).toBe(200);
    // Old version response should not have zip
    expect(res.body.address.zip).toBeUndefined();
  });

  it("latest version passes through as-is", async () => {
    const res = await request(app.expressApp)
      .post("/places")
      .set("x-api-version", "2001-01-01")
      .send({
        name: "Office",
        address: { street: "123 Main", city: "Springfield" },
      });

    expect(res.status).toBe(200);
    // Latest version keeps the address as handler returned it
    expect(res.body.name).toBe("Office");
  });
});

// ----- Route with no request schema (GET with query params) -----

describe("route with no request schema", () => {
  const SearchRes = z
    .object({
      results: z.array(z.string()),
      query: z.string(),
    })
    .named("SearchRes");

  const app = createSimpleApp([], (router) => {
    router.get("/search", null, SearchRes, async (req: any) => {
      const q = req.query.q || "";
      return { results: [`result for ${q}`], query: q };
    });
  });

  it("handles GET with no request schema (uses query params)", async () => {
    const res = await request(app.expressApp)
      .get("/search?q=hello")
      .set("x-api-version", "2000-01-01");

    expect(res.status).toBe(200);
    expect(res.body.query).toBe("hello");
    expect(res.body.results).toEqual(["result for hello"]);
  });
});

// ----- Route with no response schema -----

describe("route with no response schema", () => {
  const DeleteReq = z.object({ confirm: z.boolean() }).named("DeleteReq");

  const app = createSimpleApp([], (router) => {
    router.post("/delete-action", DeleteReq, null, async (req: any) => {
      return { deleted: true };
    });
  });

  it("handles route with no response schema", async () => {
    const res = await request(app.expressApp)
      .post("/delete-action")
      .set("x-api-version", "2000-01-01")
      .send({ confirm: true });

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });
});

// ----- Version change with no instructions -----

describe("version change with no instructions (empty)", () => {
  class EmptyChange extends VersionChange {
    description = "A version bump with no schema or endpoint changes";
    instructions = [];
  }

  const SimpleRes = z.object({ ok: z.boolean() }).named("EmptyChangeRes");

  const app = createSimpleApp([EmptyChange], (router) => {
    router.get("/health", null, SimpleRes, async () => {
      return { ok: true };
    });
  });

  it("works with an empty version change", async () => {
    // Both versions should return the same thing
    const res1 = await request(app.expressApp)
      .get("/health")
      .set("x-api-version", "2001-01-01");
    expect(res1.status).toBe(200);
    expect(res1.body.ok).toBe(true);

    const res2 = await request(app.expressApp)
      .get("/health")
      .set("x-api-version", "2000-01-01");
    expect(res2.status).toBe(200);
    expect(res2.body.ok).toBe(true);
  });
});

// ----- Multiple schema changes in one version change -----

describe("multiple schema changes in one version change", () => {
  const MultiReq = z
    .object({
      email: z.string().email(),
      age: z.number(),
    })
    .named("MultiSchemaReq");

  const MultiRes = z
    .object({
      id: z.string(),
      email: z.string().email(),
      age: z.number(),
    })
    .named("MultiSchemaRes");

  class MultipleFieldChanges extends VersionChange {
    description = "Both email and age fields changed in this version";

    instructions = [
      schema(MultiReq).field("email").had({ name: "mail", type: z.string() }),
      schema(MultiReq).field("age").had({ type: z.string() }),
      schema(MultiRes).field("email").had({ name: "mail", type: z.string() }),
      schema(MultiRes).field("age").had({ type: z.string() }),
    ];

    @convertRequestToNextVersionFor(MultiReq)
    migrateReq(req: RequestInfo) {
      req.body.email = req.body.mail;
      delete req.body.mail;
      req.body.age = parseInt(req.body.age, 10);
    }

    @convertResponseToPreviousVersionFor(MultiRes)
    migrateRes(res: ResponseInfo) {
      res.body.mail = res.body.email;
      delete res.body.email;
      res.body.age = String(res.body.age);
    }
  }

  const app = createSimpleApp([MultipleFieldChanges], (router) => {
    router.post("/people", MultiReq, MultiRes, async (req: any) => {
      return { id: "p1", email: req.body.email, age: req.body.age };
    });
  });

  it("handles multiple field changes in a single version change (old version)", async () => {
    const res = await request(app.expressApp)
      .post("/people")
      .set("x-api-version", "2000-01-01")
      .send({ mail: "test@example.com", age: "25" });

    expect(res.status).toBe(200);
    expect(res.body.mail).toBe("test@example.com");
    expect(res.body.age).toBe("25");
    expect(res.body.email).toBeUndefined();
  });

  it("handles multiple field changes in a single version change (new version)", async () => {
    const res = await request(app.expressApp)
      .post("/people")
      .set("x-api-version", "2001-01-01")
      .send({ email: "test@example.com", age: 25 });

    expect(res.status).toBe(200);
    expect(res.body.email).toBe("test@example.com");
    expect(res.body.age).toBe(25);
    expect(res.body.mail).toBeUndefined();
  });
});

// ----- Request validation with various invalid inputs -----

describe("request validation edge cases", () => {
  const StrictReq = z
    .object({
      name: z.string().min(1),
      count: z.number().int().min(0),
    })
    .named("StrictReq");

  const StrictRes = z
    .object({ name: z.string(), count: z.number() })
    .named("StrictRes");

  const app = createSimpleApp([], (router) => {
    router.post("/strict", StrictReq, StrictRes, async (req: any) => {
      return { name: req.body.name, count: req.body.count };
    });
  });

  it("rejects null for required fields", async () => {
    const res = await request(app.expressApp)
      .post("/strict")
      .set("x-api-version", "2000-01-01")
      .send({ name: null, count: 5 });

    expect(res.status).toBe(422);
  });

  it("rejects wrong types", async () => {
    const res = await request(app.expressApp)
      .post("/strict")
      .set("x-api-version", "2000-01-01")
      .send({ name: 123, count: "not-a-number" });

    expect(res.status).toBe(422);
  });

  it("rejects when required fields are missing", async () => {
    const res = await request(app.expressApp)
      .post("/strict")
      .set("x-api-version", "2000-01-01")
      .send({ name: "hello" }); // missing count

    expect(res.status).toBe(422);
  });
});
