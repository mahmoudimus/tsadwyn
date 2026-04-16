/**
 * FAILING TEST — RESTful /versioning resource helper for
 * self-service API-version upgrades.
 *
 * Every Stripe-style adopter ends up writing the same endpoint: a client
 * reads their current pin, then posts an upgrade. tsadwyn already ships
 * `validateVersionUpgrade` as the policy core; `createVersioningRoutes`
 * wraps it in the canonical RESTful resource shape.
 *
 *   GET  /versioning            → {version, supported[], latest}
 *   POST /versioning {from, to} → {previous_version, current_version}
 *
 * `{from, to}` gives optimistic concurrency: if the stored pin has drifted
 * since the client last read it, the server rejects with 409 rather than
 * silently overwriting.
 *
 * Run: npx vitest run tests/issue-versioning-resource.test.ts
 */
import { describe, it, expect } from "vitest";
import request from "supertest";

import {
  Tsadwyn,
  Version,
  VersionBundle,
} from "../src/index.js";

// GAP: not exported
// @ts-expect-error — intentional
import { createVersioningRoutes } from "../src/index.js";

// An in-memory "account repo" simulates the consumer's persistence layer.
function buildStore() {
  const pins: Record<string, string> = {};
  return {
    set(accountId: string, version: string) {
      pins[accountId] = version;
    },
    load(accountId: string) {
      return pins[accountId] ?? null;
    },
    save(accountId: string, version: string) {
      pins[accountId] = version;
    },
  };
}

function buildApp(
  store: ReturnType<typeof buildStore>,
  opts: {
    allowDowngrade?: boolean;
    allowNoChange?: boolean;
    fallback?: string;
  } = {},
) {
  const versions = new VersionBundle(
    new Version("2025-06-01"),
    new Version("2025-01-01"),
    new Version("2024-01-01"),
  );

  const versioningRoutes = createVersioningRoutes({
    path: "/versioning",
    identify: (req: any) => req.headers["x-account-id"] ?? null,
    loadVersion: (accountId: string) => store.load(accountId),
    saveVersion: (accountId: string, version: string) =>
      store.save(accountId, version),
    supportedVersions: versions.versionValues,
    allowDowngrade: opts.allowDowngrade ?? false,
    allowNoChange: opts.allowNoChange ?? false,
    fallback: opts.fallback,
  });

  const app = new Tsadwyn({ versions });
  app.generateAndIncludeVersionedRouters(versioningRoutes);
  return app;
}

