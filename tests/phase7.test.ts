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
  CadwynStructureError,
  apiVersionStorage,
} from "../src/index.js";

// --- Shared schemas ---

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

function clearDb() {
  for (const key of Object.keys(database)) {
    delete database[key];
  }
}

const userHandler = async (req: any) => {
  const id = crypto.randomUUID();
  database[id] = { id, addresses: req.body.addresses };
  return database[id];
};

const getUserHandler = async (req: any) => {
  return database[req.params.userId];
};

/**
 * Factory: creates a fresh VersionChange subclass that does the address->addresses migration.
 * Each invocation returns a unique class, avoiding VersionBundle double-binding errors.
 */
function makeChangeAddressToList(): new () => VersionChange {
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
      response.body.address = response.body.addresses[0];
      delete response.body.addresses;
    }
  }
  return ChangeAddressToList;
}

function makeVersionBundle() {
  return new VersionBundle(
    new Version("2001-01-01", makeChangeAddressToList()),
    new Version("2000-01-01"),
  );
}

function makeRouter() {
  const router = new VersionedRouter();
  router.post("/users", UserCreateRequest, UserResource, userHandler);
  router.get("/users/:userId", null, UserResource, getUserHandler);
  return router;
}

// =====================================================================
// T-700: Configurable apiVersionLocation -- header vs URL path
// =====================================================================

describe("T-700: apiVersionLocation", () => {
  describe("custom_header (default)", () => {
    it("extracts version from header (existing behavior)", async () => {
      clearDb();
      const app = new Cadwyn({ versions: makeVersionBundle() });
      app.generateAndIncludeVersionedRouters(makeRouter());

      const res = await request(app.expressApp)
        .post("/users")
        .set("x-api-version", "2000-01-01")
        .send({ address: "123 Old St" });

      expect(res.status).toBe(200);
      expect(res.body.address).toBe("123 Old St");
    });
  });

  describe("path", () => {
    it("extracts version from URL path", async () => {
      clearDb();
      const app = new Cadwyn({
        versions: makeVersionBundle(),
        apiVersionLocation: "path",
      });
      app.generateAndIncludeVersionedRouters(makeRouter());

      const res = await request(app.expressApp)
        .post("/2000-01-01/users")
        .send({ address: "123 Old St" });

      expect(res.status).toBe(200);
      expect(res.body.address).toBe("123 Old St");
    });

    it("handles new version via path", async () => {
      clearDb();
      const app = new Cadwyn({
        versions: makeVersionBundle(),
        apiVersionLocation: "path",
      });
      app.generateAndIncludeVersionedRouters(makeRouter());

      const res = await request(app.expressApp)
        .post("/2001-01-01/users")
        .send({ addresses: ["456 New Ave"] });

      expect(res.status).toBe(200);
      expect(res.body.addresses).toEqual(["456 New Ave"]);
    });

    it("defaults to latest version when path has no version prefix", async () => {
      clearDb();
      const app = new Cadwyn({
        versions: makeVersionBundle(),
        apiVersionLocation: "path",
      });
      app.generateAndIncludeVersionedRouters(makeRouter());

      // No version in path -- falls back to latest (2001-01-01)
      const res = await request(app.expressApp)
        .post("/users")
        .send({ addresses: ["hello"] });

      expect(res.status).toBe(200);
      expect(res.body.addresses).toEqual(["hello"]);
    });

    it("throws when apiVersionDefaultValue is used with path location", () => {
      expect(() => {
        new Cadwyn({
          versions: makeVersionBundle(),
          apiVersionLocation: "path",
          apiVersionDefaultValue: "2000-01-01",
        });
      }).toThrow(CadwynStructureError);
    });
  });
});

// =====================================================================
// T-701: Configurable apiVersionFormat -- date vs string
// =====================================================================

