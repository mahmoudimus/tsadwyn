/**
 * Covers explicit HEAD method support in `VersionedRouter`:
 *
 *   1. `VersionedRouter.head()` exists with the same signature as `.get()`.
 *   2. The generated handler skips response-body migrations when
 *      `req.method === 'HEAD'` (no wire body to mutate).
 *   3. Header-only migrations still fire on HEAD.
 *   4. `migrateHttpErrors` applies on HEAD error paths (status + headers,
 *      no body).
 *   5. 405 with an `Allow` header is returned when HEAD is requested on a
 *      path with no matching GET.
 *   6. Generation-time lint warns when `.get()` and `.head()` share a
 *      path (Express auto-mirrors — explicit HEAD is rarely intentional).
 *
 * Run: npx vitest run tests/issue-head-requests.test.ts
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
  HttpError,
  ResponseInfo,
  convertResponseToPreviousVersionFor,
} from "../src/index.js";

const UserSchema = z
  .object({ id: z.string(), name: z.string() })
  .named("IssueHead_User");

describe("Issue: HEAD request support", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("dispatches HEAD /users/:id to the registered GET handler when no explicit HEAD is set", async () => {
    const router = new VersionedRouter();
    router.get("/users/:id", null, UserSchema, async (req: any) => ({
      id: req.params.id,
      name: "alice",
    }));

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .head("/users/123")
      .set("x-api-version", "2024-01-01");

    expect(res.status).toBe(200);
    // HEAD must have no body
    expect(res.body).toEqual({});
    expect(res.text).toBeFalsy();
  });

  it("dispatches to the explicit HEAD handler when one is registered (overrides GET auto-mirror)", async () => {
    const router = new VersionedRouter();
    const getSpy = vi.fn(async (req: any) => ({ id: req.params.id, name: "alice" }));
    const headSpy = vi.fn(async (_req: any) => undefined);

    router.get("/users/:id", null, UserSchema, getSpy);
    // GAP: .head() is not a method on VersionedRouter today
    (router as any).head("/users/:id", null, null, headSpy);

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    await request(app.expressApp)
      .head("/users/123")
      .set("x-api-version", "2024-01-01");

    expect(headSpy).toHaveBeenCalledOnce();
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("skips response-body migrations on HEAD (body transformer NOT called)", async () => {
    const bodyTransformSpy = vi.fn((res: ResponseInfo) => {
      // rename `name` → `display_name` for legacy clients
      if (res.body?.name !== undefined) {
        res.body.display_name = res.body.name;
        delete res.body.name;
      }
    });

    class RenameNameField extends VersionChange {
      description = "rename name → display_name for legacy clients";
      instructions = [];

      r1 = convertResponseToPreviousVersionFor(UserSchema)(bodyTransformSpy);
    }

    const router = new VersionedRouter();
    router.get("/users/:id", null, UserSchema, async (req: any) => ({
      id: req.params.id,
      name: "alice",
    }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-01-01", RenameNameField),
        new Version("2024-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    // GET at legacy version — transformer SHOULD fire
    await request(app.expressApp)
      .get("/users/123")
      .set("x-api-version", "2024-01-01");
    expect(bodyTransformSpy).toHaveBeenCalledOnce();

    bodyTransformSpy.mockClear();

    // HEAD at legacy version — transformer should NOT fire
    await request(app.expressApp)
      .head("/users/123")
      .set("x-api-version", "2024-01-01");
    expect(bodyTransformSpy).not.toHaveBeenCalled();
  });

  it("still runs header migrations on HEAD", async () => {
    const headerTransformSpy = vi.fn((res: ResponseInfo) => {
      res.headers["x-legacy-header"] = "set-by-migration";
    });

    class AddLegacyHeader extends VersionChange {
      description = "add x-legacy-header for legacy clients";
      instructions = [];

      // headerOnly: true signals the migration only touches res.headers —
      // safe to run on body-less contexts (HEAD, 204/304, null-result).
      r1 = convertResponseToPreviousVersionFor(UserSchema, { headerOnly: true })(
        headerTransformSpy,
      );
    }

    const router = new VersionedRouter();
    router.get("/users/:id", null, UserSchema, async (req: any) => ({
      id: req.params.id,
      name: "alice",
    }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-01-01", AddLegacyHeader),
        new Version("2024-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .head("/users/123")
      .set("x-api-version", "2024-01-01");

    expect(headerTransformSpy).toHaveBeenCalledOnce();
    expect(res.headers["x-legacy-header"]).toBe("set-by-migration");
  });

  it("applies migrateHttpErrors on HEAD error paths without emitting the error body", async () => {
    const ErrorBody = z
      .object({ code: z.string(), message: z.string() })
      .named("IssueHead_ErrorBody");

    class RenameErrorCode extends VersionChange {
      description = "rename error `code` → `err_code` for legacy";
      instructions = [];

      r1 = convertResponseToPreviousVersionFor(ErrorBody, { migrateHttpErrors: true })(
        (res: ResponseInfo) => {
          if (res.body?.code !== undefined) {
            res.body.err_code = res.body.code;
            delete res.body.code;
          }
        },
      );
    }

    const router = new VersionedRouter();
    router.get("/users/:id", null, ErrorBody, async () => {
      throw new HttpError(404, { code: "user_not_found", message: "no such user" });
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-01-01", RenameErrorCode),
        new Version("2024-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .head("/users/missing")
      .set("x-api-version", "2024-01-01");

    expect(res.status).toBe(404);
    // HEAD must have no body even on error
    expect(res.text).toBeFalsy();
    expect(res.body).toEqual({});
  });

  it("Content-Length header matches the equivalent GET response body byte length", async () => {
    const router = new VersionedRouter();
    router.get("/users/:id", null, UserSchema, async (req: any) => ({
      id: req.params.id,
      name: "alice",
    }));

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const getRes = await request(app.expressApp)
      .get("/users/123")
      .set("x-api-version", "2024-01-01");
    const headRes = await request(app.expressApp)
      .head("/users/123")
      .set("x-api-version", "2024-01-01");

    expect(getRes.status).toBe(200);
    expect(headRes.status).toBe(200);
    // Both must agree on Content-Length (strict HEAD/GET parity)
    expect(headRes.headers["content-length"]).toBe(getRes.headers["content-length"]);
  });

  it("returns 405 Method Not Allowed with Allow header on HEAD-to-path-with-only-POST", async () => {
    const router = new VersionedRouter();
    router.post("/charges", null, null, async () => ({ ok: true }));

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .head("/charges")
      .set("x-api-version", "2024-01-01");

    expect(res.status).toBe(405);
    // Allow header should list the methods that ARE registered
    expect(res.headers["allow"]).toMatch(/POST/);
  });

  it("emits a registration-time warning when both .get() and .head() are registered for the same path", async () => {
    const router = new VersionedRouter();
    router.get("/users/:id", null, UserSchema, async (req: any) => ({
      id: req.params.id,
      name: "alice",
    }));
    (router as any).head("/users/:id", null, null, async () => undefined);

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const warned = warnSpy.mock.calls.some((args) =>
      args.some(
        (a) =>
          typeof a === "string" &&
          a.includes("/users/:id") &&
          /HEAD/i.test(a) &&
          /GET/i.test(a),
      ),
    );
    expect(
      warned,
      `Expected a warning naming both GET and HEAD for /users/:id. Got: ${JSON.stringify(warnSpy.mock.calls)}`,
    ).toBe(true);
  });
});
