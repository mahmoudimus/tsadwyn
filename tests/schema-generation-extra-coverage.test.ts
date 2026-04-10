/**
 * Extra coverage tests for `src/schema-generation.ts` and `src/structure/schemas.ts`.
 *
 * These tests focus on code paths not yet covered by
 * `schema-generation-coverage.test.ts`:
 *   - ZodSchemaRegistry enum registry (register/get/has/clone)
 *   - transformSchemaReferences for ZodRecord / ZodMap / ZodSet / ZodLazy /
 *     ZodEffects / ZodPipeline (including short-circuit paths)
 *   - applyFieldHad constraint branches for strings / numbers
 *   - removeConstraint branches for string / number / array types
 *   - applyValidatorExisted / applyValidatorDidntExist (named refinements)
 *   - applyComputedFieldExisted / applyComputedFieldDidntExist
 *   - applyEnumInstruction (both had_members and didnt_have_members)
 *   - hidden() for both VersionChange classes and plain instruction objects
 */
import { describe, it, expect } from "vitest";
import {
  z,
  ZodString,
  ZodNumber,
  ZodObject,
  ZodArray,
  ZodRecord,
  ZodMap,
  ZodSet,
  ZodLazy,
  ZodEffects,
  ZodPipeline,
  ZodEnum,
  ZodTypeAny,
} from "zod";
import {
  ZodSchemaRegistry,
  generateVersionedSchemas,
  transformSchemaReferences,
  schema,
  enum_,
  namedRefine,
  namedComputedField,
  hidden,
  Version,
  VersionBundle,
  VersionChange,
  InvalidGenerationInstructionError,
} from "../src/index.js";
import type { PossibleInstruction } from "../src/structure/versions.js";

// ────────────────────────────────────────────────────────────────────────
// Helpers (kept local so tests are self-contained vs. the other test file)
// ────────────────────────────────────────────────────────────────────────

/** Build an anonymous VersionChange subclass from a list of instructions. */
function makeChange(instructions: PossibleInstruction[]) {
  class AnonChange extends VersionChange {
    description = "extra-cov test change";
    instructions = instructions;
  }
  return AnonChange;
}

/**
 * Register schemas under their names and call generateVersionedSchemas with a
 * two-version bundle.  Returns the map of version -> registry.
 */
function runTwoVersionGen(
  schemas: Record<string, ZodTypeAny>,
  instructions: PossibleInstruction[],
) {
  const registry = new ZodSchemaRegistry();
  for (const [name, s] of Object.entries(schemas)) {
    registry.register(name, s);
  }
  const ChangeCls = makeChange(instructions);
  const bundle = new VersionBundle(
    new Version("2001-01-01", ChangeCls),
    new Version("2000-01-01"),
  );
  return generateVersionedSchemas(bundle, registry);
}

// ════════════════════════════════════════════════════════════════════════
// Section 1: ZodSchemaRegistry enum registry
// ════════════════════════════════════════════════════════════════════════

describe("Section 1: ZodSchemaRegistry enum registry", () => {
  it("registers a z.enum and returns all members via getEnum", () => {
    const registry = new ZodSchemaRegistry();
    const Colors = z.enum(["red", "green", "blue"]).named("SGExtra_Colors");
    registry.registerEnum("SGExtra_Colors", Colors);

    const entry = registry.getEnum("SGExtra_Colors");
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("SGExtra_Colors");
    expect(entry!.members).toEqual({ red: "red", green: "green", blue: "blue" });
  });

  it("registers a numeric nativeEnum and skips reverse mappings", () => {
    enum NumericStatus {
      Draft = 0,
      Published = 1,
      Archived = 2,
    }
    const registry = new ZodSchemaRegistry();
    const NStatus = z.nativeEnum(NumericStatus).named("SGExtra_NumStatus");
    registry.registerEnum("SGExtra_NumStatus", NStatus);

    const entry = registry.getEnum("SGExtra_NumStatus")!;
    // Reverse mappings ("0", "1", "2") should be skipped; only the named
    // members remain, each pointing at its numeric value.
    expect(Object.keys(entry.members).sort()).toEqual(
      ["Archived", "Draft", "Published"],
    );
    // Numeric values are preserved as-is (not stringified to the reverse key).
    expect(entry.members.Draft).toBe(0 as any);
    expect(entry.members.Published).toBe(1 as any);
    expect(entry.members.Archived).toBe(2 as any);
  });

  it("registers a string nativeEnum and retains every member", () => {
    enum StringRole {
      Admin = "admin",
      User = "user",
      Guest = "guest",
    }
    const registry = new ZodSchemaRegistry();
    const RoleSchema = z.nativeEnum(StringRole).named("SGExtra_StrRole");
    registry.registerEnum("SGExtra_StrRole", RoleSchema);

    const entry = registry.getEnum("SGExtra_StrRole")!;
    expect(entry.members).toEqual({
      Admin: "admin",
      User: "user",
      Guest: "guest",
    });
  });

  it("hasEnum returns true for registered and false for unregistered enums", () => {
    const registry = new ZodSchemaRegistry();
    const Priority = z.enum(["low", "high"]).named("SGExtra_Priority");
    registry.registerEnum("SGExtra_Priority", Priority);

    expect(registry.hasEnum("SGExtra_Priority")).toBe(true);
    expect(registry.hasEnum("SGExtra_DoesNotExist")).toBe(false);
  });

  it("clone() copies enum registry entries independently", () => {
    const registry = new ZodSchemaRegistry();
    const Flavor = z.enum(["sweet", "sour"]).named("SGExtra_Flavor");
    registry.registerEnum("SGExtra_Flavor", Flavor);

    const cloned = registry.clone();
    const clonedEntry = cloned.getEnum("SGExtra_Flavor");
    expect(clonedEntry).toBeDefined();
    expect(clonedEntry!.members).toEqual({ sweet: "sweet", sour: "sour" });

    // Mutating the clone's members map must not leak back into the original.
    clonedEntry!.members.bitter = "bitter";
    expect(registry.getEnum("SGExtra_Flavor")!.members).toEqual({
      sweet: "sweet",
      sour: "sour",
    });
  });
});

// ════════════════════════════════════════════════════════════════════════
// Section 2: transformSchemaReferences — rare container types
// ════════════════════════════════════════════════════════════════════════

