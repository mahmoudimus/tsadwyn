/**
 * Phase 19 — T-1900: HTTPException response migration
 *
 * Tests that tsadwyn intercepts HttpError thrown from route handlers,
 * wraps the error as a ResponseInfo, runs response migrations that have
 * `migrateHttpErrors: true`, and sends the migrated error response.
 *
 * Run: npx vitest run tests/http-errors.test.ts
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
  schema,
  endpoint,
  convertResponseToPreviousVersionFor,
  ResponseInfo,
  HttpError,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Setup schemas
// ---------------------------------------------------------------------------

const ErrorResponse = z.object({
  detail: z.string(),
  field: z.string().optional(),
  old_field: z.string().optional(),
}).named("T1900_ErrorResponse");

const SuccessResponse = z.object({
  id: z.string(),
  field: z.string(),
}).named("T1900_SuccessResponse");

// ---------------------------------------------------------------------------
// T-1900: HTTPException response migration
// ---------------------------------------------------------------------------

describe("HTTPException response migration", () => {
  it("migrates error responses when migrateHttpErrors is true", async () => {
    // Version change: "field" was called "old_field" in the previous version.
    // The migration with migrateHttpErrors: true should also transform error responses.
    class RenameFieldInError extends VersionChange {
      description = "Renamed old_field to field, including in error responses";
      instructions = [
        schema(SuccessResponse).field("field").had({ name: "old_field" }),
      ];

      r1 = convertResponseToPreviousVersionFor(SuccessResponse, { migrateHttpErrors: true })(
        (res: ResponseInfo) => {
          if (res.body.field !== undefined) {
            res.body.old_field = res.body.field;
            delete res.body.field;
          }
        },
      );
    }

    const router = new VersionedRouter();
    router.get("/items/:id", null, SuccessResponse, async (req) => {
      if (req.params.id === "missing") {
        throw new HttpError(404, { detail: "not found", field: "some_value" });
      }
      return { id: req.params.id, field: "value" };
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", RenameFieldInError),
        new Version("2000-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const server = app.expressApp;

    // Request a non-existing item with old version — error body should be migrated
    const errorRes = await request(server)
      .get("/items/missing")
      .set("x-api-version", "2000-01-01");

    expect(errorRes.status).toBe(404);
    // The migration renames "field" to "old_field" in the response body
    expect(errorRes.body.old_field).toBe("some_value");
    expect(errorRes.body.field).toBeUndefined();
    expect(errorRes.body.detail).toBe("not found");

    // Verify successful responses are also migrated
    const successRes = await request(server)
      .get("/items/abc")
      .set("x-api-version", "2000-01-01");

    expect(successRes.status).toBe(200);
    expect(successRes.body.old_field).toBe("value");
    expect(successRes.body.field).toBeUndefined();
  });

  it("skips migration when migrateHttpErrors is false", async () => {
    class RenameFieldNoErrors extends VersionChange {
      description = "Renamed old_field to field, NOT including error responses";
      instructions = [
        schema(SuccessResponse).field("field").had({ name: "old_field" }),
      ];

      // migrateHttpErrors defaults to false
      r1 = convertResponseToPreviousVersionFor(SuccessResponse)(
        (res: ResponseInfo) => {
          if (res.body.field !== undefined) {
            res.body.old_field = res.body.field;
            delete res.body.field;
          }
        },
      );
    }

    const router = new VersionedRouter();

    // Use a different path to avoid schema name collisions
    const SuccessResponse2 = z.object({
      id: z.string(),
      field: z.string(),
    }).named("T1900_SuccessResponse2");

    router.get("/widgets/:id", null, SuccessResponse2, async (req) => {
      if (req.params.id === "missing") {
        throw new HttpError(404, { detail: "not found", field: "some_value" });
      }
      return { id: req.params.id, field: "value" };
    });

    class RenameFieldNoErrors2 extends VersionChange {
      description = "Renamed old_field to field, NOT including error responses";
      instructions = [
        schema(SuccessResponse2).field("field").had({ name: "old_field" }),
      ];

      r1 = convertResponseToPreviousVersionFor(SuccessResponse2)(
        (res: ResponseInfo) => {
          if (res.body.field !== undefined) {
            res.body.old_field = res.body.field;
            delete res.body.field;
          }
        },
      );
    }

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", RenameFieldNoErrors2),
        new Version("2000-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const server = app.expressApp;

    // Error response should NOT be migrated (migrateHttpErrors is false)
    const errorRes = await request(server)
      .get("/widgets/missing")
      .set("x-api-version", "2000-01-01");

    expect(errorRes.status).toBe(404);
    // The migration should NOT have run on the error response
    expect(errorRes.body.detail).toBe("not found");
    expect(errorRes.body.field).toBe("some_value");
    expect(errorRes.body.old_field).toBeUndefined();

    // But successful responses SHOULD still be migrated
    const successRes = await request(server)
      .get("/widgets/abc")
      .set("x-api-version", "2000-01-01");

    expect(successRes.status).toBe(200);
    expect(successRes.body.old_field).toBe("value");
    expect(successRes.body.field).toBeUndefined();
  });

  it("preserves HttpError status code through migration", async () => {
    const Res = z.object({ message: z.string() }).named("T1900_StatusCodeRes");

    class AddStatusField extends VersionChange {
      description = "Add status field to responses";
      instructions = [];

      r1 = convertResponseToPreviousVersionFor(Res, { migrateHttpErrors: true })(
        (res: ResponseInfo) => {
          res.body.status_code = res.statusCode;
        },
      );
    }

    const router = new VersionedRouter();
    router.get("/status-test", null, Res, async () => {
      throw new HttpError(403, { message: "forbidden" });
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", AddStatusField),
        new Version("2000-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .get("/status-test")
      .set("x-api-version", "2000-01-01");

    expect(res.status).toBe(403);
    expect(res.body.message).toBe("forbidden");
    expect(res.body.status_code).toBe(403);
  });

  it("preserves HttpError custom headers", async () => {
    const Res = z.object({ msg: z.string() }).named("T1900_HeaderRes");

    class NoOpChange extends VersionChange {
      description = "Dummy change for testing headers on HttpError";
      instructions = [];
    }

    const router = new VersionedRouter();
    router.get("/header-test", null, Res, async () => {
      throw new HttpError(
        429,
        { msg: "rate limited" },
        { "retry-after": "60", "x-rate-limit-remaining": "0" },
      );
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", NoOpChange),
        new Version("2000-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .get("/header-test")
      .set("x-api-version", "2000-01-01");

    expect(res.status).toBe(429);
    expect(res.body.msg).toBe("rate limited");
    // HttpError headers should be preserved on the response
    expect(res.headers["retry-after"]).toBe("60");
    expect(res.headers["x-rate-limit-remaining"]).toBe("0");
  });
});
