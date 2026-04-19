/**
 * Tests for `currentRequest()` — request-scoped access to the raw Express
 * Request from inside tsadwyn handlers + migration callbacks.
 *
 * Covers:
 *   - Handler reads a middleware-injected field on req.
 *   - Access survives through awaited async sub-calls.
 *   - Migration callbacks (convertRequest / convertResponse) see the req.
 *   - Throw-outside-request: bare call without an active dispatch errors.
 *   - Two concurrent requests don't bleed context between each other.
 *   - currentRequestOrNull() returns null outside a dispatch scope.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { z } from "zod";

import {
  Tsadwyn,
  Version,
  VersionBundle,
  VersionChange,
  VersionedRouter,
  RequestInfo,
  ResponseInfo,
  convertRequestToNextVersionFor,
  convertResponseToPreviousVersionFor,
  currentRequest,
  currentRequestOrNull,
} from "../src/index.js";

const Echo = z.object({ seen: z.string() }).named("CurrentReq_Echo");

describe("currentRequest()", () => {
  it("lets a handler read an Express-middleware-injected field off req", async () => {
    const router = new VersionedRouter();
    router.get("/me", null, Echo, async () => {
      // `req.user` was set by the middleware below; tsadwyn's stripped
      // handler view doesn't include it, so we recover via currentRequest().
      const req = currentRequest();
      return { seen: (req as any).user?.id ?? "anonymous" };
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
      preVersionPick: (req, _res, next) => {
        (req as any).user = { id: "user_42" };
        next();
      },
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .get("/me")
      .set("x-api-version", "2024-01-01");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ seen: "user_42" });
  });

  it("propagates through awaited async sub-calls", async () => {
    async function readerAfterAwait(): Promise<string> {
      await new Promise((r) => setImmediate(r));
      return (currentRequest() as any).user?.id ?? "none";
    }

    const router = new VersionedRouter();
    router.get("/deep", null, Echo, async () => {
      const seen = await readerAfterAwait();
      return { seen };
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
      preVersionPick: (req, _res, next) => {
        (req as any).user = { id: "deep_user" };
        next();
      },
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .get("/deep")
      .set("x-api-version", "2024-01-01");

    expect(res.body).toEqual({ seen: "deep_user" });
  });

  it("exposes the raw req to request-migration callbacks", async () => {
    const seen: string[] = [];

    class ObserveRequest extends VersionChange {
      description = "observes currentRequest() from a request migration";
      instructions = [];
      migrateRequest = convertRequestToNextVersionFor(Echo)(
        (_req: RequestInfo) => {
          seen.push((currentRequest() as any).user?.id ?? "missing");
        },
      );
    }

    const router = new VersionedRouter();
    router.post("/things", Echo, Echo, async () => ({ seen: "handler" }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-01-01", ObserveRequest),
        new Version("2024-01-01"),
      ),
      preVersionPick: (req, _res, next) => {
        (req as any).user = { id: "mig_reader" };
        next();
      },
    });
    app.generateAndIncludeVersionedRouters(router);

    await request(app.expressApp)
      .post("/things")
      .set("x-api-version", "2024-01-01")
      .send({ seen: "client" });

    expect(seen).toEqual(["mig_reader"]);
  });

  it("exposes the raw req to response-migration callbacks", async () => {
    const seen: string[] = [];

    class ObserveResponse extends VersionChange {
      description = "observes currentRequest() from a response migration";
      instructions = [];
      migrateResponse = convertResponseToPreviousVersionFor(Echo)(
        (_res: ResponseInfo) => {
          seen.push((currentRequest() as any).user?.id ?? "missing");
        },
      );
    }

    const router = new VersionedRouter();
    router.get("/things/:id", null, Echo, async () => ({ seen: "handler" }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-01-01", ObserveResponse),
        new Version("2024-01-01"),
      ),
      preVersionPick: (req, _res, next) => {
        (req as any).user = { id: "resp_reader" };
        next();
      },
    });
    app.generateAndIncludeVersionedRouters(router);

    await request(app.expressApp)
      .get("/things/abc")
      .set("x-api-version", "2024-01-01");

    expect(seen).toEqual(["resp_reader"]);
  });

  it("throws when called outside a tsadwyn handler scope", () => {
    expect(() => currentRequest()).toThrow(/outside a tsadwyn handler scope/i);
  });

  it("returns null from currentRequestOrNull() outside a scope", () => {
    expect(currentRequestOrNull()).toBeNull();
  });

  it("keeps two concurrent requests' contexts isolated", async () => {
    const router = new VersionedRouter();
    router.get("/who", null, Echo, async () => {
      // Insert a microtask to give the event loop a chance to interleave.
      await new Promise((r) => setImmediate(r));
      return { seen: (currentRequest() as any).user?.id ?? "none" };
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
      preVersionPick: (req, _res, next) => {
        const header = req.headers["x-who"];
        (req as any).user = { id: typeof header === "string" ? header : "anon" };
        next();
      },
    });
    app.generateAndIncludeVersionedRouters(router);

    const [a, b] = await Promise.all([
      request(app.expressApp).get("/who").set("x-api-version", "2024-01-01").set("x-who", "alice"),
      request(app.expressApp).get("/who").set("x-api-version", "2024-01-01").set("x-who", "bob"),
    ]);

    expect(a.body).toEqual({ seen: "alice" });
    expect(b.body).toEqual({ seen: "bob" });
  });
});
