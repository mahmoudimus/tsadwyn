/**
 * FAILING TEST — verifies the gap described in tsadwyn-issue-route-table-dump.md
 *
 * Today: no public API for enumerating registered routes per version.
 * Consumers grep source or read private `_versionedRouters`.
 *
 * These tests turn green when `dumpRouteTable()` is exported.
 *
 * Run: npx vitest run tests/issue-route-table-dump.test.ts
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";

import {
  Tsadwyn,
  Version,
  VersionBundle,
  VersionChange,
  VersionedRouter,
  endpoint,
} from "../src/index.js";

// GAP: not exported
// @ts-expect-error — intentional
import { dumpRouteTable } from "../src/index.js";

const UserResp = z.object({ id: z.string(), name: z.string() }).named("IssueRouteDump_User");
const ChargeResp = z.object({ id: z.string(), amount: z.number() }).named("IssueRouteDump_Charge");

function makeApp() {
  const router = new VersionedRouter({ prefix: "/api" });
  router.get("/users/:id", null, UserResp, async (req: any) => ({
    id: req.params.id,
    name: "alice",
  }));
  router.post("/charges", null, ChargeResp, async () => ({ id: "c1", amount: 100 }), {
    statusCode: 201,
  });
  router.get("/internal/metrics", null, null, async () => ({}), {
    includeInSchema: false,
  });

  const app = new Tsadwyn({
    versions: new VersionBundle(
      new Version("2025-01-01"),
      new Version("2024-01-01"),
    ),
  });
  app.generateAndIncludeVersionedRouters(router);
  return app;
}

describe("Issue: dumpRouteTable()", () => {
  it("returns every registered route for a specified version", () => {
    const app = makeApp();
    const table = dumpRouteTable(app, { version: "2025-01-01" });

    expect(Array.isArray(table)).toBe(true);
    const paths = table.map((r: any) => `${r.method} ${r.path}`);
    expect(paths).toContain("GET /api/users/:id");
    expect(paths).toContain("POST /api/charges");
  });

  it("excludes includeInSchema: false routes by default", () => {
    const app = makeApp();
    const table = dumpRouteTable(app, { version: "2025-01-01" });
    const paths = table.map((r: any) => r.path);
    expect(paths).not.toContain("/api/internal/metrics");
  });

  it("includes private routes when includePrivate: true", () => {
    const app = makeApp();
    const table = dumpRouteTable(app, {
      version: "2025-01-01",
      includePrivate: true,
    });
    const paths = table.map((r: any) => r.path);
    expect(paths).toContain("/api/internal/metrics");
  });

  it("filters by method case-insensitively", () => {
    const app = makeApp();
    const table = dumpRouteTable(app, { version: "2025-01-01", method: "post" });
    expect(table.every((r: any) => r.method === "POST")).toBe(true);
    expect(table.length).toBeGreaterThan(0);
  });

  it("filters by pathMatches regex", () => {
    const app = makeApp();
    const table = dumpRouteTable(app, {
      version: "2025-01-01",
      pathMatches: /users/,
    });
    expect(table.every((r: any) => /users/.test(r.path))).toBe(true);
    expect(table.length).toBeGreaterThan(0);
  });

  it("filters by pathMatches substring string", () => {
    const app = makeApp();
    const table = dumpRouteTable(app, {
      version: "2025-01-01",
      pathMatches: "charges",
    });
    expect(table.every((r: any) => r.path.includes("charges"))).toBe(true);
  });

  it("entries expose handler name, schemas, statusCode, deprecated flag", () => {
    const app = makeApp();
    const table = dumpRouteTable(app, { version: "2025-01-01" });
    const charge = table.find((r: any) => r.path === "/api/charges");
    expect(charge).toMatchObject({
      method: "POST",
      statusCode: 201,
      deprecated: false,
      responseSchemaName: "IssueRouteDump_Charge",
    });
  });

  it("returns per-version sections when version is omitted", () => {
    const app = makeApp();
    const result = dumpRouteTable(app);  // no version
    // Structure TBD by implementer: object keyed by version, or flat with
    // version field on each entry. Both viable; test asserts the
    // 2024-01-01 version is distinguishable.
    expect(Array.isArray(result) || typeof result === "object").toBe(true);
    // Must be possible to inspect 2024-01-01 entries:
    const v1Entries = Array.isArray(result)
      ? result.filter((r: any) => r.version === "2024-01-01")
      : (result as any)["2024-01-01"];
    expect(v1Entries).toBeDefined();
    expect(Array.isArray(v1Entries)).toBe(true);
  });

  it("includes routes added via endpoint().existed at older versions", () => {
    class RestoreLegacyRoute extends VersionChange {
      description = "legacy clients had GET /api/legacy-only";
      instructions = [endpoint("/api/legacy-only", ["GET"]).existed];
    }

    const router = new VersionedRouter({ prefix: "/api" });
    router.get("/users/:id", null, UserResp, async (req: any) => ({
      id: req.params.id,
      name: "alice",
    }));
    // Legacy route registered but marked deleted in head; existed restores it at 2024-01-01.
    // The route is stored at its prefixed path (/api/legacy-only), so that's
    // the path passed to onlyExistsInOlderVersions.
    router.get("/legacy-only", null, UserResp, async () => ({ id: "l", name: "legacy" }));
    router.onlyExistsInOlderVersions("/api/legacy-only", ["GET"]);

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-01-01", RestoreLegacyRoute),
        new Version("2024-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const v1 = dumpRouteTable(app, { version: "2024-01-01" });
    const v2 = dumpRouteTable(app, { version: "2025-01-01" });

    const v1Paths = v1.map((r: any) => r.path);
    const v2Paths = v2.map((r: any) => r.path);
    expect(v1Paths).toContain("/api/legacy-only");
    expect(v2Paths).not.toContain("/api/legacy-only");
  });

  it("filters by method + pathMatches combined (AND semantics)", () => {
    const app = makeApp();
    const table = dumpRouteTable(app, {
      version: "2025-01-01",
      method: "GET",
      pathMatches: "charges",  // no GET /charges — result empty
    });
    expect(table).toEqual([]);
  });
});