describe("T-701: apiVersionFormat", () => {
  describe("date (default)", () => {
    it("accepts valid date versions", () => {
      expect(() => {
        new Cadwyn({
          versions: new VersionBundle(
            new Version("2001-01-01"),
            new Version("2000-01-01"),
          ),
        });
      }).not.toThrow();
    });

    it("rejects non-date version strings", () => {
      expect(() => {
        new Cadwyn({
          versions: new VersionBundle(
            new Version("v2"),
            new Version("v1"),
            { apiVersionFormat: "string" },
          ),
          apiVersionFormat: "date",
        });
      }).toThrow(CadwynStructureError);
    });

    it("rejects versions not sorted newest-first", () => {
      expect(() => {
        new Cadwyn({
          versions: new VersionBundle(
            new Version("2000-01-01"),
            new Version("2001-01-01"),
            { apiVersionFormat: "string" },
          ),
          apiVersionFormat: "date",
        });
      }).toThrow(CadwynStructureError);
    });
  });

  describe("string", () => {
    it("accepts any string versions when using string format", () => {
      expect(() => {
        new Cadwyn({
          versions: new VersionBundle(
            new Version("v2"),
            new Version("v1"),
            { apiVersionFormat: "string" },
          ),
          apiVersionFormat: "string",
        });
      }).not.toThrow();
    });

    it("does not require date-based sorting when using string format", () => {
      // "alpha" < "beta" lexicographically, but VersionBundle with string format
      // still requires descending sort. "beta" > "alpha" is descending.
      expect(() => {
        new Cadwyn({
          versions: new VersionBundle(
            new Version("beta"),
            new Version("alpha"),
            { apiVersionFormat: "string" },
          ),
          apiVersionFormat: "string",
        });
      }).not.toThrow();
    });

    it("works with string versions for routing", async () => {
      const router = new VersionedRouter();
      router.get("/ping", null, null, async () => ({ pong: true }));

      const app = new Cadwyn({
        versions: new VersionBundle(
          new Version("v2"),
          new Version("v1"),
          { apiVersionFormat: "string" },
        ),
        apiVersionFormat: "string",
      });
      app.generateAndIncludeVersionedRouters(router);

      const res = await request(app.expressApp)
        .get("/ping")
        .set("x-api-version", "v1");

      expect(res.status).toBe(200);
      expect(res.body.pong).toBe(true);
    });
  });
});

// =====================================================================
// T-702: apiVersionDefaultValue
// =====================================================================

describe("T-702: apiVersionDefaultValue", () => {
  it("uses string default when no version header is provided", async () => {
    clearDb();
    const app = new Cadwyn({
      versions: makeVersionBundle(),
      apiVersionDefaultValue: "2000-01-01",
    });
    app.generateAndIncludeVersionedRouters(makeRouter());

    // No version header -- should use the default "2000-01-01"
    const res = await request(app.expressApp)
      .post("/users")
      .send({ address: "123 Default St" });

    expect(res.status).toBe(200);
    expect(res.body.address).toBe("123 Default St");
  });

  it("uses function default when no version header is provided", async () => {
    clearDb();
    const app = new Cadwyn({
      versions: makeVersionBundle(),
      apiVersionDefaultValue: (_req) => "2000-01-01",
    });
    app.generateAndIncludeVersionedRouters(makeRouter());

    const res = await request(app.expressApp)
      .post("/users")
      .send({ address: "123 Func St" });

    expect(res.status).toBe(200);
    expect(res.body.address).toBe("123 Func St");
  });

  it("uses async function default", async () => {
    clearDb();
    const app = new Cadwyn({
      versions: makeVersionBundle(),
      apiVersionDefaultValue: async (_req) => "2000-01-01",
    });
    app.generateAndIncludeVersionedRouters(makeRouter());

    const res = await request(app.expressApp)
      .post("/users")
      .send({ address: "123 Async St" });

    expect(res.status).toBe(200);
    expect(res.body.address).toBe("123 Async St");
  });

  it("header takes precedence over default", async () => {
    clearDb();
    const app = new Cadwyn({
      versions: makeVersionBundle(),
      apiVersionDefaultValue: "2000-01-01",
    });
    app.generateAndIncludeVersionedRouters(makeRouter());

    // Explicitly send new version header
    const res = await request(app.expressApp)
      .post("/users")
      .set("x-api-version", "2001-01-01")
      .send({ addresses: ["123 Explicit St"] });

    expect(res.status).toBe(200);
    expect(res.body.addresses).toEqual(["123 Explicit St"]);
  });

  it("throws when used with path location", () => {
    expect(() => {
      new Cadwyn({
        versions: makeVersionBundle(),
        apiVersionLocation: "path",
        apiVersionDefaultValue: "2000-01-01",
      });
    }).toThrow(CadwynStructureError);
  });
});

