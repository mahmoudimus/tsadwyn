/**
 * FAILING TEST — verifies the gap described in tsadwyn-issue-route-options-tags.md
 *
 * Today:
 *  - RouteDefinition.tags exists (router.ts:26) and flows into OpenAPI.
 *  - endpoint().had({tags}) can mutate tags per-version.
 *  - But RouteOptions has no `tags` field — consumers can't set tags
 *    at registration time.
 *
 * These tests turn green when:
 *  1. RouteOptions.tags is accepted at registration
 *  2. Those tags flow into RouteDefinition.tags
 *  3. OpenAPI output emits them as operation.tags
 *  4. endpoint().had({tags}) replaces the registration-time list
 *  5. Warn emitted for tags matching _TSADWYN prefix
 *  6. Tags are deduped at OpenAPI emission
 *
 * Run: npx vitest run tests/issue-route-options-tags.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";

import {
  Tsadwyn,
  Version,
  VersionBundle,
  VersionChange,
  VersionedRouter,
  endpoint,
} from "../src/index.js";

const ChargeRes = z
  .object({ id: z.string(), amount: z.number() })
  .named("IssueTags_ChargeRes");

describe("Issue: tags in RouteOptions", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("flows RouteOptions.tags into RouteDefinition.tags at registration", () => {
    const router = new VersionedRouter();

    router.post(
      "/billing/charge",
      null,
      ChargeRes,
      async () => ({ id: "c1", amount: 100 }),
      // GAP: `tags` is not a recognized option today
      { tags: ["Billing"] } as any,
    );

    const route = router.routes.find((r) => r.path === "/billing/charge");
    expect(route).toBeDefined();
    expect(route!.tags).toContain("Billing");
  });

  it("OpenAPI operation.tags reflects the registration-time tags", () => {
    const router = new VersionedRouter();
    router.post(
      "/billing/charge",
      null,
      ChargeRes,
      async () => ({ id: "c1", amount: 100 }),
      { tags: ["Billing"] } as any,
    );

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const doc = app.openapi("2024-01-01");
    const op = (doc.paths["/billing/charge"] as any)?.post;
    expect(op).toBeDefined();
    expect(op.tags).toEqual(["Billing"]);
  });

  it("groups multiple routes with the same tag in OpenAPI", () => {
    const router = new VersionedRouter();
    const billingOpts = { tags: ["Billing"] } as any;

    router.post("/billing/charge",  null, ChargeRes, async () => ({ id: "1", amount: 100 }), billingOpts);
    router.post("/billing/refund",  null, ChargeRes, async () => ({ id: "2", amount: 50  }), billingOpts);
    router.post("/billing/capture", null, ChargeRes, async () => ({ id: "3", amount: 100 }), billingOpts);

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const doc = app.openapi("2024-01-01");
    const paths = ["/billing/charge", "/billing/refund", "/billing/capture"];
    for (const p of paths) {
      const op = (doc.paths[p] as any)?.post;
      expect(op?.tags, `path ${p} missing or has no tags`).toEqual(["Billing"]);
    }
  });

  it("endpoint().had({tags}) replaces the registration-time tag list for older versions", () => {
    class LegacyTagging extends VersionChange {
      description =
        "legacy clients see the route tagged 'Billing' and 'Deprecated'";
      instructions = [
        endpoint("/billing/charge", ["POST"]).had({
          tags: ["Billing", "Deprecated"],
        }),
      ];
    }

    const router = new VersionedRouter();
    router.post(
      "/billing/charge",
      null,
      ChargeRes,
      async () => ({ id: "c1", amount: 100 }),
      { tags: ["Billing"] } as any,
    );

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-01-01", LegacyTagging),
        new Version("2024-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const headDoc = app.openapi("2025-01-01");
    const legacyDoc = app.openapi("2024-01-01");

    const headOp = (headDoc.paths["/billing/charge"] as any)?.post;
    const legacyOp = (legacyDoc.paths["/billing/charge"] as any)?.post;

    expect(headOp.tags).toEqual(["Billing"]);
    // Legacy clients see the replacement list
    expect(legacyOp.tags).toEqual(["Billing", "Deprecated"]);
  });

  it("emits a registration-time warn when a user-supplied tag starts with _TSADWYN", () => {
    const router = new VersionedRouter();
    router.post(
      "/billing/charge",
      null,
      ChargeRes,
      async () => ({ id: "c1", amount: 100 }),
      { tags: ["_TSADWYN_USER_MARKER"] } as any,
    );

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const warned = warnSpy.mock.calls.some((args) =>
      args.some(
        (a) =>
          typeof a === "string" &&
          /_TSADWYN/.test(a) &&
          /reserved/i.test(a),
      ),
    );
    expect(
      warned,
      `Expected a warn about the reserved _TSADWYN prefix. Got: ${JSON.stringify(warnSpy.mock.calls)}`,
    ).toBe(true);
  });

  it("deduplicates tags at OpenAPI emission", () => {
    const router = new VersionedRouter();
    router.post(
      "/billing/charge",
      null,
      ChargeRes,
      async () => ({ id: "c1", amount: 100 }),
      { tags: ["Billing", "Billing", "Commerce", "Commerce"] } as any,
    );

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const doc = app.openapi("2024-01-01");
    const op = (doc.paths["/billing/charge"] as any)?.post;
    expect(op?.tags).toEqual(["Billing", "Commerce"]);
  });

  it("no warn when tags field is omitted entirely", () => {
    const router = new VersionedRouter();
    router.post(
      "/billing/charge",
      null,
      ChargeRes,
      async () => ({ id: "c1", amount: 100 }),
      // no options at all
    );

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const warned = warnSpy.mock.calls.some((args) =>
      args.some((a) => typeof a === "string" && /_TSADWYN/.test(a)),
    );
    expect(warned).toBe(false);
  });
});
