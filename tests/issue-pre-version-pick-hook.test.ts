/**
 * FAILING TEST — verifies the gap described in tsadwyn-issue-pre-version-pick-hook.md
 *
 * Today: TsadwynOptions has no `preVersionPick` hook. The only way to run
 * consumer middleware before version pick is to supply the full
 * `versioningMiddleware` override, which forces consumers to re-implement
 * header extraction, default resolution, and apiVersionStorage scoping.
 *
 * These tests turn green when:
 *  1. preVersionPick runs before versionPickingMiddleware
 *  2. req.user set by preVersionPick is visible inside apiVersionDefaultValue
 *  3. Errors in preVersionPick propagate via next(err)
 *  4. Async preVersionPick is supported
 *  5. Combining with versioningMiddleware throws TsadwynStructureError
 *  6. apiVersionStorage is empty inside preVersionPick
 *
 * Run: npx vitest run tests/issue-pre-version-pick-hook.test.ts
 */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";

import {
  Tsadwyn,
  Version,
  VersionBundle,
  VersionedRouter,
  TsadwynStructureError,
  apiVersionStorage,
} from "../src/index.js";

describe("Issue: preVersionPick middleware hook", () => {
  it("runs before versionPickingMiddleware — default resolver sees req.user", async () => {
    const resolvedVersions: string[] = [];

    const router = new VersionedRouter();
    router.get("/whoami", null, null, async () => ({ ok: true }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-01-01"),
        new Version("2024-01-01"),
      ),
      // GAP: preVersionPick doesn't exist
      preVersionPick: (req: any, _res: any, next: any) => {
        req.user = { apiVersion: "2024-01-01" };
        next();
      },
      apiVersionDefaultValue: (req: any) => {
        const v = req.user?.apiVersion ?? "2025-01-01";
        resolvedVersions.push(v);
        return v;
      },
    } as any);
    app.generateAndIncludeVersionedRouters(router);

    await request(app.expressApp).get("/whoami");

    // Resolver saw the user-supplied version
    expect(resolvedVersions).toEqual(["2024-01-01"]);
  });

  it("propagates errors via next(err) without running versioned dispatch", async () => {
    const dispatchSpy = vi.fn();

    const router = new VersionedRouter();
    router.get("/whoami", null, null, async () => {
      dispatchSpy();
      return { ok: true };
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
      preVersionPick: (_req: any, _res: any, next: any) => {
        next(new Error("auth failed"));
      },
    } as any);
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .get("/whoami")
      .set("x-api-version", "2024-01-01");

    // Express default error handler returns 500 for unhandled errors
    expect(res.status).toBe(500);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("supports async preVersionPick (Promise-then-next pattern)", async () => {
    const router = new VersionedRouter();
    router.get("/whoami", null, null, async () => ({ ok: true }));

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
      preVersionPick: (req: any, _res: any, next: any) => {
        Promise.resolve()
          .then(() => {
            req.user = { apiVersion: "2024-01-01" };
          })
          .then(next);
      },
      apiVersionDefaultValue: (req: any) => req.user?.apiVersion ?? null,
    } as any);
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp).get("/whoami");
    expect(res.status).toBe(200);
  });

  it("apiVersionStorage.getStore() returns undefined inside preVersionPick", async () => {
    let storageInsideHook: string | null | undefined;

    const router = new VersionedRouter();
    router.get("/whoami", null, null, async () => ({ ok: true }));

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
      preVersionPick: (_req: any, _res: any, next: any) => {
        storageInsideHook = apiVersionStorage.getStore();
        next();
      },
    } as any);
    app.generateAndIncludeVersionedRouters(router);

    await request(app.expressApp)
      .get("/whoami")
      .set("x-api-version", "2024-01-01");

    // Version is NOT yet in storage during preVersionPick
    expect(storageInsideHook).toBeUndefined();
  });

  it("throws TsadwynStructureError when preVersionPick and versioningMiddleware are both set", () => {
    expect(() => {
      new Tsadwyn({
        versions: new VersionBundle(new Version("2024-01-01")),
        preVersionPick: (_req: any, _res: any, next: any) => next(),
        versioningMiddleware: (_req: any, _res: any, next: any) => next(),
      } as any);
    }).toThrow(TsadwynStructureError);
  });

  it("composes correctly with VersionedRouter.use() middleware (both run, in order)", async () => {
    const callOrder: string[] = [];

    const router = new VersionedRouter();
    router.use((_req: any, _res: any, next: any) => {
      callOrder.push("per-version-middleware");
      next();
    });
    router.get("/whoami", null, null, async () => {
      callOrder.push("handler");
      return { ok: true };
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
      preVersionPick: (_req: any, _res: any, next: any) => {
        callOrder.push("pre-version-pick");
        next();
      },
    } as any);
    app.generateAndIncludeVersionedRouters(router);

    await request(app.expressApp)
      .get("/whoami")
      .set("x-api-version", "2024-01-01");

    expect(callOrder).toEqual([
      "pre-version-pick",
      "per-version-middleware",
      "handler",
    ]);
  });

  it("runs only for requests that reach the versioned dispatch, not utility endpoints", async () => {
    const hookSpy = vi.fn((_req: any, _res: any, next: any) => next());

    const router = new VersionedRouter();
    router.get("/whoami", null, null, async () => ({ ok: true }));

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
      preVersionPick: hookSpy,
    } as any);
    app.generateAndIncludeVersionedRouters(router);

    // Utility endpoints — should NOT invoke preVersionPick
    await request(app.expressApp).get("/openapi.json?version=2024-01-01");
    expect(hookSpy).not.toHaveBeenCalled();

    // Versioned route — should invoke
    await request(app.expressApp)
      .get("/whoami")
      .set("x-api-version", "2024-01-01");
    expect(hookSpy).toHaveBeenCalledOnce();
  });
});
