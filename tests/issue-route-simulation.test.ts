/**
 * FAILING TEST — verifies the gap described in tsadwyn-issue-route-simulation-debug-tool.md
 *
 * `simulateRoute()` is the programmatic API that answers "is tsadwyn
 * responsible for this request, and if so, what would it do?" without
 * actually dispatching. Input: method + path + version (+ optional body).
 * Output: matched route (if any), every candidate and why it did/didn't
 * match, fallthrough reason with closest-miss suggestions, and the
 * request/response migration chains that would run.
 *
 * These tests turn green when `simulateRoute()` is exported.
 *
 * Run: npx vitest run tests/issue-route-simulation.test.ts
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";

import {
  Tsadwyn,
  Version,
  VersionBundle,
  VersionChange,
  VersionedRouter,
  ResponseInfo,
  RequestInfo,
  convertRequestToNextVersionFor,
  convertResponseToPreviousVersionFor,
  endpoint,
} from "../src/index.js";

// GAP: not exported
// @ts-expect-error — intentional
import { simulateRoute } from "../src/index.js";

const UserResp = z
  .object({ id: z.string(), name: z.string() })
  .named("IssueRouteSim_User");

const ChargeReq = z
  .object({ amount: z.number() })
  .named("IssueRouteSim_ChargeReq");
const ChargeResp = z
  .object({ id: z.string(), amount: z.number() })
  .named("IssueRouteSim_ChargeResp");

function makeRealApp() {
  const router = new VersionedRouter({ prefix: "/api" });

  router.get(
    "/virtual-accounts/deposits",
    null,
    UserResp,
    async () => ({ id: "list", name: "deposits" }),
  );
  router.get(
    "/virtual-accounts/:id",
    null,
    UserResp,
    async (req: any) => ({ id: req.params.id, name: "va" }),
  );
  router.post(
    "/virtual-accounts/:id/payout",
    ChargeReq,
    ChargeResp,
    async (req: any) => ({ id: "p-" + req.params.id, amount: req.body.amount }),
  );
  router.post(
    "/virtual-accounts",
    ChargeReq,
    ChargeResp,
    async (req: any) => ({ id: "new", amount: req.body.amount }),
  );

  const app = new Tsadwyn({
    versions: new VersionBundle(
      new Version("2025-06-01"),
      new Version("2024-01-01"),
    ),
  });
  app.generateAndIncludeVersionedRouters(router);
  return app;
}

describe("Issue: simulateRoute() — match semantics", () => {
  it("returns matchedRoute with captured params for an unambiguous match", () => {
    const app = makeRealApp();

    const result = simulateRoute(app, {
      method: "POST",
      path: "/api/virtual-accounts/c3e1a4b2-1111-2222-3333-444455556666/payout",
      version: "2025-06-01",
    });

    expect(result.matchedRoute).not.toBeNull();
    expect(result.matchedRoute.method).toBe("POST");
    expect(result.matchedRoute.path).toBe("/api/virtual-accounts/:id/payout");
    expect(result.matchedRoute.params).toEqual({
      id: "c3e1a4b2-1111-2222-3333-444455556666",
    });
    expect(result.fallthrough).toBeNull();
  });

  it("returns matchedRoute = null and populates fallthrough when nothing matches", () => {
    const app = makeRealApp();

    const result = simulateRoute(app, {
      method: "POST",
      path: "/api/virtual-accounts/abc/payout/preview",
      version: "2025-06-01",
    });

    expect(result.matchedRoute).toBeNull();
    expect(result.fallthrough).not.toBeNull();
    expect(result.fallthrough.reason).toMatch(/no.*match|does not match/i);

    // Closest miss should name /virtual-accounts/:id/payout
    const closest = result.fallthrough.closestMisses ?? [];
    const hasPayoutMiss = closest.some(
      (m: any) =>
        m.method === "POST" && m.path === "/api/virtual-accounts/:id/payout",
    );
    expect(hasPayoutMiss).toBe(true);
  });

  it("resolves version from an explicit version argument first, then header default", () => {
    const app = makeRealApp();

    const explicit = simulateRoute(app, {
      method: "GET",
      path: "/api/virtual-accounts/deposits",
      version: "2024-01-01",
    });
    expect(explicit.resolvedVersion).toBe("2024-01-01");

    const headerBased = simulateRoute(app, {
      method: "GET",
      path: "/api/virtual-accounts/deposits",
      headers: { "x-api-version": "2024-01-01" },
    });
    expect(headerBased.resolvedVersion).toBe("2024-01-01");

    const fallbackToHead = simulateRoute(app, {
      method: "GET",
      path: "/api/virtual-accounts/deposits",
    });
    expect(fallbackToHead.resolvedVersion).toBe("2025-06-01");
  });
});

describe("Issue: simulateRoute() — candidate reasoning", () => {
  it("tests every registered route and explains why each did or didn't match", () => {
    const app = makeRealApp();

    const result = simulateRoute(app, {
      method: "POST",
      path: "/api/virtual-accounts/abc/payout/preview",
      version: "2025-06-01",
    });

    expect(Array.isArray(result.candidates)).toBe(true);
    // Must have tested every registered route at this version (4 routes)
    expect(result.candidates.length).toBe(4);

    // Each candidate has matched + reason + regex
    for (const c of result.candidates) {
      expect(typeof c.matched).toBe("boolean");
      expect(typeof c.reason).toBe("string");
      expect(typeof c.regex).toBe("string");
    }

    // The /virtual-accounts/:id/payout candidate was tested and NOT matched
    const payoutCandidate = result.candidates.find(
      (c: any) =>
        c.method === "POST" && c.path === "/api/virtual-accounts/:id/payout",
    );
    expect(payoutCandidate).toBeDefined();
    expect(payoutCandidate.matched).toBe(false);
    // Reason should identify that there's an extra segment after the match
    expect(payoutCandidate.reason).toMatch(/extra segment|too long|preview/i);
  });

  it("distinguishes method mismatch as its own reason type", () => {
    const app = makeRealApp();

    const result = simulateRoute(app, {
      method: "DELETE",
      path: "/api/virtual-accounts/deposits",
      version: "2025-06-01",
    });

    const depositsCandidate = result.candidates.find(
      (c: any) => c.path === "/api/virtual-accounts/deposits",
    );
    expect(depositsCandidate).toBeDefined();
    expect(depositsCandidate.matched).toBe(false);
    expect(depositsCandidate.reason).toMatch(/method mismatch/i);
  });

  it("respects registration order for first-match-wins (documents the wildcard-collision landmine)", () => {
    const app = makeRealApp();

    // In makeRealApp, /virtual-accounts/deposits is registered BEFORE
    // /virtual-accounts/:id. GET /virtual-accounts/deposits matches the
    // literal first.
    const result = simulateRoute(app, {
      method: "GET",
      path: "/api/virtual-accounts/deposits",
      version: "2025-06-01",
    });

    expect(result.matchedRoute).not.toBeNull();
    expect(result.matchedRoute.path).toBe("/api/virtual-accounts/deposits");

    // The wildcard candidate ALSO matched regex-wise, but registration order
    // prefers the literal. Both facts should be visible in candidates.
    const literalCandidate = result.candidates.find(
      (c: any) => c.path === "/api/virtual-accounts/deposits",
    );
    const wildcardCandidate = result.candidates.find(
      (c: any) => c.path === "/api/virtual-accounts/:id",
    );
    expect(literalCandidate.matched).toBe(true);
    expect(wildcardCandidate.matched).toBe(true);  // would-also-match
    // Reason on the wildcard should note it was shadowed
    expect(wildcardCandidate.reason).toMatch(/shadowed|first-match|order/i);
  });
});

describe("Issue: simulateRoute() — migration visibility", () => {
  it("returns the request migrations that would run for a versioned request", () => {
    class NormalizeAmount extends VersionChange {
      description = "normalize amount at 2025-06-01";
      instructions = [];

      migrate = convertRequestToNextVersionFor(ChargeReq)(
        (_req: RequestInfo) => {},
      );
    }

    const router = new VersionedRouter({ prefix: "/api" });
    router.post(
      "/charges",
      ChargeReq,
      ChargeResp,
      async () => ({ id: "c1", amount: 100 }),
    );

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-06-01", NormalizeAmount),
        new Version("2024-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const result = simulateRoute(app, {
      method: "POST",
      path: "/api/charges",
      version: "2024-01-01",
    });

    expect(result.matchedRoute).not.toBeNull();
    expect(Array.isArray(result.requestMigrations)).toBe(true);
    expect(result.requestMigrations.length).toBeGreaterThan(0);
    expect(result.requestMigrations[0]).toMatchObject({
      schemaName: "IssueRouteSim_ChargeReq",
    });
  });

  it("returns the response migrations that would run for a versioned response", () => {
    class RenameAmount extends VersionChange {
      description = "rename amount at 2025-06-01";
      instructions = [];

      migrate = convertResponseToPreviousVersionFor(ChargeResp)(
        (_res: ResponseInfo) => {},
      );
    }

    const router = new VersionedRouter({ prefix: "/api" });
    router.post(
      "/charges",
      ChargeReq,
      ChargeResp,
      async () => ({ id: "c1", amount: 100 }),
    );

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-06-01", RenameAmount),
        new Version("2024-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const result = simulateRoute(app, {
      method: "POST",
      path: "/api/charges",
      version: "2024-01-01",
    });

    expect(result.responseMigrations.length).toBeGreaterThan(0);
    expect(result.responseMigrations[0]).toMatchObject({
      schemaName: "IssueRouteSim_ChargeResp",
    });
  });

  it("surfaces PATH-based request AND response migrations in the chain summaries", () => {
    class PathBasedBothDirections extends VersionChange {
      description = "path-based request + response migrations on POST /api/charges";
      instructions = [];

      req1 = convertRequestToNextVersionFor("/api/charges", ["POST"])(
        (_req: RequestInfo) => {},
      );

      res1 = convertResponseToPreviousVersionFor("/api/charges", ["POST"])(
        (_res: ResponseInfo) => {},
      );
    }

    const router = new VersionedRouter({ prefix: "/api" });
    router.post(
      "/charges",
      ChargeReq,
      ChargeResp,
      async () => ({ id: "c1", amount: 100 }),
    );

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-06-01", PathBasedBothDirections),
        new Version("2024-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const result = simulateRoute(app, {
      method: "POST",
      path: "/api/charges",
      version: "2024-01-01",
    });

    // Path-based request migration surfaces (schemaName: null signals path-based)
    const pathBasedReq = result.requestMigrations.filter(
      (m: any) => m.schemaName === null,
    );
    expect(pathBasedReq.length).toBeGreaterThan(0);
    expect(pathBasedReq[0].path).toBe("/api/charges");

    // Path-based response migration surfaces
    const pathBasedRes = result.responseMigrations.filter(
      (m: any) => m.schemaName === null,
    );
    expect(pathBasedRes.length).toBeGreaterThan(0);
    expect(pathBasedRes[0].path).toBe("/api/charges");
  });

  it("body preview runs PATH-based request migrations too (not only schema-based)", () => {
    class PathBasedBodyRewriter extends VersionChange {
      description =
        "path-based request migration that injects a default field for legacy clients";
      instructions = [];

      r1 = convertRequestToNextVersionFor("/api/charges", ["POST"])(
        (req: RequestInfo) => {
          if ((req.body as any) && typeof req.body === "object") {
            (req.body as any).currency = (req.body as any).currency ?? "USD";
          }
        },
      );
    }

    const router = new VersionedRouter({ prefix: "/api" });
    router.post(
      "/charges",
      ChargeReq,
      ChargeResp,
      async () => ({ id: "c1", amount: 100 }),
    );

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-06-01", PathBasedBodyRewriter),
        new Version("2024-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const result = simulateRoute(app, {
      method: "POST",
      path: "/api/charges",
      version: "2024-01-01",
      body: { amount: 100 },  // legacy client didn't send currency
    });

    // The path-based migration populated .currency even though we didn't send it.
    expect(result.upMigratedBody).toMatchObject({
      amount: 100,
      currency: "USD",
    });
  });

  it("both migration arrays are empty when client pin == head", () => {
    class RenameAmount extends VersionChange {
      description = "rename amount at 2025-06-01";
      instructions = [];

      migrate = convertResponseToPreviousVersionFor(ChargeResp)(
        (_res: ResponseInfo) => {},
      );
    }

    const router = new VersionedRouter({ prefix: "/api" });
    router.post(
      "/charges",
      ChargeReq,
      ChargeResp,
      async () => ({ id: "c1", amount: 100 }),
    );

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-06-01", RenameAmount),
        new Version("2024-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const result = simulateRoute(app, {
      method: "POST",
      path: "/api/charges",
      version: "2025-06-01",  // HEAD
    });

    expect(result.requestMigrations).toEqual([]);
    expect(result.responseMigrations).toEqual([]);
  });
});

describe("Issue: simulateRoute() — body preview", () => {
  it("up-migrates a supplied legacy body and exposes the head-shape it produces", () => {
    class AddCurrency extends VersionChange {
      description = "legacy clients omit currency; default to USD at head";
      instructions = [];

      migrate = convertRequestToNextVersionFor(ChargeReq)(
        (req: RequestInfo) => {
          if ((req.body as any).currency === undefined) {
            (req.body as any).currency = "USD";
          }
        },
      );
    }

    const router = new VersionedRouter({ prefix: "/api" });
    router.post(
      "/charges",
      ChargeReq,
      ChargeResp,
      async () => ({ id: "c1", amount: 100 }),
    );

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-06-01", AddCurrency),
        new Version("2024-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const result = simulateRoute(app, {
      method: "POST",
      path: "/api/charges",
      version: "2024-01-01",
      body: { amount: 100 },
    });

    expect(result.upMigratedBody).toEqual({ amount: 100, currency: "USD" });
  });

  it("omits upMigratedBody when no body is supplied", () => {
    const app = makeRealApp();

    const result = simulateRoute(app, {
      method: "GET",
      path: "/api/virtual-accounts/deposits",
      version: "2025-06-01",
      // no body
    });

    expect(result.upMigratedBody).toBeUndefined();
  });
});

describe("Issue: simulateRoute() — fallthrough diagnostics", () => {
  it("lists other versions at which the path DOES exist when fallthrough happens at the target version", () => {
    // Endpoint lifecycle: /api/legacy exists at 2024-01-01 but is removed at head.
    const router = new VersionedRouter({ prefix: "/api" });
    router.get("/users/:id", null, UserResp, async (req: any) => ({
      id: req.params.id,
      name: "alice",
    }));
    router.get(
      "/legacy",
      null,
      UserResp,
      async () => ({ id: "l", name: "legacy" }),
    );
    // onlyExistsInOlderVersions needs the stored (prefixed) path.
    router.onlyExistsInOlderVersions("/api/legacy", ["GET"]);

    class RestoreLegacy extends VersionChange {
      description = "legacy clients had GET /api/legacy";
      instructions = [endpoint("/api/legacy", ["GET"]).existed];
    }

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-06-01", RestoreLegacy),
        new Version("2024-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    // At HEAD, /api/legacy does NOT exist — expect fallthrough with the
    // other version where it DID exist listed.
    const result = simulateRoute(app, {
      method: "GET",
      path: "/api/legacy",
      version: "2025-06-01",
    });

    expect(result.matchedRoute).toBeNull();
    expect(result.fallthrough).not.toBeNull();
    expect(result.fallthrough!.availableAtOtherVersions).toEqual(["2024-01-01"]);
  });
});
