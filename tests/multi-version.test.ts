import { describe, it, expect, beforeAll } from "vitest";
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

import { createVersionedClients } from "./helpers.js";

/**
 * Multi-version migration chain tests (3+ versions).
 *
 * We set up an app with versions: 2002-01-01 (latest), 2001-01-01, 2000-01-01 (oldest).
 *
 * The resource evolves through versions:
 *   v2000: { name: string, email: string }
 *   v2001: name was split into { firstName: string, lastName: string }, email stays
 *   v2002: email was renamed to emailAddress
 */

// Schemas represent the latest (head) version
const UserCreateRequest = z
  .object({
    firstName: z.string(),
    lastName: z.string(),
    emailAddress: z.string().email(),
  })
  .named("MCUserCreateRequest");

const UserResource = z
  .object({
    id: z.string().uuid(),
    firstName: z.string(),
    lastName: z.string(),
    emailAddress: z.string().email(),
  })
  .named("MCUserResource");

const database: Record<string, any> = {};

// Version change: 2002-01-01 - email was renamed to emailAddress
class RenameEmailToEmailAddress extends VersionChange {
  description = "Renamed email to emailAddress for clarity";

  instructions = [
    schema(UserCreateRequest)
      .field("emailAddress")
      .had({ name: "email", type: z.string().email() }),
    schema(UserResource)
      .field("emailAddress")
      .had({ name: "email", type: z.string().email() }),
  ];

  @convertRequestToNextVersionFor(UserCreateRequest)
  migrateRequest(req: RequestInfo) {
    req.body.emailAddress = req.body.email;
    delete req.body.email;
  }

  @convertResponseToPreviousVersionFor(UserResource)
  migrateResponse(res: ResponseInfo) {
    res.body.email = res.body.emailAddress;
    delete res.body.emailAddress;
  }
}

// Version change: 2001-01-01 - name was split into firstName + lastName
class SplitNameIntoFirstAndLast extends VersionChange {
  description = "Split single name field into firstName and lastName";

  instructions = [
    schema(UserCreateRequest).field("firstName").had({ name: "name", type: z.string() }),
    schema(UserCreateRequest).field("lastName").didntExist,
    schema(UserResource).field("firstName").had({ name: "name", type: z.string() }),
    schema(UserResource).field("lastName").didntExist,
  ];

  @convertRequestToNextVersionFor(UserCreateRequest)
  migrateRequest(req: RequestInfo) {
    const parts = (req.body.name as string).split(" ");
    req.body.firstName = parts[0] || "";
    req.body.lastName = parts.slice(1).join(" ") || "";
    delete req.body.name;
  }

  @convertResponseToPreviousVersionFor(UserResource)
  migrateResponse(res: ResponseInfo) {
    res.body.name = `${res.body.firstName} ${res.body.lastName}`.trim();
    delete res.body.firstName;
    delete res.body.lastName;
  }
}

function createMultiVersionApp() {
  // Clear database
  for (const key of Object.keys(database)) {
    delete database[key];
  }

  const router = new VersionedRouter();

  router.post("/users", UserCreateRequest, UserResource, async (req: any) => {
    const id = crypto.randomUUID();
    database[id] = {
      id,
      firstName: req.body.firstName,
      lastName: req.body.lastName,
      emailAddress: req.body.emailAddress,
    };
    return database[id];
  });

  router.get("/users/:userId", null, UserResource, async (req: any) => {
    return database[req.params.userId];
  });

  const app = new Tsadwyn({
    versions: new VersionBundle(
      new Version("2002-01-01", RenameEmailToEmailAddress),
      new Version("2001-01-01", SplitNameIntoFirstAndLast),
      new Version("2000-01-01"),
    ),
  });
  app.generateAndIncludeVersionedRouters(router);

  return app;
}