// =====================================================================
// T-703: Custom versioning middleware
// =====================================================================

describe("T-703: custom versioningMiddleware", () => {
  it("uses custom middleware for version extraction", async () => {
    clearDb();
    const app = new Cadwyn({
      versions: makeVersionBundle(),
      versioningMiddleware: (req, res, next) => {
        // Custom: always set version to 2000-01-01 via AsyncLocalStorage
        apiVersionStorage.run("2000-01-01", () => {
          next();
        });
      },
    });
    app.generateAndIncludeVersionedRouters(makeRouter());

    // Even with new version header, custom middleware forces old version
    const res = await request(app.expressApp)
      .post("/users")
      .set("x-api-version", "2001-01-01")
      .send({ address: "123 Custom St" });

    expect(res.status).toBe(200);
    expect(res.body.address).toBe("123 Custom St");
  });
});

// =====================================================================
// T-704: Lazy initialization on first request
// =====================================================================

describe("T-704: eager initialization", () => {
  it("generates routers eagerly during generateAndIncludeVersionedRouters", async () => {
    clearDb();
    const app = new Cadwyn({ versions: makeVersionBundle() });
    const router = makeRouter();
    app.generateAndIncludeVersionedRouters(router);

    // The app should be initialized immediately (eager initialization for validation)
    expect((app as any)._initialized).toBe(true);

    // Requests should work immediately
    const res = await request(app.expressApp)
      .post("/users")
      .set("x-api-version", "2001-01-01")
      .send({ addresses: ["123 Lazy St"] });

    expect(res.status).toBe(200);
  });

  it("subsequent requests work after initialization", async () => {
    clearDb();
    const app = new Cadwyn({ versions: makeVersionBundle() });
    app.generateAndIncludeVersionedRouters(makeRouter());

    // First request
    await request(app.expressApp)
      .post("/users")
      .set("x-api-version", "2001-01-01")
      .send({ addresses: ["First"] });

    // Second request
    const res = await request(app.expressApp)
      .post("/users")
      .set("x-api-version", "2001-01-01")
      .send({ addresses: ["Second"] });

    expect(res.status).toBe(200);
    expect(res.body.addresses).toEqual(["Second"]);
  });
});

// =====================================================================
// T-705: Unversioned routes
// =====================================================================

