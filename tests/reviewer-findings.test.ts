/**
 * Failing tests derived from the 2026-04 expert code review of PR #4.
 *
 * Each `describe` block corresponds to one review finding. Tests are
 * EXPECTED TO FAIL against HEAD — they lock in the gap so the bug can't
 * quietly re-emerge after the fix lands.
 *
 * Status legend in comments:
 *   🔴 HIGH    — real correctness bug, merge-blocking
 *   🟡 MEDIUM  — design hazard, worth fixing before v0.2
 *
 * Each test file-level comment names the file + line of the bug so the
 * reviewer / future-maintainer can correlate failing assertion → code.
 *
 * Run: npx vitest run tests/reviewer-findings.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { z } from "zod";

import {
  Tsadwyn,
  Version,
  VersionBundle,
  VersionChange,
  VersionedRouter,
  ResponseInfo,
  convertResponseToPreviousVersionFor,
  migratePayloadToVersion,
  cachedPerClientDefaultVersion,
  currentRequest,
  raw,
} from "../src/index.js";

// ────────────────────────────────────────────────────────────────────────────
// 🔴 HIGH #1 — onStartup async rejection is silently swallowed
// Location: src/application.ts:666
// Bug: `this._onStartup()` is called without a `.catch` handler, so a
// rejecting async onStartup becomes an unhandled Promise rejection → Node
// 20+ terminates the process. `onShutdown` handles this correctly (441-445)
// but `onStartup` does not.
// ────────────────────────────────────────────────────────────────────────────
describe("Finding #1 (HIGH): onStartup async rejection handling", () => {
  let unhandled: unknown[];
  const handler = (reason: unknown) => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    unhandled = [];
    process.on("unhandledRejection", handler);
  });

  afterEach(() => {
    process.off("unhandledRejection", handler);
  });

  it("does not produce an unhandled rejection when onStartup rejects", async () => {
    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
      onStartup: async () => {
        throw new Error("startup-failed-intentionally");
      },
    });
    const router = new VersionedRouter();
    router.get("/x", null, null, async () => ({ ok: true }));
    app.generateAndIncludeVersionedRouters(router);

    // Let the microtask queue drain so the rejection lands either on the
    // process hook (broken) or on an internal .catch (fixed).
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const startupFailures = unhandled.filter(
      (r) => r instanceof Error && r.message === "startup-failed-intentionally",
    );
    expect(startupFailures).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 🔴 HIGH #2 — migratePayloadToVersion skips path-based response migrations
// Location: src/migrate-payload.ts:55-62
// Bug: the function only iterates `_alterResponseBySchemaInstructions`.
// Any migration registered via `convertResponseToPreviousVersionFor(path,
// methods)` is silently skipped when a consumer calls migratePayloadToVersion
// for outbound webhooks/events — resulting in unmigrated payloads reaching
// older clients with no error.
// ────────────────────────────────────────────────────────────────────────────
describe("Finding #2 (HIGH): migratePayloadToVersion applies path-based migrations", () => {
  it("transforms the payload when only a path-based migration exists", () => {
    const WebhookEvent = z
      .object({
        id: z.string(),
        event_type: z.string(),
        amount: z.number(),
      })
      .named("Finding2_WebhookEvent");

    class RenameEventType extends VersionChange {
      description = "renames event_type → type on older version (path-based)";
      instructions = [];

      // Path-based registration: consumer keyed on the route, not the schema.
      migrateWebhook = convertResponseToPreviousVersionFor("/webhooks/events", ["POST"])(
        (response: ResponseInfo) => {
          if (response.body && typeof response.body === "object") {
            response.body.type = response.body.event_type;
            delete response.body.event_type;
          }
        },
      );
    }

    const router = new VersionedRouter();
    router.post("/webhooks/events", WebhookEvent, WebhookEvent, async () => ({
      id: "evt_1",
      event_type: "charge.succeeded",
      amount: 100,
    }));

    const versions = new VersionBundle(
      new Version("2025-06-01", RenameEventType),
      new Version("2024-01-01"),
    );

    const head = {
      id: "evt_1",
      event_type: "charge.succeeded",
      amount: 100,
    };
    const migrated = migratePayloadToVersion(
      "Finding2_WebhookEvent",
      head,
      "2024-01-01",
      versions,
    );

    // The path-based migration SHOULD have renamed event_type → type.
    expect(migrated).toEqual({
      id: "evt_1",
      type: "charge.succeeded",
      amount: 100,
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 🟡 MEDIUM #3 — HEAD requests receive bodies on non-JSON / string responses
// Location: src/route-generation.ts:1215-1252
// Bug: the `isHead = req.method === "HEAD"` guard is computed at line 1265,
// AFTER the non-JSON (Buffer/Readable) branch at 1215 and the string branch
// at 1221. Those branches call sendNonJsonResponse/res.end unconditionally,
// violating RFC 7231 §4.3.2 ("the server MUST NOT send a message body in
// the response"). The JSON path at 1350 correctly suppresses via isHead.
// ────────────────────────────────────────────────────────────────────────────
describe("Finding #3 (MEDIUM): HEAD requests do not send a body on non-JSON responses", () => {
  function simpleApp() {
    const router = new VersionedRouter();

    router.head("/download", null, raw({ mimeType: "application/octet-stream" }), async () => {
      return Buffer.from("secret-payload-should-not-ship", "utf-8");
    });

    router.head("/text", null, null, async () => {
      return "text-payload-should-not-ship";
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);
    return app;
  }

  it("Buffer response on HEAD: no body on the wire", async () => {
    const app = simpleApp();
    const res = await request(app.expressApp)
      .head("/download")
      .set("x-api-version", "2024-01-01");

    expect(res.status).toBe(200);
    // supertest's body on HEAD is a Buffer; length 0 means no body was sent.
    // Accept empty Buffer, empty string, or undefined — all represent "no body".
    const bodyLength =
      res.body instanceof Buffer
        ? res.body.length
        : typeof res.body === "string"
          ? res.body.length
          : res.body == null
            ? 0
            : JSON.stringify(res.body).length;
    expect(bodyLength).toBe(0);
  });

  it("string response on HEAD: no body on the wire", async () => {
    const app = simpleApp();
    const res = await request(app.expressApp)
      .head("/text")
      .set("x-api-version", "2024-01-01");

    expect(res.status).toBe(200);
    expect(res.text ?? "").toBe("");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 🟡 MEDIUM #4 — onUnsupportedVersion / versionPickingLogger not forwarded
// Locations:
//   src/middleware.ts:41 (defines VersionPickingOptions.onUnsupportedVersion)
//   src/application.ts:418-424 (pickingOpts build; doesn't copy the field)
// Bug: Consumers using `new Tsadwyn({...})` cannot configure the policy.
// The option only works if they opt into `versioningMiddleware` override,
// which forces them to re-implement header extraction, default resolution,
// and apiVersionStorage scoping.
// ────────────────────────────────────────────────────────────────────────────
describe("Finding #4 (MEDIUM): onUnsupportedVersion wired through TsadwynOptions", () => {
  it("TsadwynOptions.onUnsupportedVersion='reject' produces a structured 400", async () => {
    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
      // Cast to any because the field isn't in TsadwynOptions yet (that's
      // the gap). Once the option is plumbed through the type should accept
      // it and this cast can be removed.
      ...({
        onUnsupportedVersion: "reject",
      } as any),
    });
    const router = new VersionedRouter();
    router.get("/ping", null, null, async () => ({ ok: true }));
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .get("/ping")
      .set("x-api-version", "9999-99-99");

    // Current behavior: dispatcher returns 422 because the option is ignored.
    // Expected behavior: the middleware's `reject` policy fires → 400 with
    // a structured body per `src/middleware.ts:134-141`.
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "unsupported_api_version",
      sent: "9999-99-99",
      supported: ["2024-01-01"],
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 🟡 MEDIUM #5 — SIGTERM/SIGINT listener accumulation
// Location: src/application.ts:439-440
// Bug: Every Tsadwyn instance with an onShutdown hook registers a permanent
// listener. After ~11 instances Node emits MaxListenersExceededWarning. In
// test suites (where many apps are constructed) every SIGTERM triggers all
// accumulated handlers and calls process.exit(0), which can mask failures.
// ────────────────────────────────────────────────────────────────────────────
describe("Finding #5 (MEDIUM): SIGTERM listeners do not accumulate per instance", () => {
  it("constructing 15 Tsadwyn instances does not add 15 SIGTERM listeners", () => {
    const before = process.listenerCount("SIGTERM");

    for (let i = 0; i < 15; i++) {
      const app = new Tsadwyn({
        versions: new VersionBundle(new Version("2024-01-01")),
        onShutdown: () => {},
      });
      // Sanity: exercise the object so the cache isn't accidentally GC'd mid-loop.
      void app.expressApp;
    }

    const after = process.listenerCount("SIGTERM");
    // Fix should either reuse a single module-level listener, or expose a
    // close()/destroy() method plus test-time cleanup. Either way, the
    // delta should stay at a small constant (≤ 1), NOT scale with instance count.
    expect(after - before).toBeLessThanOrEqual(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 🟡 MEDIUM #7 — currentRequest() silently broken on unversioned routes
// Location: src/application.ts `_wrapHandlerWithOverrides` (lines 586-608)
// Bug: Versioned route dispatch wraps the handler body in
// requestContextStorage.run(req, ...). Unversioned routes go through
// `_wrapHandlerWithOverrides`, which calls `handler(handlerReq)` directly —
// no ALS scope. A handler or service helper that calls `currentRequest()`
// throws "called outside a tsadwyn handler scope".
// ────────────────────────────────────────────────────────────────────────────
describe("Finding #7 (MEDIUM): currentRequest() works on unversioned routes", () => {
  it("handler on app.unversionedRouter can call currentRequest() without error", async () => {
    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
      preVersionPick: (req, _res, next) => {
        (req as any).user = { id: "unversioned_user" };
        next();
      },
    });

    app.unversionedRouter.get("/health", null, null, async () => {
      // This is the whole point of currentRequest(): recover middleware-
      // injected state from inside the stripped handler view.
      const req = currentRequest();
      return { user: (req as any).user?.id ?? "missing" };
    });

    // Register an empty versioned router so generation runs.
    const versionedRouter = new VersionedRouter();
    versionedRouter.get("/_placeholder", null, null, async () => ({}));
    app.generateAndIncludeVersionedRouters(versionedRouter);

    const res = await request(app.expressApp).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: "unversioned_user" });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 🟡 MEDIUM #8 — onStalePin='reject' per-call retry count is untested
// Location: src/cached-per-client-default.ts (rejection-bypass semantics)
// Documented contract: "Errors bypass the cache — the next request retries
// fresh." The code does this correctly (rejections delete the cache entry).
// But no test locks in the per-call count, so a future author could cache
// rejections (e.g., for back-off) without any test catching the regression.
// This adds the assertion.
// ────────────────────────────────────────────────────────────────────────────
describe("Finding #8 (MEDIUM): onStalePin='reject' retries resolvePin on every call", () => {
  it("resolvePin is invoked once per request (not cached)", async () => {
    const resolvePin = vi.fn(async () => "ancient-version");
    const { resolver } = cachedPerClientDefaultVersion({
      identify: (req: any) => req.__clientId,
      resolvePin,
      fallback: "2024-01-01",
      supportedVersions: ["2024-01-01"],
      onStalePin: "reject",
    });

    const fakeReq = (id: string) =>
      ({ headers: {}, ["__clientId"]: id }) as unknown as import("express").Request;

    // Each call should reject with the stale-pin error AND re-hit resolvePin.
    for (let i = 0; i < 3; i++) {
      await expect(resolver(fakeReq("client_1"))).rejects.toThrow(
        /not in the current VersionBundle/i,
      );
    }
    expect(resolvePin).toHaveBeenCalledTimes(3);
  });
});