describe("multi-version migration chain (3 versions)", () => {
  const app = createMultiVersionApp();
  const clients = createVersionedClients(app);

  describe("latest version (2002-01-01)", () => {
    it("accepts the latest schema format", async () => {
      const res = await clients["2002-01-01"]
        .post("/users")
        .send({
          firstName: "John",
          lastName: "Doe",
          emailAddress: "john@example.com",
        });

      expect(res.status).toBe(200);
      expect(res.body.firstName).toBe("John");
      expect(res.body.lastName).toBe("Doe");
      expect(res.body.emailAddress).toBe("john@example.com");
      expect(res.body.email).toBeUndefined();
      expect(res.body.name).toBeUndefined();
    });
  });

  describe("middle version (2001-01-01)", () => {
    it("accepts firstName/lastName with email (not emailAddress)", async () => {
      const res = await clients["2001-01-01"]
        .post("/users")
        .send({
          firstName: "Jane",
          lastName: "Smith",
          email: "jane@example.com",
        });

      expect(res.status).toBe(200);
      expect(res.body.firstName).toBe("Jane");
      expect(res.body.lastName).toBe("Smith");
      expect(res.body.email).toBe("jane@example.com");
      // Should not have latest-version fields
      expect(res.body.emailAddress).toBeUndefined();
      expect(res.body.name).toBeUndefined();
    });

    it("fetches a user created via latest version with correct down-migration", async () => {
      // Create via latest
      const createRes = await clients["2002-01-01"]
        .post("/users")
        .send({
          firstName: "Alice",
          lastName: "Wonder",
          emailAddress: "alice@example.com",
        });
      const userId = createRes.body.id;

      // Fetch via middle version
      const getRes = await clients["2001-01-01"].get(`/users/${userId}`);

      expect(getRes.status).toBe(200);
      expect(getRes.body.firstName).toBe("Alice");
      expect(getRes.body.lastName).toBe("Wonder");
      expect(getRes.body.email).toBe("alice@example.com");
      expect(getRes.body.emailAddress).toBeUndefined();
    });
  });

  describe("oldest version (2000-01-01)", () => {
    it("accepts single name and email fields", async () => {
      const res = await clients["2000-01-01"]
        .post("/users")
        .send({
          name: "Bob Jones",
          email: "bob@example.com",
        });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Bob Jones");
      expect(res.body.email).toBe("bob@example.com");
      // Should not have any newer-version fields
      expect(res.body.firstName).toBeUndefined();
      expect(res.body.lastName).toBeUndefined();
      expect(res.body.emailAddress).toBeUndefined();
    });

    it("migrates request through entire chain (oldest -> latest)", async () => {
      // Create via oldest version
      const createRes = await clients["2000-01-01"]
        .post("/users")
        .send({
          name: "Charlie Brown",
          email: "charlie@example.com",
        });

      expect(createRes.status).toBe(200);
      const userId = createRes.body.id;

      // Verify data was correctly migrated to latest internally
      // by fetching via latest version
      const getRes = await clients["2002-01-01"].get(`/users/${userId}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.firstName).toBe("Charlie");
      expect(getRes.body.lastName).toBe("Brown");
      expect(getRes.body.emailAddress).toBe("charlie@example.com");
    });

    it("migrates response through entire chain (latest -> oldest)", async () => {
      // Create via latest version
      const createRes = await clients["2002-01-01"]
        .post("/users")
        .send({
          firstName: "Diana",
          lastName: "Prince",
          emailAddress: "diana@example.com",
        });
      const userId = createRes.body.id;

      // Fetch via oldest version - response must migrate through 2 hops
      const getRes = await clients["2000-01-01"].get(`/users/${userId}`);

      expect(getRes.status).toBe(200);
      expect(getRes.body.name).toBe("Diana Prince");
      expect(getRes.body.email).toBe("diana@example.com");
      expect(getRes.body.firstName).toBeUndefined();
      expect(getRes.body.lastName).toBeUndefined();
      expect(getRes.body.emailAddress).toBeUndefined();
    });
  });

  describe("cross-version consistency", () => {
    it("user created in oldest version is readable in all versions", async () => {
      const createRes = await clients["2000-01-01"]
        .post("/users")
        .send({
          name: "Eve Adams",
          email: "eve@example.com",
        });
      const userId = createRes.body.id;

      // Read from oldest
      const oldest = await clients["2000-01-01"].get(`/users/${userId}`);
      expect(oldest.status).toBe(200);
      expect(oldest.body.name).toBe("Eve Adams");
      expect(oldest.body.email).toBe("eve@example.com");

      // Read from middle
      const middle = await clients["2001-01-01"].get(`/users/${userId}`);
      expect(middle.status).toBe(200);
      expect(middle.body.firstName).toBe("Eve");
      expect(middle.body.lastName).toBe("Adams");
      expect(middle.body.email).toBe("eve@example.com");

      // Read from latest
      const latest = await clients["2002-01-01"].get(`/users/${userId}`);
      expect(latest.status).toBe(200);
      expect(latest.body.firstName).toBe("Eve");
      expect(latest.body.lastName).toBe("Adams");
      expect(latest.body.emailAddress).toBe("eve@example.com");
    });

    it("validates request body against each version's schema", async () => {
      // Oldest version rejects newest format
      const res1 = await clients["2000-01-01"]
        .post("/users")
        .send({
          firstName: "Invalid",
          lastName: "Format",
          emailAddress: "bad@example.com",
        });
      expect(res1.status).toBe(422);

      // Middle version rejects oldest format
      const res2 = await clients["2001-01-01"]
        .post("/users")
        .send({
          name: "Invalid Format",
          email: "bad@example.com",
        });
      expect(res2.status).toBe(422);

      // Latest version rejects middle format
      const res3 = await clients["2002-01-01"]
        .post("/users")
        .send({
          firstName: "Invalid",
          lastName: "Format",
          email: "bad@example.com",
        });
      expect(res3.status).toBe(422);
    });
  });
});
