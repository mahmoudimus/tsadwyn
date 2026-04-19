/**
 * Validation errors (body / params / query schema parse failures) now
 * flow through tsadwyn's error pipeline as `ValidationError extends
 * HttpError`, so consumers can reshape the wire envelope via
 * `errorMapper` / `exceptionMap` or `migrateHttpErrors` response
 * migrations.
 *
 * Run: npx vitest run tests/issue-validation-error-envelope.test.ts
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
  ValidationError,
  exceptionMap,
  convertResponseToPreviousVersionFor,
  ResponseInfo,
} from "../src/index.js";

describe("Issue: validation errors as first-class HttpError (ValidationError)", () => {
  const CreateUser = z
    .object({
      email: z.string().email(),
      age: z.number().int().min(0),
    })
    .named("IssueValErr_CreateUser");

  it("backward-compatible: default wire shape is still {detail: [...]} at 422", async () => {
    const router = new VersionedRouter();
    router.post("/users", CreateUser, null, async () => ({ ok: true }));

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .post("/users")
      .set("x-api-version", "2024-01-01")
      .send({ email: "not-an-email", age: -1 });

    expect(res.status).toBe(422);
    expect(Array.isArray(res.body.detail)).toBe(true);
    expect(res.body.detail.length).toBeGreaterThan(0);
  });

  it("errorMapper can reshape validation errors via err.name === 'ValidationError'", async () => {
    const router = new VersionedRouter();
    router.post("/users", CreateUser, null, async () => ({ ok: true }));

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
      errorMapper: exceptionMap({
        ValidationError: (err: any) =>
          new HttpError(422, {
            error: {
              code: "validation_error",
              message: "One or more fields failed validation.",
              where: err.where,
              fields: err.body.detail.map((e: any) => ({
                path: e.path,
                message: e.message,
                code: e.code,
              })),
            },
          }),
      }),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .post("/users")
      .set("x-api-version", "2024-01-01")
      .send({ email: "not-an-email", age: -1 });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: {
        code: "validation_error",
        message: "One or more fields failed validation.",
        where: "body",
      },
    });
    expect(Array.isArray(res.body.error.fields)).toBe(true);
    expect(res.body.error.fields.length).toBeGreaterThan(0);
  });

  it("ValidationError.where distinguishes body / params / query", async () => {
    const Params = z.object({ id: z.string().uuid() }).named("IssueValErr_Params");
    const Query = z.object({ limit: z.coerce.number().int().positive() }).named("IssueValErr_Query");

    const seenWhere: string[] = [];

    const router = new VersionedRouter();
    router.get("/items/:id", null, null, async () => ({ ok: true }), {
      paramsSchema: Params,
      querySchema: Query,
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
      errorMapper: exceptionMap({
        ValidationError: (err: any) => {
          seenWhere.push(err.where);
          return new HttpError(422, {
            error: { code: `validation_${err.where}` },
          });
        },
      }),
    });
    app.generateAndIncludeVersionedRouters(router);

    // Bad path param (not a uuid) — where === 'params'
    const paramsRes = await request(app.expressApp)
      .get("/items/not-a-uuid?limit=10")
      .set("x-api-version", "2024-01-01");
    expect(paramsRes.status).toBe(422);
    expect(paramsRes.body.error.code).toBe("validation_params");

    // Bad query (limit non-numeric) — where === 'query'
    const queryRes = await request(app.expressApp)
      .get("/items/00000000-0000-4000-8000-000000000000?limit=notanumber")
      .set("x-api-version", "2024-01-01");
    expect(queryRes.status).toBe(422);
    expect(queryRes.body.error.code).toBe("validation_query");

    expect(seenWhere).toEqual(["params", "query"]);
  });

  it("ValidationError can be reshaped per-version via migrateHttpErrors response migrations", async () => {
    class FlattenValidationEnvelope extends VersionChange {
      description =
        "initial version returned a flat {errors: [...]} body; head uses {detail: [...]}";
      instructions = [];

      r1 = convertResponseToPreviousVersionFor("/users", ["POST"], {
        migrateHttpErrors: true,
      })((res: ResponseInfo) => {
        if (res.statusCode === 422 && res.body?.detail) {
          res.body = { errors: res.body.detail };
        }
      });
    }

    const router = new VersionedRouter();
    router.post("/users", CreateUser, null, async () => ({ ok: true }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-01-01", FlattenValidationEnvelope),
        new Version("2024-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    // Initial-version client sees the flat {errors: [...]} shape
    const legacyRes = await request(app.expressApp)
      .post("/users")
      .set("x-api-version", "2024-01-01")
      .send({ email: "nope", age: -1 });
    expect(legacyRes.status).toBe(422);
    expect(legacyRes.body.errors).toBeDefined();
    expect(legacyRes.body.detail).toBeUndefined();

    // Head client sees the current {detail: [...]} shape
    const headRes = await request(app.expressApp)
      .post("/users")
      .set("x-api-version", "2025-01-01")
      .send({ email: "nope", age: -1 });
    expect(headRes.status).toBe(422);
    expect(headRes.body.detail).toBeDefined();
  });

  it("ValidationError instances pass instanceof HttpError AND instanceof ValidationError", () => {
    const err = new ValidationError("body", [{ path: ["x"], message: "bad" }]);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.name).toBe("ValidationError");
    expect(err.statusCode).toBe(422);
    expect(err.body).toEqual({ detail: [{ path: ["x"], message: "bad" }] });
    expect(err.where).toBe("body");
  });
});
