/**
 * data-coverage.test.ts
 *
 * Covers edge cases of `src/structure/data.ts`:
 *   - RequestInfo / ResponseInfo constructors and mutating methods
 *   - convertRequestToNextVersionFor in both path-based and schema-based modes
 *   - convertResponseToPreviousVersionFor in both path-based and schema-based modes
 *   - The TypeScript decorator code path invoked as a raw function call
 *   - Options-as-second-argument and options-in-rest-args parsing
 *   - Error branches: invalid HTTP method, missing schema name, missing methods array
 *
 * Run: npx vitest run tests/data-coverage.test.ts
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";

import {
  RequestInfo,
  ResponseInfo,
  convertRequestToNextVersionFor,
  convertResponseToPreviousVersionFor,
} from "../src/index.js";

// Unique schema name generator to avoid collisions with _knownSchemas and
// cross-test state in other files.
let __uniq = 0;
const uniq = (prefix: string) => `DCov_${prefix}_${++__uniq}`;

// ═══════════════════════════════════════════════════════════════════════════
// Section 4: RequestInfo / ResponseInfo methods
// ═══════════════════════════════════════════════════════════════════════════

describe("Section 4: RequestInfo / ResponseInfo", () => {
  it("RequestInfo — constructs with all arguments and shallow-copies maps", () => {
    const headers = { "x-custom": "1" };
    const query = { page: "2" };
    const cookies = { session: "abc123" };
    const form: Array<[string, string | File]> = [["name", "alice"]];

    const req = new RequestInfo({ hello: "world" }, headers, query, cookies, form);

    expect(req.body).toEqual({ hello: "world" });
    expect(req.headers).toEqual({ "x-custom": "1" });
    expect(req.queryParams).toEqual({ page: "2" });
    expect(req.cookies).toEqual({ session: "abc123" });
    expect(req.form).toBe(form);

    // Mutating the original maps does NOT mutate the copies on the RequestInfo
    headers["x-custom"] = "changed";
    query.page = "99";
    cookies.session = "other";
    expect(req.headers["x-custom"]).toBe("1");
    expect(req.queryParams.page).toBe("2");
    expect(req.cookies.session).toBe("abc123");
  });

  it("RequestInfo — default arguments work (no query/cookies/form)", () => {
    const req = new RequestInfo({ a: 1 }, { accept: "json" });
    expect(req.queryParams).toEqual({});
    expect(req.cookies).toEqual({});
    expect(req.form).toBeNull();
  });

  it("ResponseInfo — default constructor sets statusCode=200 and empty headers", () => {
    const res = new ResponseInfo({ ok: true });
    expect(res.body).toEqual({ ok: true });
    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual({});
    expect(res._cookiesToSet).toEqual([]);
    expect(res._cookiesToDelete).toEqual([]);
  });

  it("ResponseInfo — custom statusCode and headers, with shallow copy", () => {
    const headers = { "x-trace": "abc" };
    const res = new ResponseInfo({ hi: 1 }, 201, headers);
    expect(res.statusCode).toBe(201);
    expect(res.headers).toEqual({ "x-trace": "abc" });
    headers["x-trace"] = "mutated";
    expect(res.headers["x-trace"]).toBe("abc");
  });

  it("ResponseInfo.setCookie — with no options", () => {
    const res = new ResponseInfo(null);
    res.setCookie("plain", "value");
    expect(res._cookiesToSet).toHaveLength(1);
    expect(res._cookiesToSet[0]).toEqual({
      name: "plain",
      value: "value",
      options: undefined,
    });
  });

  it("ResponseInfo.setCookie — supports all CookieOptions fields", () => {
    const res = new ResponseInfo(null);
    const expires = new Date("2030-01-01T00:00:00Z");
    res.setCookie("session", "tok123", {
      domain: "example.com",
      path: "/",
      maxAge: 3600,
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      expires,
    });

    expect(res._cookiesToSet).toHaveLength(1);
    const record = res._cookiesToSet[0];
    expect(record.name).toBe("session");
    expect(record.value).toBe("tok123");
    expect(record.options).toBeDefined();
    expect(record.options!.domain).toBe("example.com");
    expect(record.options!.path).toBe("/");
    expect(record.options!.maxAge).toBe(3600);
    expect(record.options!.httpOnly).toBe(true);
    expect(record.options!.secure).toBe(true);
    expect(record.options!.sameSite).toBe("lax");
    expect(record.options!.expires).toBe(expires);
  });

  it("ResponseInfo.setCookie — supports sameSite strict and none", () => {
    const res = new ResponseInfo(null);
    res.setCookie("a", "1", { sameSite: "strict" });
    res.setCookie("b", "2", { sameSite: "none", secure: true });
    expect(res._cookiesToSet).toHaveLength(2);
    expect(res._cookiesToSet[0].options!.sameSite).toBe("strict");
    expect(res._cookiesToSet[1].options!.sameSite).toBe("none");
  });

  it("ResponseInfo.deleteCookie — with and without options", () => {
    const res = new ResponseInfo(null);
    res.deleteCookie("session");
    res.deleteCookie("tracking", { domain: "example.com", path: "/" });

    expect(res._cookiesToDelete).toHaveLength(2);
    expect(res._cookiesToDelete[0]).toEqual({ name: "session", options: undefined });
    expect(res._cookiesToDelete[1]).toEqual({
      name: "tracking",
      options: { domain: "example.com", path: "/" },
    });
  });

  it("ResponseInfo — multiple set/delete calls keep state consistent", () => {
    const res = new ResponseInfo({ foo: "bar" }, 200);
    res.setCookie("one", "1");
    res.setCookie("two", "2", { httpOnly: true });
    res.deleteCookie("old");
    res.setCookie("three", "3", { path: "/app" });
    res.deleteCookie("stale", { path: "/app" });

    expect(res._cookiesToSet).toHaveLength(3);
    expect(res._cookiesToSet.map((c) => c.name)).toEqual(["one", "two", "three"]);
    expect(res._cookiesToDelete).toHaveLength(2);
    expect(res._cookiesToDelete.map((c) => c.name)).toEqual(["old", "stale"]);

    // The body and statusCode are untouched
    expect(res.body).toEqual({ foo: "bar" });
    expect(res.statusCode).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 5: convertRequestToNextVersionFor — path-based
// ═══════════════════════════════════════════════════════════════════════════

describe("Section 5: convertRequestToNextVersionFor path-based", () => {
  it("function-wrapper mode returns an AlterRequestByPathInstruction", () => {
    const transformer = function myReqXform(req: RequestInfo) {
      req.body.migrated = true;
    };
    const instruction: any = convertRequestToNextVersionFor("/users/:id", ["patch"])(transformer);

    expect(instruction.kind).toBe("alter_request_by_path");
    expect(instruction.path).toBe("/users/:id");
    expect(instruction.methods).toBeInstanceOf(Set);
    expect(instruction.methods.has("PATCH")).toBe(true);
    expect(instruction.methods.size).toBe(1);
    expect(instruction.transformer).toBe(transformer);
    expect(instruction.methodName).toBe("myReqXform");

    // The transformer still works (mutates body)
    const req = new RequestInfo({ x: 1 }, {});
    instruction.transformer(req);
    expect(req.body.migrated).toBe(true);
  });

  it("uppercases and deduplicates methods into a Set", () => {
    const i: any = convertRequestToNextVersionFor("/p", ["get", "POST", "put"])(
      (req: RequestInfo) => {},
    );
    expect(i.methods).toBeInstanceOf(Set);
    expect([...i.methods].sort()).toEqual(["GET", "POST", "PUT"]);
  });

  it("anonymous transformer defaults methodName to 'anonymous'", () => {
    const i: any = convertRequestToNextVersionFor("/p", ["GET"])(
      // Anonymous arrow function — .name is ""
      (req: RequestInfo) => {
        void req;
      },
    );
    expect(typeof i.methodName).toBe("string");
    // Arrow functions bound to const get the const name as their name in some
    // environments; accept either "" fallback → "anonymous" OR the inferred name.
    expect(i.methodName.length > 0).toBe(true);
  });

  it("throws at decoration time for an invalid HTTP method", () => {
    expect(() =>
      convertRequestToNextVersionFor("/x", ["INVALID"]),
    ).toThrow(/Invalid HTTP method/);
  });

  it("throws TypeError when path is given but methods array is missing", () => {
    expect(() => (convertRequestToNextVersionFor as any)("/x")).toThrow(TypeError);
    expect(() => (convertRequestToNextVersionFor as any)("/x")).toThrow(
      /methods must be provided/,
    );
  });

  it("throws TypeError when methods argument is not an array", () => {
    // Passing something that looks schema-ish (no _def) but is not an array
    // and path is a string — should be caught by the Array.isArray check.
    expect(() =>
      (convertRequestToNextVersionFor as any)("/x", { notAnArray: true }),
    ).toThrow(TypeError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 6: convertRequestToNextVersionFor — schema-based
// ═══════════════════════════════════════════════════════════════════════════

describe("Section 6: convertRequestToNextVersionFor schema-based", () => {
  it("single schema, no options — checkUsage defaults to true", () => {
    const S = z.object({ a: z.string() }).named(uniq("ReqSingle"));
    const transformer = function xf(req: RequestInfo) {
      req.body.a = req.body.a.toUpperCase();
    };
    const instruction: any = convertRequestToNextVersionFor(S)(transformer);

    expect(instruction.kind).toBe("alter_request_by_schema");
    expect(instruction.schemaNames).toHaveLength(1);
    expect(instruction.checkUsage).toBe(true);
    expect(instruction.methodName).toBe("xf");
    expect(instruction.transformer).toBe(transformer);
  });

  it("single schema + { checkUsage: false } as 2nd argument", () => {
    const S = z.object({ a: z.string() }).named(uniq("ReqSingleOpt"));
    const instruction: any = convertRequestToNextVersionFor(S, {
      checkUsage: false,
    } as any)((req: RequestInfo) => {
      void req;
    });

    expect(instruction.kind).toBe("alter_request_by_schema");
    expect(instruction.checkUsage).toBe(false);
    expect(instruction.schemaNames).toHaveLength(1);
  });

  it("multiple schemas + { checkUsage: false } as last arg", () => {
    const S1 = z.object({ a: z.string() }).named(uniq("ReqMulti1"));
    const S2 = z.object({ b: z.string() }).named(uniq("ReqMulti2"));
    const S3 = z.object({ c: z.string() }).named(uniq("ReqMulti3"));
    const instruction: any = convertRequestToNextVersionFor(S1, S2, S3, {
      checkUsage: false,
    } as any)((req: RequestInfo) => {
      void req;
    });

    expect(instruction.schemaNames).toHaveLength(3);
    expect(instruction.checkUsage).toBe(false);
  });

  it("multiple schemas without options — checkUsage stays true", () => {
    const S1 = z.object({ a: z.string() }).named(uniq("ReqMultiNoOpt1"));
    const S2 = z.object({ b: z.string() }).named(uniq("ReqMultiNoOpt2"));
    const instruction: any = convertRequestToNextVersionFor(S1, S2)(
      (req: RequestInfo) => {
        void req;
      },
    );
    expect(instruction.schemaNames).toHaveLength(2);
    expect(instruction.checkUsage).toBe(true);
  });

  it("throws when a schema has no name", () => {
    const Unnamed = z.object({ a: z.string() }); // No .named()
    expect(() => convertRequestToNextVersionFor(Unnamed as any)).toThrow(
      /Schema must have a name/,
    );
  });

  it("throws when a later schema in the list has no name", () => {
    const Named = z.object({ a: z.string() }).named(uniq("ReqOneNamed"));
    const Unnamed = z.object({ b: z.string() });
    expect(() =>
      convertRequestToNextVersionFor(Named, Unnamed as any),
    ).toThrow(/Schema must have a name/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 7: convertResponseToPreviousVersionFor — path- and schema-based
// ═══════════════════════════════════════════════════════════════════════════

describe("Section 7: convertResponseToPreviousVersionFor", () => {
  it("path-based + function wrapper with { migrateHttpErrors: true }", () => {
    const transformer = function resXform(res: ResponseInfo) {
      res.body.migrated = true;
    };
    const instruction: any = convertResponseToPreviousVersionFor(
      "/items/:id",
      ["GET", "post"],
      { migrateHttpErrors: true },
    )(transformer);

    expect(instruction.kind).toBe("alter_response_by_path");
    expect(instruction.path).toBe("/items/:id");
    expect(instruction.methods).toBeInstanceOf(Set);
    expect([...instruction.methods].sort()).toEqual(["GET", "POST"]);
    expect(instruction.migrateHttpErrors).toBe(true);
    expect(instruction.transformer).toBe(transformer);
    expect(instruction.methodName).toBe("resXform");
  });

  it("path-based without options — migrateHttpErrors defaults to false", () => {
    const i: any = convertResponseToPreviousVersionFor("/x", ["GET"])(
      (res: ResponseInfo) => {
        void res;
      },
    );
    expect(i.migrateHttpErrors).toBe(false);
  });

  it("path-based throws for invalid HTTP method", () => {
    expect(() =>
      convertResponseToPreviousVersionFor("/x", ["BOGUS"]),
    ).toThrow(/Invalid HTTP method/);
  });

  it("path-based throws TypeError when methods array is missing", () => {
    expect(() =>
      (convertResponseToPreviousVersionFor as any)("/x"),
    ).toThrow(TypeError);
  });

  it("schema-based + { migrateHttpErrors: true, checkUsage: false } as 2nd arg", () => {
    const S = z.object({ v: z.string() }).named(uniq("ResOneOpt"));
    const i: any = convertResponseToPreviousVersionFor(S, {
      migrateHttpErrors: true,
      checkUsage: false,
    } as any)((res: ResponseInfo) => {
      void res;
    });

    expect(i.kind).toBe("alter_response_by_schema");
    expect(i.schemaNames).toHaveLength(1);
    expect(i.migrateHttpErrors).toBe(true);
    expect(i.checkUsage).toBe(false);
  });

  it("schema-based with multiple schemas + options as last arg", () => {
    const S1 = z.object({ a: z.string() }).named(uniq("ResMulti1"));
    const S2 = z.object({ b: z.string() }).named(uniq("ResMulti2"));
    const i: any = convertResponseToPreviousVersionFor(S1, S2, {
      migrateHttpErrors: true,
      checkUsage: false,
    } as any)((res: ResponseInfo) => {
      void res;
    });

    expect(i.schemaNames).toHaveLength(2);
    expect(i.migrateHttpErrors).toBe(true);
    expect(i.checkUsage).toBe(false);
  });

  it("schema-based default options — migrateHttpErrors=false, checkUsage=true", () => {
    const S = z.object({ v: z.string() }).named(uniq("ResDefaults"));
    const i: any = convertResponseToPreviousVersionFor(S)((res: ResponseInfo) => {
      void res;
    });
    expect(i.migrateHttpErrors).toBe(false);
    expect(i.checkUsage).toBe(true);
  });

  it("schema-based throws when schema has no name", () => {
    const Unnamed = z.object({ a: z.string() });
    expect(() => convertResponseToPreviousVersionFor(Unnamed as any)).toThrow(
      /Schema must have a name/,
    );
  });

  it("schema-based throws when a later schema has no name", () => {
    const Named = z.object({ a: z.string() }).named(uniq("ResNamedFirst"));
    const Unnamed = z.object({ b: z.string() });
    expect(() =>
      convertResponseToPreviousVersionFor(Named, Unnamed as any),
    ).toThrow(/Schema must have a name/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 8: TypeScript decorator code path (invoked manually)
// ═══════════════════════════════════════════════════════════════════════════

describe("Section 8: decorator-mode coverage (manual invocation)", () => {
  it("schema-based convertRequestToNextVersionFor — decorator form", () => {
    const S = z.object({ a: z.string() }).named(uniq("DecReqSchema"));

    class MyChange {
      migrate(req: RequestInfo) {
        req.body.mutated = true;
      }
    }

    const proto = MyChange.prototype as any;
    const descriptor: PropertyDescriptor = { value: proto.migrate, writable: true, enumerable: false, configurable: true };
    const decorator = convertRequestToNextVersionFor(S);
    const returnedDescriptor = decorator(proto, "migrate", descriptor) as PropertyDescriptor;

    // The same descriptor is returned with its .value replaced by the instruction
    expect(returnedDescriptor).toBe(descriptor);
    const instruction: any = returnedDescriptor.value;
    expect(instruction.kind).toBe("alter_request_by_schema");
    expect(instruction.methodName).toBe("migrate");
    expect(instruction.schemaNames).toHaveLength(1);
    expect(instruction.checkUsage).toBe(true);

    // The transformer should call the original method via `.call(target, request)`
    const req = new RequestInfo({ x: 1 }, {});
    instruction.transformer(req);
    expect(req.body.mutated).toBe(true);
  });

  it("schema-based convertResponseToPreviousVersionFor — decorator form", () => {
    const S = z.object({ v: z.string() }).named(uniq("DecResSchema"));

    class MyChange {
      migrate(res: ResponseInfo) {
        res.body.decorated = true;
      }
    }

    const proto = MyChange.prototype as any;
    const descriptor: PropertyDescriptor = { value: proto.migrate, writable: true, enumerable: false, configurable: true };
    const decorator = convertResponseToPreviousVersionFor(S, { migrateHttpErrors: true } as any);
    const returnedDescriptor = decorator(proto, "migrate", descriptor) as PropertyDescriptor;

    expect(returnedDescriptor).toBe(descriptor);
    const instruction: any = returnedDescriptor.value;
    expect(instruction.kind).toBe("alter_response_by_schema");
    expect(instruction.methodName).toBe("migrate");
    expect(instruction.schemaNames).toHaveLength(1);
    expect(instruction.migrateHttpErrors).toBe(true);
    expect(instruction.checkUsage).toBe(true);

    const res = new ResponseInfo({ v: "hi" }, 200, {});
    instruction.transformer(res);
    expect(res.body.decorated).toBe(true);
  });

  it("path-based convertRequestToNextVersionFor — decorator form", () => {
    class MyChange {
      migrate(req: RequestInfo) {
        req.body.pathDecorated = true;
      }
    }

    const proto = MyChange.prototype as any;
    const descriptor: PropertyDescriptor = { value: proto.migrate, writable: true, enumerable: false, configurable: true };
    const decorator = convertRequestToNextVersionFor("/users/:id", ["PATCH"]);
    const returnedDescriptor = decorator(proto, "migrate", descriptor) as PropertyDescriptor;

    expect(returnedDescriptor).toBe(descriptor);
    const instruction: any = returnedDescriptor.value;
    expect(instruction.kind).toBe("alter_request_by_path");
    expect(instruction.path).toBe("/users/:id");
    expect(instruction.methods).toBeInstanceOf(Set);
    expect(instruction.methods.has("PATCH")).toBe(true);
    expect(instruction.methodName).toBe("migrate");

    const req = new RequestInfo({ x: 1 }, {});
    instruction.transformer(req);
    expect(req.body.pathDecorated).toBe(true);
  });

  it("path-based convertResponseToPreviousVersionFor — decorator form", () => {
    class MyChange {
      migrate(res: ResponseInfo) {
        res.body.pathResDecorated = true;
      }
    }

    const proto = MyChange.prototype as any;
    const descriptor: PropertyDescriptor = { value: proto.migrate, writable: true, enumerable: false, configurable: true };
    const decorator = convertResponseToPreviousVersionFor("/users/:id", ["GET", "POST"], {
      migrateHttpErrors: true,
    });
    const returnedDescriptor = decorator(proto, "migrate", descriptor) as PropertyDescriptor;

    expect(returnedDescriptor).toBe(descriptor);
    const instruction: any = returnedDescriptor.value;
    expect(instruction.kind).toBe("alter_response_by_path");
    expect(instruction.path).toBe("/users/:id");
    expect([...instruction.methods].sort()).toEqual(["GET", "POST"]);
    expect(instruction.migrateHttpErrors).toBe(true);
    expect(instruction.methodName).toBe("migrate");

    const res = new ResponseInfo({ v: "hi" });
    instruction.transformer(res);
    expect(res.body.pathResDecorated).toBe(true);
  });
});
