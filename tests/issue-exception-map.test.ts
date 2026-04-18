/**
 * Covers `exceptionMap()` — a declarative helper on top of the
 * `errorMapper` option that adds introspection (has / lookup /
 * registeredNames / describe) and CLI integration via
 * `tsadwyn exceptions`.
 *
 * Run: npx vitest run tests/issue-exception-map.test.ts
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
  ResponseInfo,
  convertResponseToPreviousVersionFor,
  TsadwynStructureError,
  exceptionMap,
} from "../src/index.js";

import { runExceptions } from "../src/cli.js";

// ---------------------------------------------------------------------------
// Domain exception classes that do NOT carry HTTP semantics
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

class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

class RateLimitError extends Error {
  retryAfter: number;
  constructor(message: string, retryAfter: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

const Resp = z.object({ ok: z.literal(true) }).named("IssueExceptionMap_Resp");

// ---------------------------------------------------------------------------
// Helper contract
// ---------------------------------------------------------------------------

describe("Issue: exceptionMap — function-form mapping", () => {
  it("returns the HttpError constructed by the function-form mapping", () => {
    const mapper = exceptionMap({
      IdempotencyKeyReuseError: (err: any) =>
        new HttpError(409, { code: "idempotency_key_reused", message: err.message }),
    });

    const err = new IdempotencyKeyReuseError("key xyz used");
    const result = mapper(err);

    expect(result).toBeInstanceOf(HttpError);
    expect(result!.statusCode).toBe(409);
    expect(result!.body).toEqual({
      code: "idempotency_key_reused",
      message: "key xyz used",
    });
  });

  it("returns null for unmapped errors (fallthrough)", () => {
    const mapper = exceptionMap({
      IdempotencyKeyReuseError: (err: any) =>
        new HttpError(409, { message: err.message }),
    });

    expect(mapper(new Error("totally unrelated"))).toBeNull();
  });
});

describe("Issue: exceptionMap — static-form mapping", () => {
  it("produces HttpError(status, {code, message: err.message}) for static-form entries", () => {
    const mapper = exceptionMap({
      NotFoundError: { status: 404, code: "not_found" },
    });

    const err = new NotFoundError("user 123 missing");
    const result = mapper(err);

    expect(result).toBeInstanceOf(HttpError);
    expect(result!.statusCode).toBe(404);
    expect(result!.body).toMatchObject({
      code: "not_found",
      message: "user 123 missing",
    });
  });

  it("honors the explicit `message` override in the static form", () => {
    const mapper = exceptionMap({
      NotFoundError: { status: 404, code: "not_found", message: "resource missing" },
    });

    const err = new NotFoundError("some internal detail");
    const result = mapper(err);

    expect(result!.body.message).toBe("resource missing");
  });
});

describe("Issue: exceptionMap — static-with-transform mapping", () => {
  it("composes static status/code with dynamic body from transform", () => {
    const mapper = exceptionMap({
      RateLimitError: {
        status: 429,
        code: "rate_limited",
        transform: (err: any) => ({
          message: err.message,
          retryAfter: err.retryAfter,
        }),
      },
    });

    const err = new RateLimitError("too many", 60);
    const result = mapper(err);

    expect(result!.statusCode).toBe(429);
    expect(result!.body).toMatchObject({
      code: "rate_limited",
      message: "too many",
      retryAfter: 60,
    });
  });
});

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

describe("Issue: exceptionMap — introspection", () => {
  function buildMapper() {
    return exceptionMap({
      IdempotencyKeyReuseError: (err: any) =>
        new HttpError(409, { code: "idempotency_key_reused", message: err.message }),
      NotFoundError: { status: 404, code: "not_found" },
      RateLimitError: {
        status: 429,
        code: "rate_limited",
        transform: (err: any) => ({ message: err.message }),
      },
    });
  }

  it("exposes registeredNames as a readonly array of all mapped names", () => {
    const mapper = buildMapper();
    expect(mapper.registeredNames).toEqual(
      expect.arrayContaining([
        "IdempotencyKeyReuseError",
        "NotFoundError",
        "RateLimitError",
      ]),
    );
    expect(mapper.registeredNames.length).toBe(3);
  });

  it("has(name) reports mapped + unmapped classes correctly", () => {
    const mapper = buildMapper();
    expect(mapper.has("IdempotencyKeyReuseError")).toBe(true);
    expect(mapper.has("NotFoundError")).toBe(true);
    expect(mapper.has("TotallyUnknownError")).toBe(false);
  });

  it("lookup(name) returns the registered mapping or undefined", () => {
    const mapper = buildMapper();
    expect(mapper.lookup("NotFoundError")).toEqual({
      status: 404,
      code: "not_found",
    });
    expect(mapper.lookup("TotallyUnknownError")).toBeUndefined();
  });

  it("describe() returns a structured table with kind/status/code/hasTransform per entry", () => {
    const mapper = buildMapper();
    const table = mapper.describe();

    const byName = Object.fromEntries(table.map((e: any) => [e.name, e]));

    expect(byName["NotFoundError"]).toMatchObject({
      kind: "static",
      status: 404,
      code: "not_found",
      hasTransform: false,
    });

    expect(byName["IdempotencyKeyReuseError"]).toMatchObject({
      kind: "function",
      status: null,
      code: null,
      hasTransform: false,
    });

    expect(byName["RateLimitError"]).toMatchObject({
      kind: "static-with-transform",
      status: 429,
      code: "rate_limited",
      hasTransform: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Constructor-time validation
// ---------------------------------------------------------------------------

describe("Issue: exceptionMap — construction validation", () => {
  it("throws TsadwynStructureError on duplicate keys (detected via case-insensitive comparison)", () => {
    // JS objects can't have duplicate string keys — the only way to hit this is
    // merging two configs. The helper should offer a merge primitive or detect
    // collisions in a declared-duplicates form. For now, a merge helper:
    //   exceptionMap({ X: ..., ...other, X: ... })  — JS keeps the last value, no dedup.
    // A merge helper exceptionMap.merge(a, b) should throw on overlap:

    const a: Record<string, any> = {
      NotFoundError: { status: 404, code: "not_found" },
    };
    const b: Record<string, any> = {
      NotFoundError: { status: 410, code: "gone" },  // duplicate
    };

    expect(() => (exceptionMap as any).merge(a, b)).toThrow(TsadwynStructureError);
  });

  it("rejects a static-form mapping with status outside 4xx/5xx range (construction-time)", () => {
    expect(() =>
      exceptionMap({
        WeirdError: { status: 200, code: "ok" } as any,
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// End-to-end integration with Tsadwyn.errorMapper
// ---------------------------------------------------------------------------

describe("Issue: exceptionMap — integration with errorMapper", () => {
  it("wires directly into Tsadwyn.errorMapper and produces the mapped HTTP response", async () => {
    const router = new VersionedRouter();
    router.post("/users", null, Resp, async () => {
      throw new IdempotencyKeyReuseError("key xyz used");
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
      errorMapper: exceptionMap({
        IdempotencyKeyReuseError: (err: any) =>
          new HttpError(409, { code: "idempotency_key_reused", message: err.message }),
      }),
    } as any);
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .post("/users")
      .set("x-api-version", "2024-01-01")
      .send({});

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      code: "idempotency_key_reused",
      message: "key xyz used",
    });
  });

  it("composes with migrateHttpErrors — mapped HttpError flows through response migrations", async () => {
    const ErrorBody = z
      .object({ code: z.string(), message: z.string() })
      .named("IssueExceptionMap_ErrorBody");

    class RenameErrorFields extends VersionChange {
      description = "legacy error envelope used error_code/error_message";
      instructions = [];

      r1 = convertResponseToPreviousVersionFor(ErrorBody, {
        migrateHttpErrors: true,
      })((res: ResponseInfo) => {
        if (res.body?.code !== undefined) {
          res.body.error_code = res.body.code;
          delete res.body.code;
        }
        if (res.body?.message !== undefined) {
          res.body.error_message = res.body.message;
          delete res.body.message;
        }
      });
    }

    const router = new VersionedRouter();
    router.post("/validate", null, ErrorBody, async () => {
      throw new ServiceValidationError("name required", { field: "name" });
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-01-01", RenameErrorFields),
        new Version("2024-01-01"),
      ),
      errorMapper: exceptionMap({
        ServiceValidationError: (err: any) =>
          new HttpError(400, {
            code: "validation_error",
            message: err.message,
          }),
      }),
    } as any);
    app.generateAndIncludeVersionedRouters(router);

    // Legacy client — gets migrated error shape
    const legacyRes = await request(app.expressApp)
      .post("/validate")
      .set("x-api-version", "2024-01-01")
      .send({});

    expect(legacyRes.status).toBe(400);
    expect(legacyRes.body.error_code).toBe("validation_error");
    expect(legacyRes.body.error_message).toBe("name required");
    expect(legacyRes.body.code).toBeUndefined();
  });

  it("matches by err.name string, NOT instanceof (survives module identity drift)", () => {
    const mapper = exceptionMap({
      NotFoundError: { status: 404, code: "not_found" },
    });

    // Construct an err that has the right NAME but is NOT an instance of our
    // NotFoundError class (simulating dual-install / resetModules scenario).
    const crossBoundaryErr = Object.assign(new Error("cross-boundary"), {
      name: "NotFoundError",
    });

    const result = mapper(crossBoundaryErr);

    expect(result).toBeInstanceOf(HttpError);
    expect(result!.statusCode).toBe(404);
  });

  it("does NOT match by inheritance — subclass names are distinct entries", () => {
    const mapper = exceptionMap({
      ConflictException: (err: any) => new HttpError(409, { code: "conflict" }),
    });

    class IdempotencyKeyReuseErrorSubclass extends Error {
      constructor() {
        super("subclass");
        this.name = "IdempotencyKeyReuseErrorSubclass";
      }
    }

    // Even though conceptually it's a "conflict", name differs → null
    expect(mapper(new IdempotencyKeyReuseErrorSubclass())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CLI integration — tsadwyn exceptions
// ---------------------------------------------------------------------------

describe("Issue: exceptionMap — `tsadwyn exceptions` CLI", () => {
  it("runExceptions() produces JSON output matching describe()", async () => {
    // The CLI subcommand is expected to be exported for programmatic testing,
    // same pattern as runCodegen, runInfo, runNewVersion in cli.ts today.
    const result = await runExceptions({
      app: "./tests/fixtures/cli-exception-map-app.ts",
      format: "json",
    });

    // Output is parseable JSON
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);

    // Contains at least one known entry
    const hasNotFound = parsed.some(
      (e: any) => e.name === "NotFoundError" && e.kind === "static",
    );
    expect(hasNotFound).toBe(true);
  });

  it("runExceptions() filters entries by --filter regex", async () => {
    const result = await runExceptions({
      app: "./tests/fixtures/cli-exception-map-app.ts",
      format: "json",
      filter: "^Idempotency",
    });

    const parsed = JSON.parse(result.stdout);
    expect(parsed.every((e: any) => /^Idempotency/.test(e.name))).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });

  it("runExceptions() table format renders a readable ASCII table", async () => {
    const result = await runExceptions({
      app: "./tests/fixtures/cli-exception-map-app.ts",
      format: "table",
    });

    // Must contain a header row naming the columns
    expect(result.stdout).toMatch(/Exception name/);
    expect(result.stdout).toMatch(/Status/);
    expect(result.stdout).toMatch(/Code/);
  });

  it("runExceptions() exits non-zero when --app path doesn't expose an introspectable errorMapper", async () => {
    const result = await runExceptions({
      app: "./tests/fixtures/cli-happy-app.ts",  // app without exception map
      format: "json",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/errorMapper/i);
  });
});