describe("Section 2: transformSchemaReferences — rare container types", () => {
  /** Create a fresh registry containing a "versioned" Inner under the given name. */
  function makeRegistry(name: string, versionedInner: ZodTypeAny) {
    const registry = new ZodSchemaRegistry();
    registry.register(name, versionedInner);
    return registry;
  }

  // ─ Records ────────────────────────────────────────────────────────────

  it("ZodRecord with named inner as value type is replaced", () => {
    const Inner = z.object({ v: z.string() }).named("SGExtra_RecInner");
    const VersionedInner = z.object({ v: z.number() }).named("SGExtra_RecInner");
    const registry = makeRegistry("SGExtra_RecInner", VersionedInner);

    const rec = z.record(z.string(), Inner);
    const transformed = transformSchemaReferences(rec, registry) as ZodRecord<any, any>;
    expect(transformed).toBeInstanceOf(ZodRecord);
    const vt = (transformed._def as any).valueType as ZodObject<any>;
    expect(vt).toBeInstanceOf(ZodObject);
    expect(vt.shape.v).toBeInstanceOf(ZodNumber);
  });

  it("ZodRecord with a plain-value type returns the same instance", () => {
    const Inner = z.object({ v: z.string() }).named("SGExtra_RecNoopInner");
    // Registry contains Inner, but the record's value type is primitive.
    const registry = makeRegistry("SGExtra_RecNoopInner", Inner);
    const rec = z.record(z.string(), z.number());
    const transformed = transformSchemaReferences(rec, registry);
    expect(transformed).toBe(rec); // short-circuit path
  });

  // ─ Maps ───────────────────────────────────────────────────────────────

  it("ZodMap with named inner value type is replaced", () => {
    const Inner = z.object({ name: z.string() }).named("SGExtra_MapValInner");
    const Versioned = z.object({ name: z.number() }).named("SGExtra_MapValInner");
    const registry = makeRegistry("SGExtra_MapValInner", Versioned);

    const m = z.map(z.string(), Inner);
    const transformed = transformSchemaReferences(m, registry) as ZodMap<any, any>;
    expect(transformed).toBeInstanceOf(ZodMap);
    const vt = (transformed._def as any).valueType as ZodObject<any>;
    expect(vt.shape.name).toBeInstanceOf(ZodNumber);
  });

  it("ZodMap with named inner KEY type is replaced", () => {
    const Inner = z.object({ id: z.string() }).named("SGExtra_MapKeyInner");
    const Versioned = z.object({ id: z.number() }).named("SGExtra_MapKeyInner");
    const registry = makeRegistry("SGExtra_MapKeyInner", Versioned);

    const m = z.map(Inner, z.string());
    const transformed = transformSchemaReferences(m, registry) as ZodMap<any, any>;
    expect(transformed).toBeInstanceOf(ZodMap);
    const kt = (transformed._def as any).keyType as ZodObject<any>;
    expect(kt.shape.id).toBeInstanceOf(ZodNumber);
  });

  it("ZodMap with no replaceable inner returns the same instance", () => {
    const Inner = z.object({ id: z.string() }).named("SGExtra_MapNoopInner");
    const registry = makeRegistry("SGExtra_MapNoopInner", Inner);
    const m = z.map(z.string(), z.number());
    expect(transformSchemaReferences(m, registry)).toBe(m);
  });

  // ─ Sets ───────────────────────────────────────────────────────────────

  it("ZodSet with named inner element type is replaced", () => {
    const Inner = z.object({ k: z.string() }).named("SGExtra_SetInner");
    const Versioned = z.object({ k: z.number() }).named("SGExtra_SetInner");
    const registry = makeRegistry("SGExtra_SetInner", Versioned);

    const s = z.set(Inner);
    const transformed = transformSchemaReferences(s, registry) as ZodSet<any>;
    expect(transformed).toBeInstanceOf(ZodSet);
    const vt = (transformed._def as any).valueType as ZodObject<any>;
    expect(vt.shape.k).toBeInstanceOf(ZodNumber);
  });

  it("ZodSet with a primitive element returns the same instance", () => {
    const Inner = z.object({ k: z.string() }).named("SGExtra_SetNoopInner");
    const registry = makeRegistry("SGExtra_SetNoopInner", Inner);
    const s = z.set(z.string());
    expect(transformSchemaReferences(s, registry)).toBe(s);
  });

  // ─ Lazy ───────────────────────────────────────────────────────────────

  it("ZodLazy wrapping a named inner returns a new lazy that resolves to versioned", () => {
    const Inner = z.object({ n: z.string() }).named("SGExtra_LazyInner");
    const Versioned = z.object({ n: z.number() }).named("SGExtra_LazyInner");
    const registry = makeRegistry("SGExtra_LazyInner", Versioned);

    const lazy = z.lazy(() => Inner);
    const transformed = transformSchemaReferences(lazy, registry) as ZodLazy<any>;
    expect(transformed).toBeInstanceOf(ZodLazy);
    // Pull the getter to verify it resolves to the versioned inner
    const resolved = (transformed._def as any).getter() as ZodObject<any>;
    expect(resolved.shape.n).toBeInstanceOf(ZodNumber);
  });

  it("ZodLazy wrapping an unrelated schema still yields a lazy (same resolved value)", () => {
    const Inner = z.object({ n: z.string() }).named("SGExtra_LazyNoopInner");
    const registry = makeRegistry("SGExtra_LazyNoopInner", Inner);

    const inner = z.string();
    const lazy = z.lazy(() => inner);
    const transformed = transformSchemaReferences(lazy, registry) as ZodLazy<any>;
    expect(transformed).toBeInstanceOf(ZodLazy);
    const resolved = (transformed._def as any).getter();
    expect(resolved).toBe(inner);
  });

  // ─ Effects (refine/transform) ─────────────────────────────────────────

  it("ZodEffects wrapping a named inner is rebuilt with the versioned inner", () => {
    const Inner = z.object({ q: z.string() }).named("SGExtra_EffInner");
    const Versioned = z.object({ q: z.number() }).named("SGExtra_EffInner");
    const registry = makeRegistry("SGExtra_EffInner", Versioned);

    const refined = Inner.refine((val) => (val as any).q !== undefined);
    expect(refined).toBeInstanceOf(ZodEffects);

    const transformed = transformSchemaReferences(refined, registry) as ZodEffects<any>;
    expect(transformed).toBeInstanceOf(ZodEffects);
    const innerSchema = (transformed._def as any).schema as ZodObject<any>;
    expect(innerSchema.shape.q).toBeInstanceOf(ZodNumber);
  });

  it("ZodEffects with an inner that does not need replacement returns the same instance", () => {
    const Inner = z.object({ q: z.string() }).named("SGExtra_EffNoopInner");
    // The registry does NOT contain the effect's inner schema by name,
    // so the transform should short-circuit.
    const registry = new ZodSchemaRegistry();
    const refined = z.string().refine(() => true);
    const transformed = transformSchemaReferences(refined, registry);
    expect(transformed).toBe(refined);
    // Use Inner so the variable is not unused:
    expect(Inner).toBeInstanceOf(ZodObject);
  });

  // ─ Pipelines ──────────────────────────────────────────────────────────

  it("ZodPipeline rebuilds both in and out when inner schemas are replaced", () => {
    const Inner = z.object({ pipe: z.string() }).named("SGExtra_PipeInner");
    const Versioned = z.object({ pipe: z.number() }).named("SGExtra_PipeInner");
    const registry = makeRegistry("SGExtra_PipeInner", Versioned);

    const pipeline = Inner.pipe(Inner);
    expect(pipeline).toBeInstanceOf(ZodPipeline);

    const transformed = transformSchemaReferences(pipeline, registry) as ZodPipeline<any, any>;
    expect(transformed).toBeInstanceOf(ZodPipeline);
    const inSchema = (transformed._def as any).in as ZodObject<any>;
    const outSchema = (transformed._def as any).out as ZodObject<any>;
    expect(inSchema.shape.pipe).toBeInstanceOf(ZodNumber);
    expect(outSchema.shape.pipe).toBeInstanceOf(ZodNumber);
  });

  it("ZodPipeline with unrelated inner schemas returns the same instance", () => {
    const registry = new ZodSchemaRegistry();
    const pipeline = z.string().pipe(z.string());
    expect(transformSchemaReferences(pipeline, registry)).toBe(pipeline);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Section 3: applyFieldHad — constraint application branches
// ════════════════════════════════════════════════════════════════════════

/** Helper to fetch a check of a given kind off a ZodString/ZodNumber/etc. */
function findCheck(
  s: ZodTypeAny,
  kind: string,
  inclusive?: boolean,
): any | undefined {
  const checks = ((s as any)._def?.checks ?? []) as any[];
  return checks.find(
    (c) => c.kind === kind && (inclusive === undefined || c.inclusive === inclusive),
  );
}

describe("Section 3: applyFieldHad — constraint application", () => {
  it("string field had minLength", () => {
    const S = z.object({ name: z.string() }).named("SGExtra_S3MinLen");
    const versions = runTwoVersionGen(
      { SGExtra_S3MinLen: S },
      [schema(S).field("name").had({ minLength: 5 })],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S3MinLen")!.schema as ZodObject<any>;
    expect(findCheck(v1.shape.name, "min")?.value).toBe(5);
  });

  it("string field had maxLength", () => {
    const S = z.object({ name: z.string() }).named("SGExtra_S3MaxLen");
    const versions = runTwoVersionGen(
      { SGExtra_S3MaxLen: S },
      [schema(S).field("name").had({ maxLength: 100 })],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S3MaxLen")!.schema as ZodObject<any>;
    expect(findCheck(v1.shape.name, "max")?.value).toBe(100);
  });

  it("string field had regex", () => {
    const S = z.object({ slug: z.string() }).named("SGExtra_S3Regex");
    const versions = runTwoVersionGen(
      { SGExtra_S3Regex: S },
      [schema(S).field("slug").had({ regex: /^[a-z]+$/ })],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S3Regex")!.schema as ZodObject<any>;
    const check = findCheck(v1.shape.slug, "regex");
    expect(check).toBeDefined();
    expect(check.regex.source).toBe("^[a-z]+$");
  });

  it("string field had description (renaming-style metadata)", () => {
    const S = z.object({ summary: z.string() }).named("SGExtra_S3Desc");
    const versions = runTwoVersionGen(
      { SGExtra_S3Desc: S },
      [schema(S).field("summary").had({ description: "renamed field" })],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S3Desc")!.schema as ZodObject<any>;
    expect((v1.shape.summary as any)._def.description).toBe("renamed field");
  });

  it("number field had gt", () => {
    const S = z.object({ x: z.number() }).named("SGExtra_S3Gt");
    const versions = runTwoVersionGen(
      { SGExtra_S3Gt: S },
      [schema(S).field("x").had({ gt: 0 })],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S3Gt")!.schema as ZodObject<any>;
    expect(findCheck(v1.shape.x, "min", false)?.value).toBe(0);
  });

  it("number field had gte", () => {
    const S = z.object({ x: z.number() }).named("SGExtra_S3Gte");
    const versions = runTwoVersionGen(
      { SGExtra_S3Gte: S },
      [schema(S).field("x").had({ gte: 0 })],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S3Gte")!.schema as ZodObject<any>;
    expect(findCheck(v1.shape.x, "min", true)?.value).toBe(0);
  });

  it("number field had lt", () => {
    const S = z.object({ x: z.number() }).named("SGExtra_S3Lt");
    const versions = runTwoVersionGen(
      { SGExtra_S3Lt: S },
      [schema(S).field("x").had({ lt: 100 })],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S3Lt")!.schema as ZodObject<any>;
    expect(findCheck(v1.shape.x, "max", false)?.value).toBe(100);
  });

  it("number field had lte", () => {
    const S = z.object({ x: z.number() }).named("SGExtra_S3Lte");
    const versions = runTwoVersionGen(
      { SGExtra_S3Lte: S },
      [schema(S).field("x").had({ lte: 100 })],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S3Lte")!.schema as ZodObject<any>;
    expect(findCheck(v1.shape.x, "max", true)?.value).toBe(100);
  });

  it("number field had multipleOf", () => {
    const S = z.object({ step: z.number() }).named("SGExtra_S3Mult");
    const versions = runTwoVersionGen(
      { SGExtra_S3Mult: S },
      [schema(S).field("step").had({ multipleOf: 5 })],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S3Mult")!.schema as ZodObject<any>;
    expect(findCheck(v1.shape.step, "multipleOf")?.value).toBe(5);
  });

  it("number field had int: true", () => {
    const S = z.object({ count: z.number() }).named("SGExtra_S3Int");
    const versions = runTwoVersionGen(
      { SGExtra_S3Int: S },
      [schema(S).field("count").had({ int: true })],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S3Int")!.schema as ZodObject<any>;
    expect(findCheck(v1.shape.count, "int")).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════════
// Section 4: removeConstraint via didntHave — all branches
// ════════════════════════════════════════════════════════════════════════

describe("Section 4: removeConstraint via didntHave", () => {
  it("string didntHave('regex') removes only the regex check", () => {
    const S = z
      .object({ name: z.string().min(5).max(10).regex(/^[a-z]+$/) })
      .named("SGExtra_S4StrDropRegex");
    const versions = runTwoVersionGen(
      { SGExtra_S4StrDropRegex: S },
      [schema(S).field("name").didntHave("regex")],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S4StrDropRegex")!.schema as ZodObject<any>;
    const field = v1.shape.name as ZodString;
    expect(findCheck(field, "regex")).toBeUndefined();
    expect(findCheck(field, "min")?.value).toBe(5);
    expect(findCheck(field, "max")?.value).toBe(10);
  });

  it("string didntHave('min') removes min but preserves max", () => {
    const S = z
      .object({ name: z.string().min(5).max(10) })
      .named("SGExtra_S4StrDropMin");
    const versions = runTwoVersionGen(
      { SGExtra_S4StrDropMin: S },
      [schema(S).field("name").didntHave("min")],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S4StrDropMin")!.schema as ZodObject<any>;
    const field = v1.shape.name as ZodString;
    expect(findCheck(field, "min")).toBeUndefined();
    expect(findCheck(field, "max")?.value).toBe(10);
  });

  it("string didntHave('max') removes max but preserves min", () => {
    const S = z
      .object({ name: z.string().min(5).max(10) })
      .named("SGExtra_S4StrDropMax");
    const versions = runTwoVersionGen(
      { SGExtra_S4StrDropMax: S },
      [schema(S).field("name").didntHave("max")],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S4StrDropMax")!.schema as ZodObject<any>;
    const field = v1.shape.name as ZodString;
    expect(findCheck(field, "max")).toBeUndefined();
    expect(findCheck(field, "min")?.value).toBe(5);
  });

  it("number didntHave('gte') removes only the gte check", () => {
    const S = z
      .object({ x: z.number().gte(0).lte(100) })
      .named("SGExtra_S4NumDropGte");
    const versions = runTwoVersionGen(
      { SGExtra_S4NumDropGte: S },
      [schema(S).field("x").didntHave("gte")],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S4NumDropGte")!.schema as ZodObject<any>;
    expect(findCheck(v1.shape.x, "min", true)).toBeUndefined();
    expect(findCheck(v1.shape.x, "max", true)?.value).toBe(100);
  });

  it("number didntHave('lte') removes only the lte check", () => {
    const S = z
      .object({ x: z.number().gte(0).lte(100) })
      .named("SGExtra_S4NumDropLte");
    const versions = runTwoVersionGen(
      { SGExtra_S4NumDropLte: S },
      [schema(S).field("x").didntHave("lte")],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S4NumDropLte")!.schema as ZodObject<any>;
    expect(findCheck(v1.shape.x, "max", true)).toBeUndefined();
    expect(findCheck(v1.shape.x, "min", true)?.value).toBe(0);
  });

  it("number didntHave('gt') removes only the strict-min (gt) check", () => {
    const S = z
      .object({ x: z.number().gt(0).lt(100) })
      .named("SGExtra_S4NumDropGt");
    const versions = runTwoVersionGen(
      { SGExtra_S4NumDropGt: S },
      [schema(S).field("x").didntHave("gt")],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S4NumDropGt")!.schema as ZodObject<any>;
    expect(findCheck(v1.shape.x, "min", false)).toBeUndefined();
    expect(findCheck(v1.shape.x, "max", false)?.value).toBe(100);
  });

  it("number didntHave('lt') removes only the strict-max (lt) check", () => {
    const S = z
      .object({ x: z.number().gt(0).lt(100) })
      .named("SGExtra_S4NumDropLt");
    const versions = runTwoVersionGen(
      { SGExtra_S4NumDropLt: S },
      [schema(S).field("x").didntHave("lt")],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S4NumDropLt")!.schema as ZodObject<any>;
    expect(findCheck(v1.shape.x, "max", false)).toBeUndefined();
    expect(findCheck(v1.shape.x, "min", false)?.value).toBe(0);
  });

  it("array didntHave('min') removes only the minLength constraint", () => {
    const S = z
      .object({ items: z.array(z.string()).min(1).max(5) })
      .named("SGExtra_S4ArrDropMin");
    const versions = runTwoVersionGen(
      { SGExtra_S4ArrDropMin: S },
      [schema(S).field("items").didntHave("min")],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S4ArrDropMin")!.schema as ZodObject<any>;
    const arr = v1.shape.items as ZodArray<any>;
    expect((arr._def as any).minLength).toBeNull();
    expect((arr._def as any).maxLength?.value).toBe(5);
  });

  it("array didntHave('max') removes only the maxLength constraint", () => {
    const S = z
      .object({ items: z.array(z.string()).min(1).max(5) })
      .named("SGExtra_S4ArrDropMax");
    const versions = runTwoVersionGen(
      { SGExtra_S4ArrDropMax: S },
      [schema(S).field("items").didntHave("max")],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S4ArrDropMax")!.schema as ZodObject<any>;
    const arr = v1.shape.items as ZodArray<any>;
    expect((arr._def as any).maxLength).toBeNull();
    expect((arr._def as any).minLength?.value).toBe(1);
  });

  it("array didntHave('min') preserves description", () => {
    const S = z
      .object({ items: z.array(z.string()).min(1).max(5).describe("my array") })
      .named("SGExtra_S4ArrDescMin");
    const versions = runTwoVersionGen(
      { SGExtra_S4ArrDescMin: S },
      [schema(S).field("items").didntHave("min")],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S4ArrDescMin")!.schema as ZodObject<any>;
    const arr = v1.shape.items as ZodArray<any>;
    expect((arr._def as any).description).toBe("my array");
    expect((arr._def as any).minLength).toBeNull();
    expect((arr._def as any).maxLength?.value).toBe(5);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Section 5: applyValidatorExisted / applyValidatorDidntExist
// ════════════════════════════════════════════════════════════════════════

describe("Section 5: validator instructions", () => {
  it("validator('name').didntExist removes a named refinement from the older version", () => {
    const base = z.object({ age: z.number() });
    const S = namedRefine(
      base,
      "ageAtLeastEighteen",
      (val) => (val as any).age >= 18,
      "Must be 18 or older",
    ).named("SGExtra_S5DidntExist");

    const versions = runTwoVersionGen(
      { SGExtra_S5DidntExist: S },
      [schema(S).validator("ageAtLeastEighteen").didntExist],
    );
    const v1Entry = versions.get("2000-01-01")!.get("SGExtra_S5DidntExist")!;
    expect(v1Entry.namedRefinements.length).toBe(0);

    // v2 still carries the validator on its registry entry.
    const v2Entry = versions.get("2001-01-01")!.get("SGExtra_S5DidntExist")!;
    expect(v2Entry.namedRefinements.some((r) => r.name === "ageAtLeastEighteen")).toBe(
      true,
    );
  });

  it("validator('name').didntExist twice throws because the second call is a no-op", () => {
    const base = z.object({ age: z.number() });
    const S = namedRefine(
      base,
      "ageGate",
      (val) => (val as any).age >= 18,
    ).named("SGExtra_S5DoubleDidntExist");

    // First the name exists, second it doesn't -> second removal throws.
    expect(() => {
      runTwoVersionGen(
        { SGExtra_S5DoubleDidntExist: S },
        [
          schema(S).validator("ageGate").didntExist,
          schema(S).validator("ageGate").didntExist,
        ],
      );
    }).toThrow(InvalidGenerationInstructionError);
  });

  it("validator(namedRefinementInfo).existed re-adds a removed validator", () => {
    // Start with a base schema with no validators, then re-add via existed.
    const S = z.object({ name: z.string() }).named("SGExtra_S5Existed");
    const refinementInfo = {
      name: "nameIsNotEmpty",
      fn: (val: any) => val.name.length > 0,
      message: "name must not be empty",
    };

    const versions = runTwoVersionGen(
      { SGExtra_S5Existed: S },
      [schema(S).validator(refinementInfo).existed],
    );
    const v1Entry = versions.get("2000-01-01")!.get("SGExtra_S5Existed")!;
    expect(v1Entry.namedRefinements.length).toBe(1);
    expect(v1Entry.namedRefinements[0].name).toBe("nameIsNotEmpty");
    expect(v1Entry.namedRefinements[0].message).toBe("name must not be empty");
  });

  it("validator(info).existed on an already-existing validator throws", () => {
    const base = z.object({ name: z.string() });
    const S = namedRefine(
      base,
      "nameIsNotEmpty",
      (val) => (val as any).name.length > 0,
    ).named("SGExtra_S5AlreadyExisted");

    const info = {
      name: "nameIsNotEmpty",
      fn: (val: any) => val.name.length > 0,
    };

    expect(() => {
      runTwoVersionGen(
        { SGExtra_S5AlreadyExisted: S },
        [schema(S).validator(info).existed],
      );
    }).toThrow(InvalidGenerationInstructionError);
  });

  it("validator('name').existed (with just a string name, no fn) throws a descriptive error", () => {
    const S = z.object({ x: z.string() }).named("SGExtra_S5ExistedNoFn");
    expect(() => {
      // Accessing .existed on a factory built from a name-only string
      // should throw because no function is available to re-add.
      return schema(S).validator("someName").existed;
    }).toThrow(/Cannot use \.existed on validator "someName" without a function/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Section 6: applyComputedFieldExisted / applyComputedFieldDidntExist
// ════════════════════════════════════════════════════════════════════════

describe("Section 6: computed field instructions", () => {
  it("computedField(field).existed adds the computed field to the older version", () => {
    const S = z
      .object({ firstName: z.string(), lastName: z.string() })
      .named("SGExtra_S6Existed");
    const fullName = namedComputedField(
      "fullName",
      (data: any) => `${data.firstName} ${data.lastName}`,
    );

    const versions = runTwoVersionGen(
      { SGExtra_S6Existed: S },
      [schema(S).computedField(fullName).existed],
    );
    const v1Entry = versions.get("2000-01-01")!.get("SGExtra_S6Existed")!;
    expect(v1Entry.computedFields.length).toBe(1);
    expect(v1Entry.computedFields[0].name).toBe("fullName");
    // Sanity check: running the compute fn yields the concatenated name.
    expect(
      v1Entry.computedFields[0].compute({
        firstName: "Ada",
        lastName: "Lovelace",
      }),
    ).toBe("Ada Lovelace");
  });

  it("computedField('name').didntExist removes a computed field from the older version", () => {
    // Base schema already has a computed field attached through the registry.
    const base = z
      .object({ firstName: z.string(), lastName: z.string() })
      .named("SGExtra_S6DidntExist");

    // Attach computed field metadata the same way namedRefine attaches refinements:
    // directly on the schema. generateVersionedSchemas will pull them into the
    // registry on register().
    (base as any)._tsadwynComputedFields = [
      namedComputedField("fullName", (data: any) => `${data.firstName} ${data.lastName}`),
    ];

    const versions = runTwoVersionGen(
      { SGExtra_S6DidntExist: base },
      [schema(base).computedField("fullName").didntExist],
    );
    const v1Entry = versions.get("2000-01-01")!.get("SGExtra_S6DidntExist")!;
    expect(v1Entry.computedFields.length).toBe(0);

    const v2Entry = versions.get("2001-01-01")!.get("SGExtra_S6DidntExist")!;
    expect(v2Entry.computedFields.length).toBe(1);
  });

  it("computedField('name').didntExist when the field doesn't exist throws", () => {
    const S = z.object({ a: z.string() }).named("SGExtra_S6NoopDidntExist");
    expect(() => {
      runTwoVersionGen(
        { SGExtra_S6NoopDidntExist: S },
        [schema(S).computedField("nonExistent").didntExist],
      );
    }).toThrow(InvalidGenerationInstructionError);
  });

  it("computedField(field).existed twice throws because the second call is a no-op", () => {
    const S = z.object({ a: z.string() }).named("SGExtra_S6NoopExisted");
    const cf = namedComputedField("doubled", (data: any) => data.a + data.a);

    expect(() => {
      runTwoVersionGen(
        { SGExtra_S6NoopExisted: S },
        [
          schema(S).computedField(cf).existed,
          schema(S).computedField(cf).existed,
        ],
      );
    }).toThrow(InvalidGenerationInstructionError);
  });

  it("computedField('name').existed (with just a string name, no fn) throws a descriptive error", () => {
    const S = z.object({ a: z.string() }).named("SGExtra_S6ExistedNoFn");
    expect(() => {
      return schema(S).computedField("someField").existed;
    }).toThrow(/Cannot use \.existed on computed field "someField" without a compute function/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Section 7: applyEnumInstruction — all branches
// ════════════════════════════════════════════════════════════════════════

describe("Section 7: enum instructions", () => {
  it("enum_.had({ newMember }) adds a member to the older version", () => {
    const Colors = z.enum(["red", "green"]).named("SGExtra_S7HadAdd");
    const registry = new ZodSchemaRegistry();
    registry.registerEnum("SGExtra_S7HadAdd", Colors);

    class AddBlue extends VersionChange {
      description = "add blue";
      instructions = [enum_(Colors).had({ blue: "blue" })];
    }
    const bundle = new VersionBundle(
      new Version("2001-01-01", AddBlue),
      new Version("2000-01-01"),
    );

    const versions = generateVersionedSchemas(bundle, registry);
    const v1 = versions.get("2000-01-01")!;
    const entry = v1.getEnum("SGExtra_S7HadAdd")!;
    expect(entry.members).toEqual({ red: "red", green: "green", blue: "blue" });

    // The rebuilt schema must also be a ZodEnum containing the expected values.
    expect(entry.schema).toBeInstanceOf(ZodEnum);
    const options = (entry.schema as ZodEnum<any>).options as string[];
    expect(options.sort()).toEqual(["blue", "green", "red"]);
  });

  it("enum_.didntHave('member') removes a member from the older version", () => {
    const Priority = z
      .enum(["low", "medium", "high", "urgent"])
      .named("SGExtra_S7DidntHave");
    const registry = new ZodSchemaRegistry();
    registry.registerEnum("SGExtra_S7DidntHave", Priority);

    class RemoveUrgent extends VersionChange {
      description = "remove urgent";
      instructions = [enum_(Priority).didntHave("urgent")];
    }
    const bundle = new VersionBundle(
      new Version("2001-01-01", RemoveUrgent),
      new Version("2000-01-01"),
    );

    const versions = generateVersionedSchemas(bundle, registry);
    const v1Entry = versions.get("2000-01-01")!.getEnum("SGExtra_S7DidntHave")!;
    expect("urgent" in v1Entry.members).toBe(false);
    expect(Object.keys(v1Entry.members).sort()).toEqual(["high", "low", "medium"]);
  });

  it("enum_.had() on an UNREGISTERED enum auto-registers it", () => {
    // Registry does NOT call registerEnum for this enum, but the instruction
    // carries the schema so applyEnumInstruction can bootstrap it.
    const Stages = z.enum(["alpha", "beta"]).named("SGExtra_S7AutoRegHad");
    const registry = new ZodSchemaRegistry();

    class AddGA extends VersionChange {
      description = "add ga";
      instructions = [enum_(Stages).had({ ga: "ga" })];
    }
    const bundle = new VersionBundle(
      new Version("2001-01-01", AddGA),
      new Version("2000-01-01"),
    );

    const versions = generateVersionedSchemas(bundle, registry);
    const v1Entry = versions.get("2000-01-01")!.getEnum("SGExtra_S7AutoRegHad")!;
    expect(v1Entry).toBeDefined();
    expect(v1Entry.members).toEqual({ alpha: "alpha", beta: "beta", ga: "ga" });
  });

  it("enum_.didntHave() on an UNREGISTERED enum auto-registers then removes", () => {
    const Env = z.enum(["dev", "staging", "prod"]).named("SGExtra_S7AutoRegDidntHave");
    const registry = new ZodSchemaRegistry();

    class RemoveStaging extends VersionChange {
      description = "remove staging";
      instructions = [enum_(Env).didntHave("staging")];
    }
    const bundle = new VersionBundle(
      new Version("2001-01-01", RemoveStaging),
      new Version("2000-01-01"),
    );

    const versions = generateVersionedSchemas(bundle, registry);
    const v1Entry = versions.get("2000-01-01")!.getEnum("SGExtra_S7AutoRegDidntHave")!;
    expect(v1Entry).toBeDefined();
    expect("staging" in v1Entry.members).toBe(false);
    expect(Object.keys(v1Entry.members).sort()).toEqual(["dev", "prod"]);
  });

  it("enum_.had({ existing: sameValue }) throws because it's a no-op", () => {
    const Colors = z.enum(["red", "green"]).named("SGExtra_S7HadNoop");
    const registry = new ZodSchemaRegistry();
    registry.registerEnum("SGExtra_S7HadNoop", Colors);

    class BadAdd extends VersionChange {
      description = "no-op add";
      instructions = [enum_(Colors).had({ red: "red" })];
    }
    const bundle = new VersionBundle(
      new Version("2001-01-01", BadAdd),
      new Version("2000-01-01"),
    );

    expect(() => generateVersionedSchemas(bundle, registry)).toThrow(
      InvalidGenerationInstructionError,
    );
  });

  it("enum_.didntHave('nonExistent') throws because it's a no-op", () => {
    const Colors = z.enum(["red", "green"]).named("SGExtra_S7DidntHaveNoop");
    const registry = new ZodSchemaRegistry();
    registry.registerEnum("SGExtra_S7DidntHaveNoop", Colors);

    class BadRemove extends VersionChange {
      description = "no-op remove";
      instructions = [enum_(Colors).didntHave("purple")];
    }
    const bundle = new VersionBundle(
      new Version("2001-01-01", BadRemove),
      new Version("2000-01-01"),
    );

    expect(() => generateVersionedSchemas(bundle, registry)).toThrow(
      InvalidGenerationInstructionError,
    );
  });
});

// ════════════════════════════════════════════════════════════════════════
// Section 8: hidden() on VersionChange classes and instructions
// ════════════════════════════════════════════════════════════════════════

describe("Section 8: hidden()", () => {
  it("hidden(VersionChangeClass) sets isHiddenFromChangelog on the prototype", () => {
    class SecretChange extends VersionChange {
      description = "secret change";
      instructions = [];
    }
    // Sanity: before, it's false (inherited from VersionChange.prototype).
    expect((SecretChange.prototype as any).isHiddenFromChangelog).toBe(false);

    const result = hidden(SecretChange);
    expect(result).toBe(SecretChange);
    expect((SecretChange.prototype as any).isHiddenFromChangelog).toBe(true);
  });

  it("hidden(instruction) returns a new instruction object with isHiddenFromChangelog: true", () => {
    const S = z.object({ a: z.string() }).named("SGExtra_S8HiddenInstr");
    const instruction = schema(S).field("a").didntExist;
    expect(instruction.isHiddenFromChangelog).toBe(false);

    const hiddenInstr = hidden(instruction);
    // It should be an instruction-shaped object...
    expect(hiddenInstr.kind).toBe("field_didnt_exist");
    expect(hiddenInstr.isHiddenFromChangelog).toBe(true);
    // ...and a copy, not the same reference.
    expect(hiddenInstr).not.toBe(instruction);
    // The original must remain unchanged.
    expect(instruction.isHiddenFromChangelog).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Section 9: applyFieldHad — no-op validations and missing-field errors
// ════════════════════════════════════════════════════════════════════════

describe("Section 9: applyFieldHad no-op/error paths", () => {
  it("renaming a field to its current name with no other changes throws", () => {
    const S = z.object({ name: z.string() }).named("SGExtra_S9RenameNoop");
    expect(() => {
      runTwoVersionGen(
        { SGExtra_S9RenameNoop: S },
        [schema(S).field("name").had({ name: "name" })],
      );
    }).toThrow(InvalidGenerationInstructionError);
  });

  it("renaming a field to its current name but with another change is allowed", () => {
    // Having additional changes (here, description) means the no-op guard
    // is bypassed and the instruction applies.
    const S = z.object({ name: z.string() }).named("SGExtra_S9RenameWithChange");
    const versions = runTwoVersionGen(
      { SGExtra_S9RenameWithChange: S },
      [schema(S).field("name").had({ name: "name", description: "the name" })],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S9RenameWithChange")!.schema as ZodObject<any>;
    expect((v1.shape.name as any)._def.description).toBe("the name");
  });

  it("setting oldType to the exact same type throws (no-op)", () => {
    const fieldType = z.string();
    const S = z.object({ name: fieldType }).named("SGExtra_S9SameType");
    expect(() => {
      runTwoVersionGen(
        { SGExtra_S9SameType: S },
        [schema(S).field("name").had({ type: fieldType })],
      );
    }).toThrow(InvalidGenerationInstructionError);
  });

  it("renaming a field that doesn't exist throws", () => {
    const S = z.object({ a: z.string() }).named("SGExtra_S9RenameMissing");
    expect(() => {
      runTwoVersionGen(
        { SGExtra_S9RenameMissing: S },
        [schema(S).field("ghost").had({ name: "phantom" })],
      );
    }).toThrow(InvalidGenerationInstructionError);
  });

  it("constraint-only change on a field that doesn't exist throws", () => {
    const S = z.object({ a: z.string() }).named("SGExtra_S9ConstraintMissing");
    expect(() => {
      runTwoVersionGen(
        { SGExtra_S9ConstraintMissing: S },
        [schema(S).field("ghost").had({ min: 0 })],
      );
    }).toThrow(InvalidGenerationInstructionError);
  });

  it("field_didnt_exist for a non-existent field throws (no-op)", () => {
    const S = z.object({ a: z.string() }).named("SGExtra_S9DidntExistNoop");
    expect(() => {
      runTwoVersionGen(
        { SGExtra_S9DidntExistNoop: S },
        [schema(S).field("ghost").didntExist],
      );
    }).toThrow(InvalidGenerationInstructionError);
  });

  it("field_existed_as for an existing field with the same type throws (no-op)", () => {
    const fieldType = z.string();
    const S = z.object({ a: fieldType }).named("SGExtra_S9ExistedAsNoop");
    expect(() => {
      runTwoVersionGen(
        { SGExtra_S9ExistedAsNoop: S },
        [schema(S).field("a").existedAs({ type: fieldType })],
      );
    }).toThrow(InvalidGenerationInstructionError);
  });

  it("didntHave on a non-existent field throws", () => {
    const S = z.object({ a: z.string() }).named("SGExtra_S9DidntHaveMissing");
    expect(() => {
      runTwoVersionGen(
        { SGExtra_S9DidntHaveMissing: S },
        [schema(S).field("ghost").didntHave("min")],
      );
    }).toThrow(InvalidGenerationInstructionError);
  });

  it("schema_had renaming to the current name throws", () => {
    const S = z.object({ a: z.string() }).named("SGExtra_S9SchemaRenameNoop");
    expect(() => {
      runTwoVersionGen(
        { SGExtra_S9SchemaRenameNoop: S },
        [schema(S).had({ name: "SGExtra_S9SchemaRenameNoop" })],
      );
    }).toThrow(InvalidGenerationInstructionError);
  });

  it("applying an instruction on an unregistered schema throws", () => {
    const S = z.object({ a: z.string() }).named("SGExtra_S9Unreg");
    const registry = new ZodSchemaRegistry();
    // Deliberately NOT registering S
    class Change extends VersionChange {
      description = "unregistered";
      instructions = [schema(S).field("a").had({ minLength: 1 })];
    }
    const bundle = new VersionBundle(
      new Version("2001-01-01", Change),
      new Version("2000-01-01"),
    );
    expect(() => generateVersionedSchemas(bundle, registry)).toThrow(
      InvalidGenerationInstructionError,
    );
  });

  it("renaming an unregistered schema throws", () => {
    const S = z.object({ a: z.string() }).named("SGExtra_S9UnregRename");
    const registry = new ZodSchemaRegistry();
    class Change extends VersionChange {
      description = "unreg rename";
      instructions = [schema(S).had({ name: "OtherName" })];
    }
    const bundle = new VersionBundle(
      new Version("2001-01-01", Change),
      new Version("2000-01-01"),
    );
    expect(() => generateVersionedSchemas(bundle, registry)).toThrow(
      InvalidGenerationInstructionError,
    );
  });
});

// ════════════════════════════════════════════════════════════════════════
// Section 10: applyFieldConstraints — additional type/attribute branches
// ════════════════════════════════════════════════════════════════════════

describe("Section 10: applyFieldConstraints extra branches", () => {
  it("min on a ZodString uses .min()", () => {
    const S = z.object({ name: z.string() }).named("SGExtra_S10StrMin");
    const versions = runTwoVersionGen(
      { SGExtra_S10StrMin: S },
      [schema(S).field("name").had({ min: 3 })],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S10StrMin")!.schema as ZodObject<any>;
    expect(findCheck(v1.shape.name, "min")?.value).toBe(3);
  });

  it("min on a ZodArray uses .min()", () => {
    const S = z.object({ items: z.array(z.string()) }).named("SGExtra_S10ArrMin");
    const versions = runTwoVersionGen(
      { SGExtra_S10ArrMin: S },
      [schema(S).field("items").had({ min: 1 })],
    );
    const arr = (versions.get("2000-01-01")!.get("SGExtra_S10ArrMin")!.schema as ZodObject<any>)
      .shape.items as ZodArray<any>;
    expect((arr._def as any).minLength?.value).toBe(1);
  });

  it("minLength on a ZodString uses .min()", () => {
    const S = z.object({ name: z.string() }).named("SGExtra_S10StrMinLen");
    const versions = runTwoVersionGen(
      { SGExtra_S10StrMinLen: S },
      [schema(S).field("name").had({ minLength: 2 })],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S10StrMinLen")!.schema as ZodObject<any>;
    expect(findCheck(v1.shape.name, "min")?.value).toBe(2);
  });

  it("minLength on a ZodArray uses .min()", () => {
    const S = z.object({ items: z.array(z.string()) }).named("SGExtra_S10ArrMinLen");
    const versions = runTwoVersionGen(
      { SGExtra_S10ArrMinLen: S },
      [schema(S).field("items").had({ minLength: 3 })],
    );
    const arr = (versions.get("2000-01-01")!.get("SGExtra_S10ArrMinLen")!.schema as ZodObject<any>)
      .shape.items as ZodArray<any>;
    expect((arr._def as any).minLength?.value).toBe(3);
  });

  it("max on a ZodString uses .max()", () => {
    const S = z.object({ name: z.string() }).named("SGExtra_S10StrMax");
    const versions = runTwoVersionGen(
      { SGExtra_S10StrMax: S },
      [schema(S).field("name").had({ max: 20 })],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S10StrMax")!.schema as ZodObject<any>;
    expect(findCheck(v1.shape.name, "max")?.value).toBe(20);
  });

  it("max on a ZodArray uses .max()", () => {
    const S = z.object({ items: z.array(z.string()) }).named("SGExtra_S10ArrMax");
    const versions = runTwoVersionGen(
      { SGExtra_S10ArrMax: S },
      [schema(S).field("items").had({ max: 5 })],
    );
    const arr = (versions.get("2000-01-01")!.get("SGExtra_S10ArrMax")!.schema as ZodObject<any>)
      .shape.items as ZodArray<any>;
    expect((arr._def as any).maxLength?.value).toBe(5);
  });

  it("maxLength on a ZodString uses .max()", () => {
    const S = z.object({ name: z.string() }).named("SGExtra_S10StrMaxLen");
    const versions = runTwoVersionGen(
      { SGExtra_S10StrMaxLen: S },
      [schema(S).field("name").had({ maxLength: 7 })],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S10StrMaxLen")!.schema as ZodObject<any>;
    expect(findCheck(v1.shape.name, "max")?.value).toBe(7);
  });

  it("maxLength on a ZodArray uses .max()", () => {
    const S = z.object({ items: z.array(z.string()) }).named("SGExtra_S10ArrMaxLen");
    const versions = runTwoVersionGen(
      { SGExtra_S10ArrMaxLen: S },
      [schema(S).field("items").had({ maxLength: 9 })],
    );
    const arr = (versions.get("2000-01-01")!.get("SGExtra_S10ArrMaxLen")!.schema as ZodObject<any>)
      .shape.items as ZodArray<any>;
    expect((arr._def as any).maxLength?.value).toBe(9);
  });

  it("pattern on a ZodString is applied via regex()", () => {
    const S = z.object({ slug: z.string() }).named("SGExtra_S10Pattern");
    const versions = runTwoVersionGen(
      { SGExtra_S10Pattern: S },
      [schema(S).field("slug").had({ pattern: /^abc/ })],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S10Pattern")!.schema as ZodObject<any>;
    const check = findCheck(v1.shape.slug, "regex");
    expect(check).toBeDefined();
    expect(check.regex.source).toBe("^abc");
  });

  it("nullable: true wraps the type in ZodNullable", () => {
    const S = z.object({ name: z.string() }).named("SGExtra_S10Nullable");
    const versions = runTwoVersionGen(
      { SGExtra_S10Nullable: S },
      [schema(S).field("name").had({ nullable: true })],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S10Nullable")!.schema as ZodObject<any>;
    expect(v1.shape.name.constructor.name).toBe("ZodNullable");
  });

  it("optional: true wraps the type in ZodOptional", () => {
    const S = z.object({ name: z.string() }).named("SGExtra_S10Optional");
    const versions = runTwoVersionGen(
      { SGExtra_S10Optional: S },
      [schema(S).field("name").had({ optional: true })],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S10Optional")!.schema as ZodObject<any>;
    expect(v1.shape.name.constructor.name).toBe("ZodOptional");
  });

  it("default wraps the type in ZodDefault", () => {
    const S = z.object({ name: z.string() }).named("SGExtra_S10Default");
    const versions = runTwoVersionGen(
      { SGExtra_S10Default: S },
      [schema(S).field("name").had({ default: "anon" })],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S10Default")!.schema as ZodObject<any>;
    expect(v1.shape.name.constructor.name).toBe("ZodDefault");
    expect(((v1.shape.name as any)._def as any).defaultValue()).toBe("anon");
  });

  it("title metadata is stored on the result", () => {
    const S = z.object({ name: z.string() }).named("SGExtra_S10Title");
    const versions = runTwoVersionGen(
      { SGExtra_S10Title: S },
      [schema(S).field("name").had({ title: "Display Name" })],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S10Title")!.schema as ZodObject<any>;
    expect((v1.shape.name as any)._tsadwynTitle).toBe("Display Name");
  });

  it("examples metadata is stored on the result", () => {
    const S = z.object({ name: z.string() }).named("SGExtra_S10Examples");
    const versions = runTwoVersionGen(
      { SGExtra_S10Examples: S },
      [schema(S).field("name").had({ examples: ["Alice", "Bob"] })],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S10Examples")!.schema as ZodObject<any>;
    expect((v1.shape.name as any)._tsadwynExamples).toEqual(["Alice", "Bob"]);
  });

  it("discriminator metadata is stored on the result", () => {
    const S = z.object({ kind: z.string() }).named("SGExtra_S10Discriminator");
    const versions = runTwoVersionGen(
      { SGExtra_S10Discriminator: S },
      [schema(S).field("kind").had({ discriminator: "kind" })],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S10Discriminator")!.schema as ZodObject<any>;
    expect((v1.shape.kind as any)._tsadwynDiscriminator).toBe("kind");
  });

  it("json_schema_extra metadata is stored on the result", () => {
    const S = z.object({ name: z.string() }).named("SGExtra_S10JsonSchemaExtra");
    const versions = runTwoVersionGen(
      { SGExtra_S10JsonSchemaExtra: S },
      [schema(S).field("name").had({ json_schema_extra: { deprecated: true } })],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S10JsonSchemaExtra")!.schema as ZodObject<any>;
    expect((v1.shape.name as any)._tsadwynJsonSchemaExtra).toEqual({ deprecated: true });
  });

  it("renaming while also applying a constraint correctly exercises the rename branch", () => {
    const S = z.object({ email: z.string() }).named("SGExtra_S10RenameAndConstraint");
    const versions = runTwoVersionGen(
      { SGExtra_S10RenameAndConstraint: S },
      [schema(S).field("email").had({ name: "emailAddress", minLength: 5 })],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S10RenameAndConstraint")!.schema as ZodObject<any>;
    expect(v1.shape.emailAddress).toBeDefined();
    expect(v1.shape.email).toBeUndefined();
    expect(findCheck(v1.shape.emailAddress, "min")?.value).toBe(5);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Section 11: removeConstraint — wrapper and metadata branches
// ════════════════════════════════════════════════════════════════════════

describe("Section 11: removeConstraint wrapper and metadata branches", () => {
  it("didntHave('optional') unwraps a ZodOptional field", () => {
    const S = z.object({ nickname: z.string().optional() }).named("SGExtra_S11Optional");
    const versions = runTwoVersionGen(
      { SGExtra_S11Optional: S },
      [schema(S).field("nickname").didntHave("optional")],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S11Optional")!.schema as ZodObject<any>;
    expect(v1.shape.nickname.constructor.name).toBe("ZodString");
  });

  it("didntHave('nullable') unwraps a ZodNullable field", () => {
    const S = z.object({ bio: z.string().nullable() }).named("SGExtra_S11Nullable");
    const versions = runTwoVersionGen(
      { SGExtra_S11Nullable: S },
      [schema(S).field("bio").didntHave("nullable")],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S11Nullable")!.schema as ZodObject<any>;
    expect(v1.shape.bio.constructor.name).toBe("ZodString");
  });

  it("didntHave('default') unwraps a ZodDefault field", () => {
    const S = z.object({ greeting: z.string().default("hi") }).named("SGExtra_S11Default");
    const versions = runTwoVersionGen(
      { SGExtra_S11Default: S },
      [schema(S).field("greeting").didntHave("default")],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S11Default")!.schema as ZodObject<any>;
    expect(v1.shape.greeting.constructor.name).toBe("ZodString");
  });

  it("didntHave('title') strips the _tsadwynTitle metadata", () => {
    const S = z.object({ name: z.string() }).named("SGExtra_S11Title");
    // Pre-populate the title metadata so we can remove it.
    ((S as ZodObject<any>).shape.name as any)._tsadwynTitle = "Name";
    const versions = runTwoVersionGen(
      { SGExtra_S11Title: S },
      [schema(S).field("name").didntHave("title")],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S11Title")!.schema as ZodObject<any>;
    expect((v1.shape.name as any)._tsadwynTitle).toBeUndefined();
  });

  it("didntHave('examples') strips the _tsadwynExamples metadata", () => {
    const S = z.object({ name: z.string() }).named("SGExtra_S11Examples");
    ((S as ZodObject<any>).shape.name as any)._tsadwynExamples = ["a", "b"];
    const versions = runTwoVersionGen(
      { SGExtra_S11Examples: S },
      [schema(S).field("name").didntHave("examples")],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S11Examples")!.schema as ZodObject<any>;
    expect((v1.shape.name as any)._tsadwynExamples).toBeUndefined();
  });

  it("didntHave('discriminator') strips the _tsadwynDiscriminator metadata", () => {
    const S = z.object({ kind: z.string() }).named("SGExtra_S11Discriminator");
    ((S as ZodObject<any>).shape.kind as any)._tsadwynDiscriminator = "kind";
    const versions = runTwoVersionGen(
      { SGExtra_S11Discriminator: S },
      [schema(S).field("kind").didntHave("discriminator")],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S11Discriminator")!.schema as ZodObject<any>;
    expect((v1.shape.kind as any)._tsadwynDiscriminator).toBeUndefined();
  });

  it("didntHave('json_schema_extra') strips the _tsadwynJsonSchemaExtra metadata", () => {
    const S = z.object({ name: z.string() }).named("SGExtra_S11JsonExtra");
    ((S as ZodObject<any>).shape.name as any)._tsadwynJsonSchemaExtra = { foo: 1 };
    const versions = runTwoVersionGen(
      { SGExtra_S11JsonExtra: S },
      [schema(S).field("name").didntHave("json_schema_extra")],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S11JsonExtra")!.schema as ZodObject<any>;
    expect((v1.shape.name as any)._tsadwynJsonSchemaExtra).toBeUndefined();
  });

  it("didntHave('min') on a described string preserves the description", () => {
    const S = z
      .object({ name: z.string().min(3).describe("The user's name") })
      .named("SGExtra_S11StrMinDesc");
    const versions = runTwoVersionGen(
      { SGExtra_S11StrMinDesc: S },
      [schema(S).field("name").didntHave("min")],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S11StrMinDesc")!.schema as ZodObject<any>;
    expect(findCheck(v1.shape.name, "min")).toBeUndefined();
    expect((v1.shape.name as any)._def.description).toBe("The user's name");
  });

  it("didntHave('gte') on a described number preserves the description", () => {
    const S = z
      .object({ x: z.number().gte(0).describe("A non-negative") })
      .named("SGExtra_S11NumDesc");
    const versions = runTwoVersionGen(
      { SGExtra_S11NumDesc: S },
      [schema(S).field("x").didntHave("gte")],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S11NumDesc")!.schema as ZodObject<any>;
    expect((v1.shape.x as any)._def.description).toBe("A non-negative");
  });

  it("didntHave('multipleOf') on a number strips only that check", () => {
    const S = z.object({ x: z.number().multipleOf(5).gte(0) }).named("SGExtra_S11NumMult");
    const versions = runTwoVersionGen(
      { SGExtra_S11NumMult: S },
      [schema(S).field("x").didntHave("multipleOf")],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S11NumMult")!.schema as ZodObject<any>;
    expect(findCheck(v1.shape.x, "multipleOf")).toBeUndefined();
    // gte constraint preserved
    expect(findCheck(v1.shape.x, "min", true)?.value).toBe(0);
  });

  it("didntHave('int') on a number strips the int check", () => {
    const S = z.object({ x: z.number().int() }).named("SGExtra_S11NumInt");
    const versions = runTwoVersionGen(
      { SGExtra_S11NumInt: S },
      [schema(S).field("x").didntHave("int")],
    );
    const v1 = versions.get("2000-01-01")!.get("SGExtra_S11NumInt")!.schema as ZodObject<any>;
    expect(findCheck(v1.shape.x, "int")).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════
// Section 12: transformSchemaReferences — optional/nullable/default with
// inner replacement (exercises the non-short-circuit branches of those
// wrapper handlers)
// ════════════════════════════════════════════════════════════════════════

describe("Section 12: transformSchemaReferences wrapper inner replacement", () => {
  it("ZodOptional with a named inner is rebuilt via .optional()", () => {
    const Inner = z.object({ a: z.string() }).named("SGExtra_S12Opt");
    const Versioned = z.object({ a: z.number() }).named("SGExtra_S12Opt");
    const registry = new ZodSchemaRegistry();
    registry.register("SGExtra_S12Opt", Versioned);

    const opt = Inner.optional();
    const transformed = transformSchemaReferences(opt, registry);
    expect(transformed).not.toBe(opt);
    expect(transformed.constructor.name).toBe("ZodOptional");
    const unwrapped = (transformed as any)._def.innerType as ZodObject<any>;
    expect(unwrapped.shape.a).toBeInstanceOf(ZodNumber);
  });

  it("ZodNullable with a named inner is rebuilt via .nullable()", () => {
    const Inner = z.object({ a: z.string() }).named("SGExtra_S12Null");
    const Versioned = z.object({ a: z.number() }).named("SGExtra_S12Null");
    const registry = new ZodSchemaRegistry();
    registry.register("SGExtra_S12Null", Versioned);

    const nullable = Inner.nullable();
    const transformed = transformSchemaReferences(nullable, registry);
    expect(transformed).not.toBe(nullable);
    expect(transformed.constructor.name).toBe("ZodNullable");
    const unwrapped = (transformed as any)._def.innerType as ZodObject<any>;
    expect(unwrapped.shape.a).toBeInstanceOf(ZodNumber);
  });

  it("ZodDefault with a named inner is rebuilt via .default()", () => {
    const Inner = z.object({ a: z.string() }).named("SGExtra_S12Def");
    const Versioned = z.object({ a: z.number() }).named("SGExtra_S12Def");
    const registry = new ZodSchemaRegistry();
    registry.register("SGExtra_S12Def", Versioned);

    const withDefault = Inner.default({ a: "seed" });
    const transformed = transformSchemaReferences(withDefault, registry);
    expect(transformed).not.toBe(withDefault);
    expect(transformed.constructor.name).toBe("ZodDefault");
    const unwrapped = (transformed as any)._def.innerType as ZodObject<any>;
    expect(unwrapped.shape.a).toBeInstanceOf(ZodNumber);
    // The default value factory is preserved.
    expect(((transformed as any)._def as any).defaultValue()).toEqual({ a: "seed" });
  });

  it("non-object registered schema: _transformAllReferencesInRegistry updates the entry", () => {
    // Registering a ZodEffects-wrapped schema (without its own name) that
    // embeds a reference to another registered schema exercises the `else`
    // branch of _transformAllReferencesInRegistry (lines 402-408).
    //
    // Important: the wrapper MUST NOT have its own `_tsadwynName`, otherwise
    // the very first check inside transformSchemaReferences short-circuits
    // and returns the registry copy of the wrapper itself without recursing
    // into its inner schema.
    const Inner = z.object({ a: z.string() }).named("SGExtra_S12NonObjInner");
    const wrapperInnerObj = z.object({ child: Inner });
    const Wrapper = wrapperInnerObj.refine((val: any) => val.child.a !== undefined);
    // Deliberately no .named() on Wrapper.

    const registry = new ZodSchemaRegistry();
    registry.register("SGExtra_S12NonObjInner", Inner);
    // Register under a key but leave the schema unnamed.
    registry.register("SGExtra_S12NonObjWrap", Wrapper);

    // Build a change that transforms Inner in the older version.
    class Change extends VersionChange {
      description = "non-obj wrapper test";
      instructions = [schema(Inner).field("a").had({ type: z.number() })];
    }
    const bundle = new VersionBundle(
      new Version("2001-01-01", Change),
      new Version("2000-01-01"),
    );
    const versions = generateVersionedSchemas(bundle, registry);

    // The wrapper entry (which is a ZodEffects) should have its inner's
    // `child.a` replaced with the number variant in v1 but remain an Effect.
    const v1Wrapper = versions.get("2000-01-01")!.get("SGExtra_S12NonObjWrap")!.schema;
    expect(v1Wrapper).toBeInstanceOf(ZodEffects);
    const innerObj = (v1Wrapper as any)._def.schema as ZodObject<any>;
    expect(innerObj).toBeInstanceOf(ZodObject);
    const innerChild = innerObj.shape.child as ZodObject<any>;
    expect(innerChild).toBeInstanceOf(ZodObject);
    expect(innerChild.shape.a).toBeInstanceOf(ZodNumber);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Section 13: Schema DSL misc error paths
// ════════════════════════════════════════════════════════════════════════

describe("Section 13: schema DSL error paths", () => {
  it("schema() on an unnamed Zod schema throws", () => {
    const Unnamed = z.object({ x: z.string() });
    expect(() => schema(Unnamed)).toThrow(/Schema must have a name/);
  });

  it("didntHave() with an unknown constraint name throws immediately", () => {
    const S = z.object({ a: z.string() }).named("SGExtra_S13Unknown");
    expect(() => {
      // Cast to any to bypass TypeScript's type check so we can simulate
      // bad runtime input (e.g. from a JS caller).
      (schema(S).field("a") as any).didntHave("notAConstraint");
    }).toThrow(/Unknown constraint "notAConstraint"/);
  });
});