describe("createVersioningRoutes — RESTful /versioning resource", () => {
  it("GET /versioning returns {version, supported, latest} for an authenticated client", async () => {
    const store = buildStore();
    store.set("acct_1", "2024-01-01");
    const app = buildApp(store);

    const res = await request(app.expressApp)
      .get("/versioning")
      .set("x-account-id", "acct_1")
      .set("x-api-version", "2025-06-01");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      version: "2024-01-01",
      supported: ["2025-06-01", "2025-01-01", "2024-01-01"],
      latest: "2025-06-01",
    });
  });

  it("GET /versioning returns 401 when identify returns null", async () => {
    const app = buildApp(buildStore());

    const res = await request(app.expressApp)
      .get("/versioning")
      .set("x-api-version", "2025-06-01");
    // No x-account-id header → identify returns null → 401

    expect(res.status).toBe(401);
  });

  it("GET /versioning returns null for unpinned clients when no fallback is configured", async () => {
    const store = buildStore();
    const app = buildApp(store);  // no fallback option

    const res = await request(app.expressApp)
      .get("/versioning")
      .set("x-account-id", "acct_never_upgraded")
      .set("x-api-version", "2025-06-01");

    expect(res.status).toBe(200);
    // No fallback → version is null (the client is truly unpinned from
    // tsadwyn's perspective; consumer may handle this out-of-band).
    expect(res.body.version).toBeNull();
  });

  it("POST /versioning with matching from + valid to → 200 + updated pin", async () => {
    const store = buildStore();
    store.set("acct_1", "2024-01-01");
    const app = buildApp(store);

    const res = await request(app.expressApp)
      .post("/versioning")
      .set("x-account-id", "acct_1")
      .set("x-api-version", "2025-06-01")
      .send({ from: "2024-01-01", to: "2025-01-01" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      previous_version: "2024-01-01",
      current_version: "2025-01-01",
    });
    // Persisted
    expect(store.load("acct_1")).toBe("2025-01-01");
  });

  it("POST /versioning with from ≠ stored returns 409 version_mismatch (optimistic concurrency)", async () => {
    const store = buildStore();
    store.set("acct_1", "2025-01-01");  // already upgraded by someone else
    const app = buildApp(store);

    const res = await request(app.expressApp)
      .post("/versioning")
      .set("x-account-id", "acct_1")
      .set("x-api-version", "2025-06-01")
      .send({ from: "2024-01-01", to: "2025-06-01" });  // stale 'from'

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: "version_mismatch",
      expected: "2024-01-01",
      actual: "2025-01-01",
    });
    // Not persisted
    expect(store.load("acct_1")).toBe("2025-01-01");
  });

  it("POST /versioning with unsupported 'to' returns 400 unsupported", async () => {
    const store = buildStore();
    store.set("acct_1", "2024-01-01");
    const app = buildApp(store);

    const res = await request(app.expressApp)
      .post("/versioning")
      .set("x-account-id", "acct_1")
      .set("x-api-version", "2025-06-01")
      .send({ from: "2024-01-01", to: "2099-12-31" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "unsupported" });
  });

  it("POST /versioning downgrade returns 400 downgrade-blocked by default", async () => {
    const store = buildStore();
    store.set("acct_1", "2025-06-01");
    const app = buildApp(store);

    const res = await request(app.expressApp)
      .post("/versioning")
      .set("x-account-id", "acct_1")
      .set("x-api-version", "2025-06-01")
      .send({ from: "2025-06-01", to: "2024-01-01" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "downgrade-blocked" });
  });

  it("POST /versioning downgrade succeeds when allowDowngrade: true (admin force-pin)", async () => {
    const store = buildStore();
    store.set("acct_1", "2025-06-01");
    const app = buildApp(store, { allowDowngrade: true });

    const res = await request(app.expressApp)
      .post("/versioning")
      .set("x-account-id", "acct_1")
      .set("x-api-version", "2025-06-01")
      .send({ from: "2025-06-01", to: "2024-01-01" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      previous_version: "2025-06-01",
      current_version: "2024-01-01",
    });
  });

  it("POST /versioning same from + to returns 400 no-change by default", async () => {
    const store = buildStore();
    store.set("acct_1", "2024-01-01");
    const app = buildApp(store);

    const res = await request(app.expressApp)
      .post("/versioning")
      .set("x-account-id", "acct_1")
      .set("x-api-version", "2025-06-01")
      .send({ from: "2024-01-01", to: "2024-01-01" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "no-change" });
  });

  it("POST /versioning returns 401 when identify returns null", async () => {
    const app = buildApp(buildStore());

    const res = await request(app.expressApp)
      .post("/versioning")
      .set("x-api-version", "2025-06-01")
      .send({ from: "2024-01-01", to: "2025-01-01" });

    expect(res.status).toBe(401);
  });

  it("POST /versioning rejects malformed body (missing 'from' or 'to')", async () => {
    const store = buildStore();
    store.set("acct_1", "2024-01-01");
    const app = buildApp(store);

    const missingTo = await request(app.expressApp)
      .post("/versioning")
      .set("x-account-id", "acct_1")
      .set("x-api-version", "2025-06-01")
      .send({ from: "2024-01-01" });
    expect(missingTo.status).toBe(422);

    const missingFrom = await request(app.expressApp)
      .post("/versioning")
      .set("x-account-id", "acct_1")
      .set("x-api-version", "2025-06-01")
      .send({ to: "2025-01-01" });
    expect(missingFrom.status).toBe(422);
  });

  describe("fallback — effective version for unpinned clients", () => {
    it("GET /versioning returns the fallback value when no pin is stored", async () => {
      const store = buildStore();
      const app = buildApp(store, { fallback: "2024-01-01" });

      const res = await request(app.expressApp)
        .get("/versioning")
        .set("x-account-id", "acct_never_upgraded")
        .set("x-api-version", "2025-06-01");

      expect(res.status).toBe(200);
      // Reports what tsadwyn would actually use at dispatch time.
      expect(res.body.version).toBe("2024-01-01");
    });

    it("POST /versioning accepts from: fallback as 'unpinned starting state'", async () => {
      const store = buildStore();  // acct_1 is unpinned
      const app = buildApp(store, { fallback: "2024-01-01" });

      const res = await request(app.expressApp)
        .post("/versioning")
        .set("x-account-id", "acct_1")
        .set("x-api-version", "2025-06-01")
        .send({ from: "2024-01-01", to: "2025-01-01" });  // from == fallback

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        previous_version: null,
        current_version: "2025-01-01",
      });
      expect(store.load("acct_1")).toBe("2025-01-01");
    });

    it("POST /versioning still accepts from: null alongside fallback (either describes unpinned)", async () => {
      const store = buildStore();
      const app = buildApp(store, { fallback: "2024-01-01" });

      const res = await request(app.expressApp)
        .post("/versioning")
        .set("x-account-id", "acct_1")
        .set("x-api-version", "2025-06-01")
        .send({ from: null, to: "2025-01-01" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        previous_version: null,
        current_version: "2025-01-01",
      });
    });

    it("POST /versioning with from: <other> → 409 against effective version (not null)", async () => {
      const store = buildStore();
      const app = buildApp(store, { fallback: "2024-01-01" });

      const res = await request(app.expressApp)
        .post("/versioning")
        .set("x-account-id", "acct_1")
        .set("x-api-version", "2025-06-01")
        .send({ from: "2025-01-01", to: "2025-06-01" });  // wrong from

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        error: "version_mismatch",
        expected: "2025-01-01",
        actual: "2024-01-01",  // effective, not null
      });
    });

    it("first-upgrade policy: downgrade from fallback is blocked by default", async () => {
      const store = buildStore();
      const app = buildApp(store, { fallback: "2025-01-01" });

      // Client tries to "upgrade" to a version older than the fallback.
      const res = await request(app.expressApp)
        .post("/versioning")
        .set("x-account-id", "acct_1")
        .set("x-api-version", "2025-06-01")
        .send({ from: "2025-01-01", to: "2024-01-01" });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "downgrade-blocked" });
    });

    it("first-upgrade policy: no-change vs fallback is blocked by default", async () => {
      const store = buildStore();
      const app = buildApp(store, { fallback: "2024-01-01" });

      const res = await request(app.expressApp)
        .post("/versioning")
        .set("x-account-id", "acct_1")
        .set("x-api-version", "2025-06-01")
        .send({ from: "2024-01-01", to: "2024-01-01" });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "no-change" });
    });
  });

  it("POST /versioning first-upgrade flow: from: null for unpinned clients", async () => {
    // Convention: a client who has never upgraded reads GET → {version: null};
    // their first upgrade passes from: null to set the initial pin.
    const store = buildStore();
    const app = buildApp(store);

    const res = await request(app.expressApp)
      .post("/versioning")
      .set("x-account-id", "acct_new")
      .set("x-api-version", "2025-06-01")
      .send({ from: null, to: "2024-01-01" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      previous_version: null,
      current_version: "2024-01-01",
    });
    expect(store.load("acct_new")).toBe("2024-01-01");
  });
});