describe("T-705: unversioned routes", () => {
  it("serves unversioned routes without version header", async () => {
    const app = new Cadwyn({ versions: makeVersionBundle() });

    app.unversionedRouter.get("/health", null, null, async () => ({
      status: "ok",
    }));

    app.generateAndIncludeVersionedRouters(makeRouter());

    const res = await request(app.expressApp).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("serves unversioned routes even with version header", async () => {
    const app = new Cadwyn({ versions: makeVersionBundle() });

    app.unversionedRouter.get("/health", null, null, async () => ({
      status: "ok",
    }));

    app.generateAndIncludeVersionedRouters(makeRouter());

    const res = await request(app.expressApp)
      .get("/health")
      .set("x-api-version", "2001-01-01");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("versioned routes still work alongside unversioned ones", async () => {
    clearDb();
    const app = new Cadwyn({ versions: makeVersionBundle() });

    app.unversionedRouter.get("/health", null, null, async () => ({
      status: "ok",
    }));

    app.generateAndIncludeVersionedRouters(makeRouter());

    const healthRes = await request(app.expressApp).get("/health");
    expect(healthRes.status).toBe(200);
    expect(healthRes.body.status).toBe("ok");

    const userRes = await request(app.expressApp)
      .post("/users")
      .set("x-api-version", "2001-01-01")
      .send({ addresses: ["123 Versioned St"] });

    expect(userRes.status).toBe(200);
    expect(userRes.body.addresses).toEqual(["123 Versioned St"]);
  });
});

// =====================================================================
// T-706: Dependency overrides
// =====================================================================

describe("T-706: dependency overrides", () => {
  it("uses override handler when set", async () => {
    clearDb();
    const app = new Cadwyn({ versions: makeVersionBundle() });
    const router = new VersionedRouter();

    const originalHandler = async (req: any) => {
      const id = crypto.randomUUID();
      database[id] = { id, addresses: req.body.addresses };
      return database[id];
    };

    router.post("/users", UserCreateRequest, UserResource, originalHandler);
    router.get("/users/:userId", null, UserResource, getUserHandler);

    const mockHandler = async (_req: any) => {
      return {
        id: "mock-id-000",
        addresses: ["mocked-address"],
      };
    };

    app.dependencyOverrides.set(originalHandler, mockHandler);
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .post("/users")
      .set("x-api-version", "2001-01-01")
      .send({ addresses: ["real address"] });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("mock-id-000");
    expect(res.body.addresses).toEqual(["mocked-address"]);
  });

  it("uses original handler when no override is set", async () => {
    clearDb();
    const app = new Cadwyn({ versions: makeVersionBundle() });
    const router = new VersionedRouter();

    const originalHandler = async (req: any) => {
      const id = crypto.randomUUID();
      database[id] = { id, addresses: req.body.addresses };
      return database[id];
    };

    router.post("/users", UserCreateRequest, UserResource, originalHandler);

    // No override set
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .post("/users")
      .set("x-api-version", "2001-01-01")
      .send({ addresses: ["real address"] });

    expect(res.status).toBe(200);
    expect(res.body.addresses).toEqual(["real address"]);
    expect(res.body.id).not.toBe("mock-id-000");
  });

  it("override works with unversioned routes", async () => {
    const originalHealth = async () => ({ status: "ok" });
    const mockHealth = async () => ({ status: "mocked" });

    const app = new Cadwyn({ versions: makeVersionBundle() });
    app.unversionedRouter.get("/health", null, null, originalHealth);
    app.dependencyOverrides.set(originalHealth, mockHealth);
    app.generateAndIncludeVersionedRouters(makeRouter());

    const res = await request(app.expressApp).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("mocked");
  });

  it("override can be changed dynamically after initialization", async () => {
    clearDb();
    const app = new Cadwyn({ versions: makeVersionBundle() });
    const router = new VersionedRouter();

    const originalHandler = async (req: any) => {
      return { id: "original", addresses: req.body.addresses };
    };

    router.post("/users", UserCreateRequest, UserResource, originalHandler);
    app.generateAndIncludeVersionedRouters(router);

    // First request without override
    const res1 = await request(app.expressApp)
      .post("/users")
      .set("x-api-version", "2001-01-01")
      .send({ addresses: ["addr1"] });

    expect(res1.body.id).toBe("original");

    // Now add override
    app.dependencyOverrides.set(originalHandler, async (_req: any) => ({
      id: "overridden",
      addresses: ["overridden-addr"],
    }));

    const res2 = await request(app.expressApp)
      .post("/users")
      .set("x-api-version", "2001-01-01")
      .send({ addresses: ["addr2"] });

    expect(res2.body.id).toBe("overridden");
  });
});
