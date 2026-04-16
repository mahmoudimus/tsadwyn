/**
 * FAILING TEST — verifies the gap described in tsadwyn-issue-error-mapper.md
 *
 * Today, when a handler throws a domain exception that doesn't carry a
 * `statusCode` property, tsadwyn's `_isHttpLikeError()` check fails and the
 * error escapes via `next(err)` to Express's default error handler. That
 * bypasses the response-migration pipeline entirely and forces consumers to
 * couple their domain layer to tsadwyn's internal detection.
 *
 * The proposed fix adds an `errorMapper` option on `TsadwynOptions` — a pure
 * function `(err: unknown) => HttpError | null` invoked inside the handler's
 * catch block before `_isHttpLikeError`. When it returns an `HttpError`, the
 * existing migration / status / header machinery picks up. When it returns
 * `null`, current behavior (`next(err)`) is preserved.
 *
 * These tests will turn green when:
 *   1. `TsadwynOptions.errorMapper` is accepted at construction
 *   2. The mapper runs in the catch block before the HTTP-likeness check
 *   3. Mapped HttpError flows through `migrateHttpErrors: true` migrations
 *   4. A throwing mapper does not crash the response — tsadwyn returns 500
 *
 * Run: npx vitest run tests/issue-error-mapper.test.ts
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
  HttpError,
  convertResponseToPreviousVersionFor,
  ResponseInfo,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Domain exception classes that intentionally don't carry HTTP semantics.
// In real consumer codebases these live in /domain or /service layers and
// must not depend on tsadwyn or Express.
// ---------------------------------------------------------------------------

class IdempotencyKeyReuseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyKeyReuseError";
  }
}

class ServiceValidationError extends Error {
  details: unknown;
  constructor(message: string, details: unknown) {
    super(message);
    this.name = "ServiceValidationError";
    this.details = details;
  }
}

const ErrorBody = z
  .object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  })
  .named("IssueErrorMapper_ErrorBody");

const Resp = z.object({ ok: z.literal(true) }).named("IssueErrorMapper_Resp");

describe("Issue: errorMapper option translates domain exceptions to HttpError", () => {
  it("invokes errorMapper for non-HTTP-like errors and returns the mapped status + body", async () => {
    const router = new VersionedRouter();
    router.post("/users", null, Resp, async () => {
      throw new IdempotencyKeyReuseError("key already used");
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
      // GAP: errorMapper is not yet a recognized option.
      errorMapper: (err: unknown) => {
        if (err instanceof Error && err.name === "IdempotencyKeyReuseError") {
          return new HttpError(409, {
            code: "idempotency_key_reused",
            message: err.message,
          });
        }
        return null;
      },
    } as any);
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .post("/users")
      .set("x-api-version", "2024-01-01")
      .send({});

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      code: "idempotency_key_reused",
      message: "key already used",
    });
  });

  it("falls through to next(err) when errorMapper returns null", async () => {
    const router = new VersionedRouter();
    router.get("/things", null, Resp, async () => {
      throw new Error("some unrelated error");
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
      errorMapper: (_err: unknown) => null,
    } as any);
    app.generateAndIncludeVersionedRouters(router);

    // Express's default error handler renders a 500 with no JSON body
    // when no other handler claims the error. The exact shape isn't what
    // we're asserting — we're asserting the mapper did NOT short-circuit
    // the error to a 200/400/etc.
    const res = await request(app.expressApp)
      .get("/things")
      .set("x-api-version", "2024-01-01");
    expect(res.status).toBe(500);
  });

  it("runs response migrations on the mapped HttpError when migrateHttpErrors=true", async () => {
    // Legacy clients expect { error_code, error_message } instead of { code, message }.
    class RenameErrorFields extends VersionChange {
      description = "Legacy error envelope used error_code/error_message";
      instructions = [];

      r1 = convertResponseToPreviousVersionFor(ErrorBody, {
        migrateHttpErrors: true,
      })((res: ResponseInfo) => {
        if (res.body && typeof res.body === "object") {
          if (res.body.code !== undefined) {
            res.body.error_code = res.body.code;
            delete res.body.code;
          }
          if (res.body.message !== undefined) {
            res.body.error_message = res.body.message;
            delete res.body.message;
          }
        }
      });
    }

    const router = new VersionedRouter();
    router.post("/validate", null, ErrorBody, async () => {
      throw new ServiceValidationError("name is required", { field: "name" });
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-01-01", RenameErrorFields),
        new Version("2024-01-01"),
      ),
      errorMapper: (err: unknown) => {
        if (err instanceof Error && err.name === "ServiceValidationError") {
          return new HttpError(400, {
            code: "validation_error",
            message: err.message,
            details: (err as ServiceValidationError).details,
          });
        }
        return null;
      },
    } as any);
    app.generateAndIncludeVersionedRouters(router);

    // Head client — gets the new shape
    const headRes = await request(app.expressApp)
      .post("/validate")
      .set("x-api-version", "2025-01-01")
      .send({});
    expect(headRes.status).toBe(400);
    expect(headRes.body.code).toBe("validation_error");
    expect(headRes.body.message).toBe("name is required");

    // Legacy client — gets the legacy shape via the migration on the
    // mapper-produced HttpError
    const legacyRes = await request(app.expressApp)
      .post("/validate")
      .set("x-api-version", "2024-01-01")
      .send({});
    expect(legacyRes.status).toBe(400);
    expect(legacyRes.body.error_code).toBe("validation_error");
    expect(legacyRes.body.error_message).toBe("name is required");
    expect(legacyRes.body.code).toBeUndefined();
  });

  it("handles errorMapper that itself throws — returns 500 without crashing the process", async () => {
    const router = new VersionedRouter();
    router.get("/danger", null, Resp, async () => {
      throw new Error("from handler");
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
      errorMapper: (_err: unknown) => {
        throw new Error("mapper itself blew up");
      },
    } as any);
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .get("/danger")
      .set("x-api-version", "2024-01-01");
    expect(res.status).toBe(500);
  });
});
