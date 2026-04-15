import { describe, it, expect, expectTypeOf } from "vitest";
import { z } from "zod";
import {
  named,
  setSchemaName,
  getSchemaName,
  VersionedRouter,
} from "../src/index.js";

/**
 * Tests for the type-level contract of the `declare module "zod"` block
 * in zod-extend.ts — specifically that `.named` is OPTIONAL on `ZodType`.
 *
 * If `.named` were required (as it was in earlier versions), passing a
 * raw `z.object({...})` to any tsadwyn API that expects `ZodTypeAny`
 * would fail at compile time in downstream consumers because the
 * augmentation propagates globally once tsadwyn is imported. Raw zod
 * constructions don't implement `.named` at the type level — only at
 * runtime, via the prototype patch in zod-extend.
 *
 * Making it optional preserves the runtime behavior (prototype patch
 * unchanged) while letting raw zod values flow through tsadwyn's typed
 * APIs without a cast.
 */

describe(".named() is optional on the augmented ZodType", () => {
  it("raw z.object() without .named() chaining is still a ZodTypeAny", () => {
    // This ASSIGNMENT is the test — if .named were required, the raw
    // schema would fail to satisfy ZodTypeAny and tsc would error.
    // Runtime behavior is trivial; the compile-time check is the point.
    const raw = z.object({ id: z.string() });
    const asAny: z.ZodTypeAny = raw;
    expect(asAny).toBe(raw);

    // expectTypeOf asserts the type-level fact: ZodType's `named` member
    // is present but OPTIONAL. If it becomes required again (regression),
    // this expectation fails at compile time.
    expectTypeOf<z.ZodType["named"]>().toEqualTypeOf<
      ((name: string) => z.ZodType) | undefined
    >();
  });

  it("VersionedRouter.get accepts a raw zod schema as responseSchema", () => {
    // Before the fix, this line failed to compile in downstream consumers
    // with "Property 'named' is missing in type 'ZodObject<...>'". Raw
    // zod schemas don't have `.named` in their TS type — only at runtime.
    const router = new VersionedRouter();
    router.get(
      "/users/:id",
      null,
      z.object({ id: z.string() }), // raw — NOT .named()-ed
      async () => ({ id: "x" }),
    );
    expect(router.routes).toHaveLength(1);
    expect(router.routes[0].path).toBe("/users/:id");
  });

  it("named() helper accepts raw zod values and returns them unchanged", () => {
    // Generic T extends z.ZodTypeAny previously rejected raw zod types
    // for the same reason. With .named? optional, T satisfies ZodTypeAny.
    const raw = z.array(z.string());
    const tagged = named(raw, "StringArray");
    expect(tagged).toBe(raw);
    expect(getSchemaName(tagged)).toBe("StringArray");
    // The runtime prototype patch still attaches .named to every ZodType;
    // calling it with a non-null assertion (or optional chaining) works.
    expect(typeof raw.named).toBe("function");
  });

  it("runtime .named() chaining still works for users who want the fluent API", () => {
    // Non-null assertion is the ergonomic way to call an optional-typed
    // method when you know it's present at runtime. Users with a stricter
    // preference can use the named() helper instead.
    const schema = z.object({ ok: z.boolean() }).named!("OptionalChained");
    expect(getSchemaName(schema)).toBe("OptionalChained");
  });

  it("setSchemaName() continues to work on raw schemas as the no-type-dependency escape hatch", () => {
    const raw = z.number();
    setSchemaName(raw, "AnInt");
    expect(getSchemaName(raw)).toBe("AnInt");
  });
});
