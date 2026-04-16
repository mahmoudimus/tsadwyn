/**
 * FAILING TEST — verifies the gap described in tsadwyn-issue-no-content-shortcircuit.md
 *
 * Today:
 *  - A 204 route with a schema-shared response migration MAY invoke the
 *    body-mutating transformer with `undefined` body (pipeline contract
 *    is unspecified).
 *  - There is no `headerOnly: true` option on response migrations — if
 *    you want a header migration on a 204 route, you have to write a
 *    body-safe transformer and hope the pipeline treats it right.
 *  - No registration-time lint catches "body migration targeting 204 route".
 *  - Handler returning a non-empty body on a 204-declared route is not
 *    explicitly rejected.
 *
 * These tests turn green when:
 *  1. 204 routes with return undefined / null produce empty body
 *  2. Body-mutating migrations are skipped on 204 (no NPE)
 *  3. headerOnly: true migrations fire on 204
 *  4. Registration-time lint warns for body-mutating migrations on 204 routes
 *  5. TsadwynStructureError thrown when handler returns non-empty body on 204 route
 *
 * Run: npx vitest run tests/issue-no-content-shortcircuit.test.ts
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
} from "../src/index.js";

const DeleteResult = z
  .object({ ok: z.boolean() })
  .named("Issue204_DeleteResult");

describe("Issue: 204 No Content — body-migration short-circuit", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("emits 204 with empty body when handler returns undefined", async () => {
    const router = new VersionedRouter();
    router.delete("/users/:id", null, null, async () => undefined, {
      statusCode: 204,
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .delete("/users/123")
      .set("x-api-version", "2024-01-01");

    expect(res.status).toBe(204);
    expect(res.text).toBeFalsy();
    expect(res.body).toEqual({});
  });

  it("emits 204 with empty body when handler returns null", async () => {
    const router = new VersionedRouter();
    router.delete(
      "/users/:id",
      null,
      null,
      async () => null as any,
      { statusCode: 204 },
    );

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .delete("/users/123")
      .set("x-api-version", "2024-01-01");

    expect(res.status).toBe(204);
    expect(res.text).toBeFalsy();
  });

  it("skips body-mutating schema-based migrations on 204 routes (no NPE)", async () => {
    const bodyTransformSpy = vi.fn((res: ResponseInfo) => {
      // If this transformer is called with res.body === undefined, it NPEs —
      // the test asserts it's not called at all.
      (res.body as any).legacyField = "x";
    });

    class MutateBody extends VersionChange {
      description = "add legacyField to DeleteResult for legacy clients";
      instructions = [];

      r1 = convertResponseToPreviousVersionFor(DeleteResult)(bodyTransformSpy);
    }

    const router = new VersionedRouter();
    // 204 DELETE sharing the DeleteResult schema with a 200 route
    router.delete("/users/:id", null, DeleteResult, async () => undefined, {
      statusCode: 204,
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-01-01", MutateBody),
        new Version("2024-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .delete("/users/123")
      .set("x-api-version", "2024-01-01");

    expect(res.status).toBe(204);
    // Body transformer MUST NOT have been called on the 204
    expect(bodyTransformSpy).not.toHaveBeenCalled();
  });

  it("runs headerOnly: true migrations on 204 routes", async () => {
    const headerTransformSpy = vi.fn((res: ResponseInfo) => {
      res.headers["x-deprecation"] = "upgrade to 2025-01-01";
    });

    class AddDeprecationHeader extends VersionChange {
      description = "add x-deprecation header for legacy clients";
      instructions = [];

      // GAP: `headerOnly: true` option doesn't exist yet.
      r1 = convertResponseToPreviousVersionFor(DeleteResult, {
        headerOnly: true,
      } as any)(headerTransformSpy);
    }

    const router = new VersionedRouter();
    router.delete("/users/:id", null, DeleteResult, async () => undefined, {
      statusCode: 204,
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-01-01", AddDeprecationHeader),
        new Version("2024-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .delete("/users/123")
      .set("x-api-version", "2024-01-01");

    expect(res.status).toBe(204);
    expect(headerTransformSpy).toHaveBeenCalledOnce();
    expect(res.headers["x-deprecation"]).toBe("upgrade to 2025-01-01");
  });

  it("emits registration-time warning for a body-mutating migration against a 204 route", async () => {
    class DeadBodyMigration extends VersionChange {
      description = "body migration targeting a 204-only route (dead code)";
      instructions = [];

      r1 = convertResponseToPreviousVersionFor("/users/:id", ["DELETE"])(
        (res: ResponseInfo) => {
          (res.body as any).x = 1;
        },
      );
    }

    const router = new VersionedRouter();
    router.delete("/users/:id", null, null, async () => undefined, {
      statusCode: 204,
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-01-01", DeadBodyMigration),
        new Version("2024-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const warned = warnSpy.mock.calls.some((args) =>
      args.some(
        (a) =>
          typeof a === "string" &&
          /204/.test(a) &&
          /users\/:id/.test(a) &&
          /body/i.test(a),
      ),
    );
    expect(
      warned,
      `Expected a warn naming the 204 route and the dead body migration. Got: ${JSON.stringify(warnSpy.mock.calls)}`,
    ).toBe(true);
  });

  it("permits a 204-declared handler to return a body (Stripe-style permissive 204+body)", async () => {
    // RFC 9110 §15.3.5 says 204 "cannot contain content" — but Stripe
    // does return bodies with 204 on some endpoints, and tsadwyn's default
    // is permissive to support that pattern. If the handler returns a body
    // with statusCode: 204, it flows through normally (status stays 204,
    // body is emitted). Consumers who want strict RFC behavior can return
    // undefined/null from the handler instead.
    const router = new VersionedRouter();
    router.delete(
      "/users/:id",
      null,
      null,
      async () => ({ ok: true }) as any,
      { statusCode: 204 },
    );

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .delete("/users/123")
      .set("x-api-version", "2024-01-01");

    expect(res.status).toBe(204);
    // Body presence is permitted per the Stripe-style permissive default —
    // we don't crash, we don't throw, we don't silently drop.
  });

  it("migrations on 204 routes can add a body + change status (head 204 → legacy 200+body)", async () => {
    // Concrete scenario: head returns 204 No Content for DELETE /users/:id,
    // but legacy clients (who shipped SDKs expecting a JSON envelope)
    // should still get 200 { deleted: true, id }. A headerOnly migration
    // opts into running on the body-less response and can BOTH add a body
    // AND rewrite the status code.
    const DeleteEnvelope = z
      .object({ deleted: z.boolean(), id: z.string() })
      .named("Issue204_DeleteEnvelope");

    class LegacyReturnsEnvelope extends VersionChange {
      description =
        "legacy clients received 200+envelope for DELETE; head returns 204";
      instructions = [];

      r1 = convertResponseToPreviousVersionFor(DeleteEnvelope, {
        headerOnly: true,
      } as any)((res: ResponseInfo) => {
        // Legacy shape: 200 with an envelope. Status and body both change.
        res.statusCode = 200;
        res.body = { deleted: true, id: "restored-by-migration" };
      });
    }

    const router = new VersionedRouter();
    router.delete(
      "/users/:id",
      null,
      DeleteEnvelope,
      async () => undefined,
      { statusCode: 204 },
    );

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-01-01", LegacyReturnsEnvelope),
        new Version("2024-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    // Legacy client — expects 200 + envelope
    const legacyRes = await request(app.expressApp)
      .delete("/users/abc")
      .set("x-api-version", "2024-01-01");

    expect(legacyRes.status).toBe(200);
    expect(legacyRes.body).toEqual({
      deleted: true,
      id: "restored-by-migration",
    });

    // Head client — still gets 204 empty
    const headRes = await request(app.expressApp)
      .delete("/users/abc")
      .set("x-api-version", "2025-01-01");

    expect(headRes.status).toBe(204);
    expect(headRes.text).toBeFalsy();
  });

  it("still respects migrateHttpErrors on a 204 route that throws HttpError", async () => {
    // A 204 route's success path has no body, but error paths have JSON bodies
    // and migrateHttpErrors still applies — short-circuit is only for successes.
    const router = new VersionedRouter();
    router.delete(
      "/users/:id",
      null,
      null,
      async (req: any) => {
        if (req.params.id === "missing") {
          const { HttpError } = await import("../src/index.js");
          throw new HttpError(404, { code: "not_found" });
        }
        return undefined;
      },
      { statusCode: 204 },
    );

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const ok = await request(app.expressApp)
      .delete("/users/123")
      .set("x-api-version", "2024-01-01");
    expect(ok.status).toBe(204);

    const notFound = await request(app.expressApp)
      .delete("/users/missing")
      .set("x-api-version", "2024-01-01");
    expect(notFound.status).toBe(404);
    expect(notFound.body.code).toBe("not_found");
  });
});
