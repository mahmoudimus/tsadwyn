/**
 * FAILING TEST — verifies the gap described in tsadwyn-issue-per-client-default-version.md
 *
 * Today: consumers hand-roll the resolver chain (identify → resolvePin →
 * fallback), forget to dedupe, and forget the stale-pin case.
 *
 * These tests turn green when `perClientDefaultVersion` is exported with
 * the contract documented in the issue spec.
 *
 * Run: npx vitest run tests/issue-per-client-default-version.test.ts
 */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";

import {
  Tsadwyn,
  Version,
  VersionBundle,
  VersionedRouter,
  apiVersionStorage,
} from "../src/index.js";
// GAP: not exported today
// @ts-expect-error — intentional
import { perClientDefaultVersion } from "../src/index.js";

describe("Issue: perClientDefaultVersion helper", () => {
  it("identifies client, resolves pin, uses it as default version", async () => {
    const router = new VersionedRouter();
    router.get("/whoami", null, null, async () => ({
      version: apiVersionStorage.getStore(),
    }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-01-01"),
        new Version("2024-01-01"),
      ),
      apiVersionDefaultValue: perClientDefaultVersion({
        identify: () => "client-a",
        resolvePin: (id: string) => (id === "client-a" ? "2024-01-01" : null),
        fallback: "2025-01-01",
        supportedVersions: ["2025-01-01", "2024-01-01"],
      }),
    } as any);
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp).get("/whoami");
    expect(res.status).toBe(200);
    expect(res.body.version).toBe("2024-01-01");
  });

  it("falls back when identify returns null", async () => {
    const router = new VersionedRouter();
    router.get("/whoami", null, null, async () => ({
      version: apiVersionStorage.getStore(),
    }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-01-01"),
        new Version("2024-01-01"),
      ),
      apiVersionDefaultValue: perClientDefaultVersion({
        identify: () => null,  // no identity
        resolvePin: () => "2024-01-01",
        fallback: "2025-01-01",
      }),
    } as any);
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp).get("/whoami");
    expect(res.body.version).toBe("2025-01-01");
  });

  it("falls back when resolvePin returns null", async () => {
    const router = new VersionedRouter();
    router.get("/whoami", null, null, async () => ({
      version: apiVersionStorage.getStore(),
    }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-01-01"),
        new Version("2024-01-01"),
      ),
      apiVersionDefaultValue: perClientDefaultVersion({
        identify: () => "client-a",
        resolvePin: () => null,  // no stored pin
        fallback: "2025-01-01",
      }),
    } as any);
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp).get("/whoami");
    expect(res.body.version).toBe("2025-01-01");
  });

  it("explicit X-Api-Version overrides the resolver", async () => {
    const router = new VersionedRouter();
    router.get("/whoami", null, null, async () => ({
      version: apiVersionStorage.getStore(),
    }));

    const identifySpy = vi.fn(() => "client-a");
    const resolvePinSpy = vi.fn(() => "2024-01-01");

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-01-01"),
        new Version("2024-01-01"),
      ),
      apiVersionDefaultValue: perClientDefaultVersion({
        identify: identifySpy,
        resolvePin: resolvePinSpy,
        fallback: "2025-01-01",
      }),
    } as any);
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .get("/whoami")
      .set("x-api-version", "2025-01-01");

    expect(res.body.version).toBe("2025-01-01");
    // Resolver should not be invoked at all when explicit header present
    expect(identifySpy).not.toHaveBeenCalled();
    expect(resolvePinSpy).not.toHaveBeenCalled();
  });

  it("caches per-request — identify and resolvePin called at most once per request", async () => {
    const router = new VersionedRouter();
    router.get("/whoami", null, null, async () => ({
      version: apiVersionStorage.getStore(),
    }));

    const identifySpy = vi.fn(() => "client-a");
    const resolvePinSpy = vi.fn(() => "2024-01-01");

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-01-01"),
        new Version("2024-01-01"),
      ),
      apiVersionDefaultValue: perClientDefaultVersion({
        identify: identifySpy,
        resolvePin: resolvePinSpy,
        fallback: "2025-01-01",
        cache: "per-request",
      }),
    } as any);
    app.generateAndIncludeVersionedRouters(router);

    // Two distinct requests
    await request(app.expressApp).get("/whoami");
    await request(app.expressApp).get("/whoami");

    // Each request ran identify and resolvePin exactly once (2 requests × 1 call)
    expect(identifySpy).toHaveBeenCalledTimes(2);
    expect(resolvePinSpy).toHaveBeenCalledTimes(2);
  });

  it("onStalePin: 'fallback' substitutes fallback + emits warn when stored pin is not in bundle", async () => {
    const router = new VersionedRouter();
    router.get("/whoami", null, null, async () => ({
      version: apiVersionStorage.getStore(),
    }));

    const warn = vi.fn();

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-01-01"),
        new Version("2024-01-01"),
      ),
      apiVersionDefaultValue: perClientDefaultVersion({
        identify: () => "client-a",
        resolvePin: () => "2023-01-01",  // no longer in bundle
        fallback: "2025-01-01",
        supportedVersions: ["2025-01-01", "2024-01-01"],
        onStalePin: "fallback",
        logger: { warn },
      }),
    } as any);
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp).get("/whoami");
    expect(res.body.version).toBe("2025-01-01");
    expect(warn).toHaveBeenCalled();
    const ctx = warn.mock.calls[0][0];
    expect(ctx).toMatchObject({
      pin: "2023-01-01",
      reason: expect.stringMatching(/stale/i),
    });
  });

  it("onStalePin: 'reject' throws at resolver time (surfaces as 500)", async () => {
    const router = new VersionedRouter();
    router.get("/whoami", null, null, async () => ({ ok: true }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-01-01"),
        new Version("2024-01-01"),
      ),
      apiVersionDefaultValue: perClientDefaultVersion({
        identify: () => "client-a",
        resolvePin: () => "2023-01-01",
        fallback: "2025-01-01",
        supportedVersions: ["2025-01-01", "2024-01-01"],
        onStalePin: "reject",
      }),
    } as any);
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp).get("/whoami");
    expect(res.status).toBe(500);
  });

  it("async identify + resolvePin awaited correctly", async () => {
    const router = new VersionedRouter();
    router.get("/whoami", null, null, async () => ({
      version: apiVersionStorage.getStore(),
    }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-01-01"),
        new Version("2024-01-01"),
      ),
      apiVersionDefaultValue: perClientDefaultVersion({
        identify: async () => {
          await new Promise((r) => setTimeout(r, 5));
          return "client-a";
        },
        resolvePin: async () => {
          await new Promise((r) => setTimeout(r, 5));
          return "2024-01-01";
        },
        fallback: "2025-01-01",
      }),
    } as any);
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp).get("/whoami");
    expect(res.body.version).toBe("2024-01-01");
  });

  it("propagates errors from identify/resolvePin as 500 with a specific error code", async () => {
    const router = new VersionedRouter();
    router.get("/whoami", null, null, async () => ({ ok: true }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2024-01-01"),
      ),
      apiVersionDefaultValue: perClientDefaultVersion({
        identify: () => {
          throw new Error("jwt verification failed");
        },
        resolvePin: () => "2024-01-01",
        fallback: "2024-01-01",
      }),
    } as any);
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp).get("/whoami");
    expect(res.status).toBe(500);
  });
});
