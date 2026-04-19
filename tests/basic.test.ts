import { describe, it, expect } from "vitest";
import request from "supertest";
import { z } from "zod";
import crypto from "node:crypto";

// Import tsadwyn - this also patches Zod with .named()
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

// --- App Setup ---

const UserCreateRequest = z
  .object({
    addresses: z.array(z.string()),
  })
  .named("UserCreateRequest");

const UserResource = z
  .object({
    id: z.string().uuid(),
    addresses: z.array(z.string()).min(1),
  })
  .named("UserResource");

const database: Record<string, any> = {};

function createApp() {
  // Clear the database for each test suite
  for (const key of Object.keys(database)) {
    delete database[key];
  }

  const router = new VersionedRouter();

  router.post(
    "/users",
    UserCreateRequest,
    UserResource,
    async (req: any) => {
      const id = crypto.randomUUID();
      database[id] = { id, addresses: req.body.addresses };
      return database[id];
    },
  );

  router.get(
    "/users/:userId",
    null,
    UserResource,
    async (req: any) => {
      return database[req.params.userId];
    },
  );

  class ChangeAddressToList extends VersionChange {
    description = "Give user the ability to have multiple addresses";

    instructions = [
      schema(UserCreateRequest)
        .field("addresses")
        .had({ name: "address", type: z.string() }),
      schema(UserResource)
        .field("addresses")
        .had({ name: "address", type: z.string() }),
    ];

    @convertRequestToNextVersionFor(UserCreateRequest)
    changeAddressToMultipleItems(request: RequestInfo) {
      request.body.addresses = [request.body.address];
      delete request.body.address;
    }

    @convertResponseToPreviousVersionFor(UserResource)
    changeAddressesToSingleItem(response: ResponseInfo) {
      // With migrateHttpErrors defaulting to true (Stripe semantics), this
      // migration can fire on 422 validation errors whose body is
      // {detail: [...]} rather than a UserResource. Null-check the shape
      // before mutating.
      if (response.body?.addresses) {
        response.body.address = response.body.addresses[0];
        delete response.body.addresses;
      }
    }
  }

  const app = new Tsadwyn({
    versions: new VersionBundle(
      new Version("2001-01-01", ChangeAddressToList),
      new Version("2000-01-01"),
    ),
  });
  app.generateAndIncludeVersionedRouters(router);

  return app;
}

// --- Tests ---

describe("versioned API", () => {
  const app = createApp();

  it("handles old version with singular address (POST)", async () => {
    const createRes = await request(app.expressApp)
      .post("/users")
      .set("x-api-version", "2000-01-01")
      .send({ address: "123 Example St" });

    expect(createRes.status).toBe(200);
    expect(createRes.body.address).toBe("123 Example St");
    expect(createRes.body.id).toBeDefined();
    // Old version should NOT have "addresses"
    expect(createRes.body.addresses).toBeUndefined();
  });

  it("handles old version with singular address (GET)", async () => {
    // First create a user via old version
    const createRes = await request(app.expressApp)
      .post("/users")
      .set("x-api-version", "2000-01-01")
      .send({ address: "456 Old St" });

    expect(createRes.status).toBe(200);
    const userId = createRes.body.id;

    // Then fetch via old version
    const getRes = await request(app.expressApp)
      .get(`/users/${userId}`)
      .set("x-api-version", "2000-01-01");

    expect(getRes.status).toBe(200);
    expect(getRes.body.id).toBe(userId);
    expect(getRes.body.address).toBe("456 Old St");
    expect(getRes.body.addresses).toBeUndefined();
  });

  it("handles new version with addresses array (POST)", async () => {
    const createRes = await request(app.expressApp)
      .post("/users")
      .set("x-api-version", "2001-01-01")
      .send({ addresses: ["123 John St", "456 Smith St"] });

    expect(createRes.status).toBe(200);
    expect(createRes.body.addresses).toEqual(["123 John St", "456 Smith St"]);
    expect(createRes.body.id).toBeDefined();
    // New version should NOT have "address"
    expect(createRes.body.address).toBeUndefined();
  });

  it("handles new version with addresses array (GET)", async () => {
    // First create via new version
    const createRes = await request(app.expressApp)
      .post("/users")
      .set("x-api-version", "2001-01-01")
      .send({ addresses: ["789 New Ave"] });

    expect(createRes.status).toBe(200);
    const userId = createRes.body.id;

    // Then fetch via new version
    const getRes = await request(app.expressApp)
      .get(`/users/${userId}`)
      .set("x-api-version", "2001-01-01");

    expect(getRes.status).toBe(200);
    expect(getRes.body.id).toBe(userId);
    expect(getRes.body.addresses).toEqual(["789 New Ave"]);
    expect(getRes.body.address).toBeUndefined();
  });

  it("validates request body against versioned schema (old version)", async () => {
    // Old version expects "address" (string), not "addresses" (array)
    const res = await request(app.expressApp)
      .post("/users")
      .set("x-api-version", "2000-01-01")
      .send({ addresses: ["not", "valid", "for old version"] });

    expect(res.status).toBe(422);
  });

  it("validates request body against versioned schema (new version)", async () => {
    // New version expects "addresses" (array), not "address" (string)
    const res = await request(app.expressApp)
      .post("/users")
      .set("x-api-version", "2001-01-01")
      .send({ address: "not valid for new version" });

    expect(res.status).toBe(422);
  });
});
