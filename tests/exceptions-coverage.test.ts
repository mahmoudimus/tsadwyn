/**
 * exceptions-coverage.test.ts
 *
 * Exercises every exception class exported from `src/exceptions.ts`, ensuring
 * they can be instantiated, have the correct name/message/stack, and satisfy
 * `instanceof` checks against both their immediate class and base classes.
 *
 * Run: npx vitest run tests/exceptions-coverage.test.ts
 */
import { describe, it, expect } from "vitest";

import {
  TsadwynError,
  TsadwynStructureError,
  TsadwynLatestRequestValidationError,
  TsadwynHeadRequestValidationError,
  LintingError,
  RouterGenerationError,
  RouteAlreadyExistsError,
  RouteByPathConverterDoesNotApplyToAnythingError,
  RouteRequestBySchemaConverterDoesNotApplyToAnythingError,
  RouteResponseBySchemaConverterDoesNotApplyToAnythingError,
  RouterPathParamsModifiedError,
  InvalidGenerationInstructionError,
  ModuleIsNotVersionedError,
  HttpError,
} from "../src/index.js";

// ═══════════════════════════════════════════════════════════════════════════
// Section 1: Every exception class can be instantiated, thrown, and caught
// ═══════════════════════════════════════════════════════════════════════════

describe("Section 1: exception classes basic behavior", () => {
  it("TsadwynError — preserves name, message, stack, and prototype chain", () => {
    const err = new TsadwynError("base error");
    expect(err).toBeInstanceOf(TsadwynError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("TsadwynError");
    expect(err.message).toBe("base error");
    expect(err.stack).toBeDefined();
    expect(typeof err.stack).toBe("string");

    let caught: unknown;
    try {
      throw err;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TsadwynError);
  });

  it("TsadwynError — no-arg constructor still works", () => {
    const err = new TsadwynError();
    expect(err).toBeInstanceOf(TsadwynError);
    expect(err.name).toBe("TsadwynError");
    // message is either undefined or the empty string depending on runtime
    expect(err.message === "" || err.message === undefined).toBe(true);
  });

  it("TsadwynStructureError — extends TsadwynError", () => {
    const err = new TsadwynStructureError("structure bad");
    expect(err).toBeInstanceOf(TsadwynStructureError);
    expect(err).toBeInstanceOf(TsadwynError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("TsadwynStructureError");
    expect(err.message).toBe("structure bad");
    expect(err.stack).toBeDefined();

    try {
      throw err;
    } catch (e) {
      expect(e).toBeInstanceOf(TsadwynStructureError);
      expect(e).toBeInstanceOf(TsadwynError);
    }
  });

  it("TsadwynLatestRequestValidationError — preserves fields and instanceof", () => {
    const errors = [{ path: ["a"], message: "required" }];
    const body = { foo: "bar" };
    const version = "2000-01-01";
    const err = new TsadwynLatestRequestValidationError(errors, body, version);

    expect(err).toBeInstanceOf(TsadwynLatestRequestValidationError);
    expect(err).toBeInstanceOf(TsadwynError);
    expect(err.name).toBe("TsadwynLatestRequestValidationError");
    expect(err.errors).toBe(errors);
    expect(err.body).toBe(body);
    expect(err.version).toBe(version);
    expect(err.message).toContain("version=2000-01-01");
    expect(err.message).toContain(JSON.stringify(body));
    expect(err.message).toContain(JSON.stringify(errors));
    expect(err.stack).toBeDefined();

    try {
      throw err;
    } catch (e) {
      expect(e).toBeInstanceOf(TsadwynLatestRequestValidationError);
    }
  });

  it("TsadwynHeadRequestValidationError — preserves fields and instanceof", () => {
    const errors = [{ code: "invalid_type" }];
    const body = { x: 1 };
    const version = "2001-02-03";
    const err = new TsadwynHeadRequestValidationError(errors, body, version);

    expect(err).toBeInstanceOf(TsadwynHeadRequestValidationError);
    expect(err).toBeInstanceOf(TsadwynError);
    expect(err.name).toBe("TsadwynHeadRequestValidationError");
    expect(err.errors).toBe(errors);
    expect(err.body).toBe(body);
    expect(err.version).toBe(version);
    expect(err.message).toContain("version=2001-02-03");
    expect(err.message).toContain(JSON.stringify(body));
    expect(err.message).toContain(JSON.stringify(errors));
    expect(err.stack).toBeDefined();

    try {
      throw err;
    } catch (e) {
      expect(e).toBeInstanceOf(TsadwynHeadRequestValidationError);
    }
  });

  it("LintingError — extends TsadwynError", () => {
    const err = new LintingError("lint failed");
    expect(err).toBeInstanceOf(LintingError);
    expect(err).toBeInstanceOf(TsadwynError);
    expect(err.name).toBe("LintingError");
    expect(err.message).toBe("lint failed");
    expect(err.stack).toBeDefined();

    try {
      throw err;
    } catch (e) {
      expect(e).toBeInstanceOf(LintingError);
    }
  });

  it("LintingError — no-arg constructor", () => {
    const err = new LintingError();
    expect(err).toBeInstanceOf(LintingError);
    expect(err.name).toBe("LintingError");
  });

  it("RouterGenerationError — extends TsadwynError", () => {
    const err = new RouterGenerationError("gen bad");
    expect(err).toBeInstanceOf(RouterGenerationError);
    expect(err).toBeInstanceOf(TsadwynError);
    expect(err.name).toBe("RouterGenerationError");
    expect(err.message).toBe("gen bad");
    expect(err.stack).toBeDefined();

    try {
      throw err;
    } catch (e) {
      expect(e).toBeInstanceOf(RouterGenerationError);
    }
  });

  it("RouteAlreadyExistsError — extends RouterGenerationError, stores routes", () => {
    const err = new RouteAlreadyExistsError("GET /users", "GET /users/profile", "POST /users");
    expect(err).toBeInstanceOf(RouteAlreadyExistsError);
    expect(err).toBeInstanceOf(RouterGenerationError);
    expect(err).toBeInstanceOf(TsadwynError);
    expect(err.name).toBe("RouteAlreadyExistsError");
    expect(err.routes).toEqual(["GET /users", "GET /users/profile", "POST /users"]);
    expect(err.message).toContain("GET /users");
    expect(err.message).toContain("GET /users/profile");
    expect(err.message).toContain("POST /users");
    expect(err.stack).toBeDefined();

    try {
      throw err;
    } catch (e) {
      expect(e).toBeInstanceOf(RouteAlreadyExistsError);
    }
  });

  it("RouteAlreadyExistsError — handles zero routes", () => {
    const err = new RouteAlreadyExistsError();
    expect(err).toBeInstanceOf(RouteAlreadyExistsError);
    expect(err.routes).toEqual([]);
  });

  it("RouteByPathConverterDoesNotApplyToAnythingError — extends RouterGenerationError", () => {
    const err = new RouteByPathConverterDoesNotApplyToAnythingError("no matches for /foo");
    expect(err).toBeInstanceOf(RouteByPathConverterDoesNotApplyToAnythingError);
    expect(err).toBeInstanceOf(RouterGenerationError);
    expect(err).toBeInstanceOf(TsadwynError);
    expect(err.name).toBe("RouteByPathConverterDoesNotApplyToAnythingError");
    expect(err.message).toBe("no matches for /foo");
    expect(err.stack).toBeDefined();

    try {
      throw err;
    } catch (e) {
      expect(e).toBeInstanceOf(RouteByPathConverterDoesNotApplyToAnythingError);
    }
  });

  it("RouteRequestBySchemaConverterDoesNotApplyToAnythingError — extends RouterGenerationError", () => {
    const err = new RouteRequestBySchemaConverterDoesNotApplyToAnythingError(
      "no schema applies",
    );
    expect(err).toBeInstanceOf(RouteRequestBySchemaConverterDoesNotApplyToAnythingError);
    expect(err).toBeInstanceOf(RouterGenerationError);
    expect(err).toBeInstanceOf(TsadwynError);
    expect(err.name).toBe("RouteRequestBySchemaConverterDoesNotApplyToAnythingError");
    expect(err.message).toBe("no schema applies");
    expect(err.stack).toBeDefined();

    try {
      throw err;
    } catch (e) {
      expect(e).toBeInstanceOf(RouteRequestBySchemaConverterDoesNotApplyToAnythingError);
    }
  });

  it("RouteResponseBySchemaConverterDoesNotApplyToAnythingError — extends RouterGenerationError", () => {
    const err = new RouteResponseBySchemaConverterDoesNotApplyToAnythingError(
      "response schema unused",
    );
    expect(err).toBeInstanceOf(RouteResponseBySchemaConverterDoesNotApplyToAnythingError);
    expect(err).toBeInstanceOf(RouterGenerationError);
    expect(err).toBeInstanceOf(TsadwynError);
    expect(err.name).toBe("RouteResponseBySchemaConverterDoesNotApplyToAnythingError");
    expect(err.message).toBe("response schema unused");
    expect(err.stack).toBeDefined();

    try {
      throw err;
    } catch (e) {
      expect(e).toBeInstanceOf(RouteResponseBySchemaConverterDoesNotApplyToAnythingError);
    }
  });

  it("RouterPathParamsModifiedError — extends RouterGenerationError", () => {
    const err = new RouterPathParamsModifiedError("path params changed");
    expect(err).toBeInstanceOf(RouterPathParamsModifiedError);
    expect(err).toBeInstanceOf(RouterGenerationError);
    expect(err).toBeInstanceOf(TsadwynError);
    expect(err.name).toBe("RouterPathParamsModifiedError");
    expect(err.message).toBe("path params changed");
    expect(err.stack).toBeDefined();

    try {
      throw err;
    } catch (e) {
      expect(e).toBeInstanceOf(RouterPathParamsModifiedError);
    }
  });

  it("InvalidGenerationInstructionError — extends TsadwynError", () => {
    const err = new InvalidGenerationInstructionError("bad instruction");
    expect(err).toBeInstanceOf(InvalidGenerationInstructionError);
    expect(err).toBeInstanceOf(TsadwynError);
    expect(err.name).toBe("InvalidGenerationInstructionError");
    expect(err.message).toBe("bad instruction");
    expect(err.stack).toBeDefined();

    try {
      throw err;
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidGenerationInstructionError);
    }
  });

  it("ModuleIsNotVersionedError — extends TsadwynError", () => {
    const err = new ModuleIsNotVersionedError("module is not versioned");
    expect(err).toBeInstanceOf(ModuleIsNotVersionedError);
    expect(err).toBeInstanceOf(TsadwynError);
    expect(err.name).toBe("ModuleIsNotVersionedError");
    expect(err.message).toBe("module is not versioned");
    expect(err.stack).toBeDefined();

    try {
      throw err;
    } catch (e) {
      expect(e).toBeInstanceOf(ModuleIsNotVersionedError);
    }
  });

  it("ModuleIsNotVersionedError — no-arg constructor", () => {
    const err = new ModuleIsNotVersionedError();
    expect(err).toBeInstanceOf(ModuleIsNotVersionedError);
    expect(err.name).toBe("ModuleIsNotVersionedError");
  });

  it("HttpError — extends Error (NOT TsadwynError) with statusCode/body/headers", () => {
    const err = new HttpError(400, { message: "bad request" });
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TsadwynError);
    expect(err.name).toBe("HttpError");
    expect(err.statusCode).toBe(400);
    expect(err.body).toEqual({ message: "bad request" });
    expect(err.stack).toBeDefined();

    try {
      throw err;
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 2: HttpError specifics
// ═══════════════════════════════════════════════════════════════════════════

describe("Section 2: HttpError specifics", () => {
  it("defaults headers to {} when not provided", () => {
    const err = new HttpError(500, { detail: "oops" });
    expect(err.headers).toEqual({});
  });

  it("preserves custom headers", () => {
    const headers = {
      "retry-after": "60",
      "x-request-id": "abc-123",
      "content-type": "application/json",
    };
    const err = new HttpError(429, { detail: "rate limited" }, headers);
    expect(err.headers).toEqual(headers);
    expect(err.headers["retry-after"]).toBe("60");
    expect(err.headers["x-request-id"]).toBe("abc-123");
  });

  it("supports a string body (sets message to the string)", () => {
    const err = new HttpError(404, "not found");
    expect(err.body).toBe("not found");
    expect(err.message).toBe("not found");
    expect(err.statusCode).toBe(404);
  });

  it("supports an object body (sets message to JSON stringified)", () => {
    const body = { code: "ERR_NOT_FOUND", detail: "missing" };
    const err = new HttpError(404, body);
    expect(err.body).toBe(body);
    expect(err.message).toBe(JSON.stringify(body));
  });

  it("supports numeric body (JSON stringified in message)", () => {
    const err = new HttpError(418, 42);
    expect(err.body).toBe(42);
    expect(err.message).toBe(JSON.stringify(42));
  });

  it("supports empty headers object explicitly", () => {
    const err = new HttpError(500, "internal", {});
    expect(err.headers).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 3: Validation errors preserve their data
// ═══════════════════════════════════════════════════════════════════════════

describe("Section 3: validation errors preserve data", () => {
  it("TsadwynLatestRequestValidationError — preserves errors/body/version", () => {
    const errors = [
      { path: ["name"], message: "Required", code: "invalid_type" },
      { path: ["age"], message: "Expected number", code: "invalid_type" },
    ];
    const body = { name: null, age: "twenty" };
    const version = "2023-11-15";

    const err = new TsadwynLatestRequestValidationError(errors, body, version);

    expect(err.errors).toStrictEqual(errors);
    expect(err.body).toStrictEqual(body);
    expect(err.version).toBe(version);
    expect(err.message).toContain("Request validation failed after migrating to latest");
    expect(err.message).toContain(`version=${version}`);
    expect(err.message).toContain(JSON.stringify(body));
    expect(err.message).toContain(JSON.stringify(errors));
  });

  it("TsadwynHeadRequestValidationError — preserves errors/body/version", () => {
    const errors = [{ path: ["email"], message: "Invalid email" }];
    const body = { email: "not-an-email" };
    const version = "2024-06-01";

    const err = new TsadwynHeadRequestValidationError(errors, body, version);

    expect(err.errors).toStrictEqual(errors);
    expect(err.body).toStrictEqual(body);
    expect(err.version).toBe(version);
    expect(err.message).toContain("We failed to migrate the request");
    expect(err.message).toContain(`version=${version}`);
    expect(err.message).toContain(JSON.stringify(body));
    expect(err.message).toContain(JSON.stringify(errors));
  });

  it("RouteAlreadyExistsError — includes all route strings in the message", () => {
    const err = new RouteAlreadyExistsError(
      "GET /api/v1/users",
      "GET /api/v2/users",
      "GET /api/v3/users",
    );

    expect(err.message).toContain("GET /api/v1/users");
    expect(err.message).toContain("GET /api/v2/users");
    expect(err.message).toContain("GET /api/v3/users");
    expect(err.message).toContain("duplicates");
    expect(err.routes).toEqual([
      "GET /api/v1/users",
      "GET /api/v2/users",
      "GET /api/v3/users",
    ]);
  });
});
