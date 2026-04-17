/**
 * FAILING TEST — verifies the gap described in tsadwyn-issue-migration-chain-inspector.md
 *
 * Today: no public API for introspecting which migrations fire for a
 * given schema + client version.
 *
 * These tests turn green when `inspectMigrationChain()` is exported.
 *
 * Run: npx vitest run tests/issue-migration-chain-inspector.test.ts
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
  convertResponseToPreviousVersionFor,
  convertRequestToNextVersionFor,
} from "../src/index.js";

// GAP: not exported
// @ts-expect-error — intentional
import { inspectMigrationChain } from "../src/index.js";

const Order = z
  .object({ id: z.string(), amount: z.number(), currency: z.string() })
  .named("IssueMigChain_Order");

describe("Issue: inspectMigrationChain()", () => {
  it("returns response migrations in head → client order", () => {
    class AddTaxField extends VersionChange {
      description = "AddTaxField at 2025-01-01";
      instructions = [];

      migrateResponse = convertResponseToPreviousVersionFor(Order)(
        (_res: ResponseInfo) => {},
      );
    }

    class RenameCurrency extends VersionChange {
      description = "RenameCurrency at 2025-06-01";
      instructions = [];

      migrateResponse = convertResponseToPreviousVersionFor(Order)(
        (_res: ResponseInfo) => {},
      );
    }

    const router = new VersionedRouter();
    router.get("/orders/:id", null, Order, async () => ({
      id: "o1",
      amount: 100,
      currency: "USD",
    }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-06-01", RenameCurrency),
        new Version("2025-01-01", AddTaxField),
        new Version("2024-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const chain = inspectMigrationChain(app, {
      schemaName: "IssueMigChain_Order",
      clientVersion: "2024-01-01",
      direction: "response",
    });

    // head → client ordering
    expect(chain.length).toBe(2);
    expect(chain[0].changeClassName).toBe("RenameCurrency");
    expect(chain[1].changeClassName).toBe("AddTaxField");
    expect(chain[0].order).toBe(0);
    expect(chain[1].order).toBe(1);
  });

  it("returns request migrations in client → head order", () => {
    class AddCurrencyField extends VersionChange {
      description = "AddCurrencyField at 2025-01-01";
      instructions = [];

      migrateRequest = convertRequestToNextVersionFor(Order)(
        (_req: RequestInfo) => {},
      );
    }

    class NormalizeAmount extends VersionChange {
      description = "NormalizeAmount at 2025-06-01";
      instructions = [];

      migrateRequest = convertRequestToNextVersionFor(Order)(
        (_req: RequestInfo) => {},
      );
    }

    const router = new VersionedRouter();
    router.post("/orders", Order, Order, async () => ({
      id: "o1",
      amount: 100,
      currency: "USD",
    }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-06-01", NormalizeAmount),
        new Version("2025-01-01", AddCurrencyField),
        new Version("2024-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const chain = inspectMigrationChain(app, {
      schemaName: "IssueMigChain_Order",
      clientVersion: "2024-01-01",
      direction: "request",
    });

    expect(chain.length).toBe(2);
    // client → head ordering
    expect(chain[0].changeClassName).toBe("AddCurrencyField");
    expect(chain[1].changeClassName).toBe("NormalizeAmount");
  });

  it("returns empty array when no migrations match the schema", () => {
    class NoOp extends VersionChange {
      description = "no migrations targeting Order";
      instructions = [];
    }

    const router = new VersionedRouter();
    router.get("/orders/:id", null, Order, async () => ({
      id: "o1",
      amount: 100,
      currency: "USD",
    }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-01-01", NoOp),
        new Version("2024-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const chain = inspectMigrationChain(app, {
      schemaName: "IssueMigChain_Order",
      clientVersion: "2024-01-01",
      direction: "response",
    });

    expect(chain).toEqual([]);
  });

  it("includes path-based migrations alongside schema-based ones", () => {
    class SchemaBased extends VersionChange {
      description = "schema-based migration on Order";
      instructions = [];

      migrateResponse = convertResponseToPreviousVersionFor(Order)(
        (_res: ResponseInfo) => {},
      );
    }

    class PathBased extends VersionChange {
      description = "path-based migration on /orders/:id GET";
      instructions = [];

      migrateResponse = convertResponseToPreviousVersionFor("/orders/:id", ["GET"])(
        (_res: ResponseInfo) => {},
      );
    }

    const router = new VersionedRouter();
    router.get("/orders/:id", null, Order, async () => ({
      id: "o1",
      amount: 100,
      currency: "USD",
    }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-06-01", PathBased),
        new Version("2025-01-01", SchemaBased),
        new Version("2024-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const chain = inspectMigrationChain(app, {
      schemaName: "IssueMigChain_Order",
      clientVersion: "2024-01-01",
      direction: "response",
      path: "/orders/:id",
      method: "GET",
    });

    const kinds = chain.map((e: any) => e.kind);
    expect(kinds).toContain("schema-based");
    expect(kinds).toContain("path-based");
  });

  it("filters out migrateHttpErrors entries when includeErrorMigrations: false", () => {
    class ErrorMig extends VersionChange {
      description = "error-only migration";
      instructions = [];

      migrate = convertResponseToPreviousVersionFor(Order, { migrateHttpErrors: true })(
        (_res: ResponseInfo) => {},
      );
    }

    class SuccessMig extends VersionChange {
      description = "success-only migration (opts out of error responses)";
      instructions = [];

      // Default is migrateHttpErrors: true now. Opt out so this migration
      // is a clean 'success-only' example for the includeErrorMigrations
      // filter test.
      migrate = convertResponseToPreviousVersionFor(Order, { migrateHttpErrors: false })(
        (_res: ResponseInfo) => {},
      );
    }

    const router = new VersionedRouter();
    router.get("/orders/:id", null, Order, async () => ({
      id: "o1",
      amount: 100,
      currency: "USD",
    }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-06-01", SuccessMig),
        new Version("2025-01-01", ErrorMig),
        new Version("2024-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const all = inspectMigrationChain(app, {
      schemaName: "IssueMigChain_Order",
      clientVersion: "2024-01-01",
      direction: "response",
    });
    expect(all.length).toBe(2);

    const successOnly = inspectMigrationChain(app, {
      schemaName: "IssueMigChain_Order",
      clientVersion: "2024-01-01",
      direction: "response",
      includeErrorMigrations: false,
    });
    expect(successOnly.length).toBe(1);
    expect(successOnly[0].changeClassName).toBe("SuccessMig");
  });

  it("throws when schemaName isn't registered in any route or instruction", () => {
    const router = new VersionedRouter();
    router.get("/orders/:id", null, Order, async () => ({
      id: "o1",
      amount: 100,
      currency: "USD",
    }));

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    expect(() =>
      inspectMigrationChain(app, {
        schemaName: "DoesNotExist",
        clientVersion: "2024-01-01",
        direction: "response",
      }),
    ).toThrow();
  });

  it("throws when clientVersion isn't in the bundle", () => {
    const router = new VersionedRouter();
    router.get("/orders/:id", null, Order, async () => ({
      id: "o1",
      amount: 100,
      currency: "USD",
    }));

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    expect(() =>
      inspectMigrationChain(app, {
        schemaName: "IssueMigChain_Order",
        clientVersion: "1999-01-01",
        direction: "response",
      }),
    ).toThrow();
  });

  it("returns path-based REQUEST migrations in client → head order when direction='request' + path is supplied", () => {
    class PathBasedRequestMig extends VersionChange {
      description = "path-based request migration on POST /orders at 2025-01-01";
      instructions = [];

      r1 = convertRequestToNextVersionFor("/orders", ["POST"])(
        (_req: RequestInfo) => {},
      );
    }

    const router = new VersionedRouter();
    router.post("/orders", Order, Order, async () => ({
      id: "o1",
      amount: 100,
      currency: "USD",
    }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-01-01", PathBasedRequestMig),
        new Version("2024-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const chain = inspectMigrationChain(app, {
      schemaName: "IssueMigChain_Order",
      clientVersion: "2024-01-01",
      direction: "request",
      path: "/orders",
      method: "POST",
    });

    const pathBased = chain.filter((e: any) => e.kind === "path-based");
    expect(pathBased.length).toBe(1);
    expect(pathBased[0]).toMatchObject({
      version: "2025-01-01",
      changeClassName: "PathBasedRequestMig",
      kind: "path-based",
      path: "/orders",
    });
    expect(pathBased[0].methods).toContain("POST");
  });

  it("path-based REQUEST migration method filter excludes non-matching methods", () => {
    class OnlyPostMig extends VersionChange {
      description = "path-based request migration on POST only";
      instructions = [];

      r1 = convertRequestToNextVersionFor("/orders", ["POST"])(
        (_req: RequestInfo) => {},
      );
    }

    const router = new VersionedRouter();
    router.post("/orders", Order, Order, async () => ({
      id: "o1",
      amount: 100,
      currency: "USD",
    }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-01-01", OnlyPostMig),
        new Version("2024-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    // Filter by GET — the POST-only path-based migration should NOT appear.
    const chain = inspectMigrationChain(app, {
      schemaName: "IssueMigChain_Order",
      clientVersion: "2024-01-01",
      direction: "request",
      path: "/orders",
      method: "GET",
    });

    const pathBased = chain.filter((e: any) => e.kind === "path-based");
    expect(pathBased.length).toBe(0);
  });

  it("entries include changeClassName, kind, and order for rendering", () => {
    class Mig extends VersionChange {
      description = "some migration";
      instructions = [];

      migrate = convertResponseToPreviousVersionFor(Order)(
        (_res: ResponseInfo) => {},
      );
    }

    const router = new VersionedRouter();
    router.get("/orders/:id", null, Order, async () => ({
      id: "o1",
      amount: 100,
      currency: "USD",
    }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-01-01", Mig),
        new Version("2024-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const chain = inspectMigrationChain(app, {
      schemaName: "IssueMigChain_Order",
      clientVersion: "2024-01-01",
      direction: "response",
    });

    expect(chain[0]).toMatchObject({
      version: "2025-01-01",
      changeClassName: "Mig",
      kind: "schema-based",
      schemaName: "IssueMigChain_Order",
      order: 0,
    });
  });
});
