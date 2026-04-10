/**
 * Coverage tests for `src/schema-generation.ts` and `src/structure/schemas.ts`.
 *
 * These tests exercise `generateVersionedSchemas`, `transformSchemaReferences`,
 * `ZodSchemaRegistry` and every DSL instruction supported by `schema()`.
 *
 * They prefer direct unit tests over HTTP round-trips where possible.
 */
import { describe, it, expect } from "vitest";
import {
  z,
  ZodString,
  ZodNumber,
  ZodObject,
  ZodArray,
  ZodOptional,
  ZodNullable,
  ZodDefault,
  ZodUnion,
  ZodDiscriminatedUnion,
  ZodIntersection,
  ZodTuple,
  ZodRecord,
  ZodTypeAny,
} from "zod";
import {
  ZodSchemaRegistry,
  generateVersionedSchemas,
  transformSchemaReferences,
  schema,
  Version,
  VersionBundle,
  VersionChange,
  getSchemaName,
} from "../src/index.js";
import type { PossibleInstruction } from "../src/structure/versions.js";

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * Build an anonymous VersionChange subclass from a list of instructions.
 * A new class is created on every call so tests never share state.
 */
function makeChange(instructions: PossibleInstruction[]) {
  class AnonChange extends VersionChange {
    description = "Test version change";
    instructions = instructions;
  }
  return AnonChange;
}

/**
 * Build a registry seeded with the given named Zod schemas and run
 * `generateVersionedSchemas` against a two-version bundle. Returns the
 * generated version → registry map.
 *
 * Version layout:
 *   "v2" — latest (changes apply going from v2 back to v1)
 *   "v1" — oldest
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
  const bundle = new VersionBundle(new Version("v2", ChangeCls), new Version("v1"));
  return generateVersionedSchemas(bundle, registry);
}

/** Unwrap optional/nullable/default wrappers to reach the inner type. */
function peel(s: ZodTypeAny): ZodTypeAny {
  let cur = s;
  for (;;) {
    if (cur instanceof ZodOptional) {
      cur = (cur._def as any).innerType;
    } else if (cur instanceof ZodNullable) {
      cur = (cur._def as any).innerType;
    } else if (cur instanceof ZodDefault) {
      cur = (cur._def as any).innerType;
    } else {
      return cur;
    }
  }
}

// ════════════════════════════════════════════════════════════════════════
// Section 1: Zod container type handling in schema generation
// ════════════════════════════════════════════════════════════════════════

describe("Section 1: Zod container type handling", () => {
  it("1. union of primitives: field type change from string to union", () => {
    const Thing = z
      .object({ value: z.union([z.string(), z.number()]) })
      .named("S1Thing");

    const versions = runTwoVersionGen(
      { S1Thing: Thing },
      [schema(Thing).field("value").had({ type: z.string() })],
    );

    // v2 latest: union
    const v2 = versions.get("v2")!;
    const v2Shape = (v2.get("S1Thing")!.schema as ZodObject<any>).shape;
    expect(v2Shape.value).toBeInstanceOf(ZodUnion);

    // v1 older: plain string
    const v1 = versions.get("v1")!;
    const v1Shape = (v1.get("S1Thing")!.schema as ZodObject<any>).shape;
    expect(v1Shape.value).toBeInstanceOf(ZodString);
  });

  it("2. union of schemas: nested named schemas are versioned inside a union", () => {
    const SchemaA = z.object({ a: z.string() }).named("S1UnionA");
    const SchemaB = z.object({ b: z.string() }).named("S1UnionB");
    const Container = z
      .object({ value: z.union([SchemaA, SchemaB]) })
      .named("S1UnionContainer");

    const versions = runTwoVersionGen(
      {
        S1UnionA: SchemaA,
        S1UnionB: SchemaB,
        S1UnionContainer: Container,
      },
      [schema(SchemaA).field("a").had({ type: z.number() })],
    );

    // In v1 (old), SchemaA.a is a number
    const v1 = versions.get("v1")!;
    const v1A = v1.get("S1UnionA")!.schema as ZodObject<any>;
    expect(v1A.shape.a).toBeInstanceOf(ZodNumber);

    // Container should reference the v1-versioned SchemaA inside its union
    const v1Container = v1.get("S1UnionContainer")!.schema as ZodObject<any>;
    const u = v1Container.shape.value as ZodUnion<any>;
    expect(u).toBeInstanceOf(ZodUnion);
    const options = (u._def as any).options as ZodTypeAny[];
    // Options must be the versioned copies, i.e. have the versioned shape
    const aOpt = options.find(
      (o) => (o as ZodObject<any>).shape && (o as ZodObject<any>).shape.a !== undefined,
    ) as ZodObject<any>;
    expect(aOpt).toBeDefined();
    expect(aOpt.shape.a).toBeInstanceOf(ZodNumber);
  });

  it("3. array element type changes", () => {
    const Thing = z.object({ items: z.array(z.number()) }).named("S1ArrElem");

    const versions = runTwoVersionGen(
      { S1ArrElem: Thing },
      [schema(Thing).field("items").had({ type: z.array(z.string()) })],
    );

    const v2 = versions.get("v2")!.get("S1ArrElem")!.schema as ZodObject<any>;
    expect(v2.shape.items).toBeInstanceOf(ZodArray);
    expect(((v2.shape.items as ZodArray<any>)._def as any).type).toBeInstanceOf(ZodNumber);

    const v1 = versions.get("v1")!.get("S1ArrElem")!.schema as ZodObject<any>;
    expect(v1.shape.items).toBeInstanceOf(ZodArray);
    expect(((v1.shape.items as ZodArray<any>)._def as any).type).toBeInstanceOf(ZodString);
  });

  it("4. array of nested schemas: element schema version is propagated", () => {
    const Item = z.object({ name: z.string() }).named("S1ArrNestedItem");
    const List = z.object({ items: z.array(Item) }).named("S1ArrNestedList");

    const versions = runTwoVersionGen(
      { S1ArrNestedItem: Item, S1ArrNestedList: List },
      [schema(Item).field("name").had({ type: z.number() })],
    );

    const v1 = versions.get("v1")!;
    const v1List = v1.get("S1ArrNestedList")!.schema as ZodObject<any>;
    const arr = v1List.shape.items as ZodArray<any>;
    expect(arr).toBeInstanceOf(ZodArray);
    const inner = (arr._def as any).type as ZodObject<any>;
    expect(inner).toBeInstanceOf(ZodObject);
    expect(inner.shape.name).toBeInstanceOf(ZodNumber);
  });

  it("5. optional wrapper preserved when inner type changes", () => {
    const Thing = z.object({ nickname: z.string().optional() }).named("S1OptWrap");

    const versions = runTwoVersionGen(
      { S1OptWrap: Thing },
      [schema(Thing).field("nickname").had({ type: z.number().optional() })],
    );

    const v2 = versions.get("v2")!.get("S1OptWrap")!.schema as ZodObject<any>;
    const v2Field = v2.shape.nickname;
    expect(v2Field).toBeInstanceOf(ZodOptional);
    expect(peel(v2Field)).toBeInstanceOf(ZodString);

    const v1 = versions.get("v1")!.get("S1OptWrap")!.schema as ZodObject<any>;
    const v1Field = v1.shape.nickname;
    expect(v1Field).toBeInstanceOf(ZodOptional);
    expect(peel(v1Field)).toBeInstanceOf(ZodNumber);
  });

  it("6. nullable wrapper preserved when inner type changes", () => {
    const Thing = z.object({ label: z.string().nullable() }).named("S1NullWrap");

    const versions = runTwoVersionGen(
      { S1NullWrap: Thing },
      [schema(Thing).field("label").had({ type: z.number().nullable() })],
    );

    const v2 = versions.get("v2")!.get("S1NullWrap")!.schema as ZodObject<any>;
    expect(v2.shape.label).toBeInstanceOf(ZodNullable);
    expect(peel(v2.shape.label)).toBeInstanceOf(ZodString);

    const v1 = versions.get("v1")!.get("S1NullWrap")!.schema as ZodObject<any>;
    expect(v1.shape.label).toBeInstanceOf(ZodNullable);
    expect(peel(v1.shape.label)).toBeInstanceOf(ZodNumber);
  });

  it("7. default value preserved during type change", () => {
    // Explicitly re-specify the default on the new type so the instruction
    // surface carries it into the older version.
    const Thing = z
      .object({ greeting: z.union([z.string(), z.number()]).default("hello") })
      .named("S1DefaultWrap");

    const versions = runTwoVersionGen(
      { S1DefaultWrap: Thing },
      [
        schema(Thing)
          .field("greeting")
          .had({ type: z.string(), default: "hello" }),
      ],
    );

    const v2 = versions.get("v2")!.get("S1DefaultWrap")!.schema as ZodObject<any>;
    expect(v2.shape.greeting).toBeInstanceOf(ZodDefault);
    expect(peel(v2.shape.greeting)).toBeInstanceOf(ZodUnion);

    const v1 = versions.get("v1")!.get("S1DefaultWrap")!.schema as ZodObject<any>;
    expect(v1.shape.greeting).toBeInstanceOf(ZodDefault);
    expect(peel(v1.shape.greeting)).toBeInstanceOf(ZodString);
    // The default value should still produce "hello"
    const def = (v1.shape.greeting as ZodDefault<any>)._def as any;
    expect(def.defaultValue()).toBe("hello");
  });

  it("8. discriminated union of schemas: versioned copies are used", () => {
    const Dog = z
      .object({ type: z.literal("dog"), bark: z.string() })
      .named("S1DiscDog");
    const Cat = z
      .object({ type: z.literal("cat"), meow: z.string() })
      .named("S1DiscCat");

    const Animal = z
      .object({
        pet: z.discriminatedUnion("type", [Dog, Cat]),
      })
      .named("S1DiscAnimal");

    const versions = runTwoVersionGen(
      { S1DiscDog: Dog, S1DiscCat: Cat, S1DiscAnimal: Animal },
      [schema(Dog).field("bark").had({ type: z.number() })],
    );

    const v1 = versions.get("v1")!;
    // Dog.bark is a number in v1
    const v1Dog = v1.get("S1DiscDog")!.schema as ZodObject<any>;
    expect(v1Dog.shape.bark).toBeInstanceOf(ZodNumber);

    const v1Animal = v1.get("S1DiscAnimal")!.schema as ZodObject<any>;
    const du = v1Animal.shape.pet;
    expect(du).toBeInstanceOf(ZodDiscriminatedUnion);
    const opts = (du._def as any).options as ZodObject<any>[];
    const versionedDog = opts.find(
      (o) => (o.shape as any).bark !== undefined,
    )!;
    expect(versionedDog.shape.bark).toBeInstanceOf(ZodNumber);
  });

  it("9. record with schema value: nested schema is versioned inside records", () => {
    const Entry = z.object({ note: z.string() }).named("S1RecEntry");
    const Holder = z
      .object({ entries: z.record(z.string(), Entry) })
      .named("S1RecHolder");

    const versions = runTwoVersionGen(
      { S1RecEntry: Entry, S1RecHolder: Holder },
      [schema(Entry).field("note").had({ type: z.number() })],
    );

    const v1 = versions.get("v1")!;
    const v1Holder = v1.get("S1RecHolder")!.schema as ZodObject<any>;
    const rec = v1Holder.shape.entries as ZodRecord<any, any>;
    expect(rec).toBeInstanceOf(ZodRecord);
    const vt = (rec._def as any).valueType as ZodObject<any>;
    expect(vt).toBeInstanceOf(ZodObject);
    expect(vt.shape.note).toBeInstanceOf(ZodNumber);
  });

  it("10. tuple with schemas: tuple elements are versioned", () => {
    const A = z.object({ a: z.string() }).named("S1TupA");
    const B = z.object({ b: z.string() }).named("S1TupB");
    const Pair = z.object({ pair: z.tuple([A, B]) }).named("S1TupPair");

    const versions = runTwoVersionGen(
      { S1TupA: A, S1TupB: B, S1TupPair: Pair },
      [schema(A).field("a").had({ type: z.number() })],
    );

    const v1 = versions.get("v1")!;
    const v1Pair = v1.get("S1TupPair")!.schema as ZodObject<any>;
    const tup = v1Pair.shape.pair as ZodTuple<any>;
    expect(tup).toBeInstanceOf(ZodTuple);
    const items = (tup._def as any).items as ZodObject<any>[];
    expect(items[0].shape.a).toBeInstanceOf(ZodNumber);
    expect(items[1].shape.b).toBeInstanceOf(ZodString);
  });

  it("11. intersection via .and(): nested schemas are versioned", () => {
    const Left = z.object({ left: z.string() }).named("S1IntLeft");
    const Right = z.object({ right: z.string() }).named("S1IntRight");
    const Holder = z
      .object({ both: z.intersection(Left, Right) })
      .named("S1IntHolder");

    const versions = runTwoVersionGen(
      { S1IntLeft: Left, S1IntRight: Right, S1IntHolder: Holder },
      [schema(Left).field("left").had({ type: z.number() })],
    );

    const v1 = versions.get("v1")!;
    const v1Holder = v1.get("S1IntHolder")!.schema as ZodObject<any>;
    const inter = v1Holder.shape.both as ZodIntersection<any, any>;
    expect(inter).toBeInstanceOf(ZodIntersection);
    const left = (inter._def as any).left as ZodObject<any>;
    expect(left.shape.left).toBeInstanceOf(ZodNumber);
  });

  it("12. deeply nested array of optional nullable: wrappers preserved", () => {
    const Thing = z
      .object({ xs: z.array(z.string().optional().nullable()) })
      .named("S1DeepWrap");

    const versions = runTwoVersionGen(
      { S1DeepWrap: Thing },
      [
        schema(Thing)
          .field("xs")
          .had({ type: z.array(z.number().optional().nullable()) }),
      ],
    );

    const v2 = versions.get("v2")!.get("S1DeepWrap")!.schema as ZodObject<any>;
    const v2Arr = v2.shape.xs as ZodArray<any>;
    const v2Inner = (v2Arr._def as any).type;
    expect(v2Inner).toBeInstanceOf(ZodNullable);
    expect(peel(v2Inner)).toBeInstanceOf(ZodString);

    const v1 = versions.get("v1")!.get("S1DeepWrap")!.schema as ZodObject<any>;
    const v1Arr = v1.shape.xs as ZodArray<any>;
    const v1Inner = (v1Arr._def as any).type;
    expect(v1Inner).toBeInstanceOf(ZodNullable);
    expect(peel(v1Inner)).toBeInstanceOf(ZodNumber);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Section 2: Schema DSL field attributes (constraint changes)
// ════════════════════════════════════════════════════════════════════════

/**
 * Given a ZodString, find a check by kind in its `_def.checks` array.
 */
function findStringCheck(s: ZodTypeAny, kind: string): any | undefined {
  const checks = ((peel(s) as any)._def?.checks ?? []) as any[];
  return checks.find((c) => c.kind === kind);
}

function findNumberCheck(s: ZodTypeAny, kind: string, inclusive?: boolean): any | undefined {
  const checks = ((peel(s) as any)._def?.checks ?? []) as any[];
  return checks.find(
    (c) => c.kind === kind && (inclusive === undefined || c.inclusive === inclusive),
  );
}

describe("Section 2: Field constraint changes via .had()", () => {
  it("13. field().had({ minLength }) on a string", () => {
    const S = z.object({ name: z.string() }).named("S2MinLen");
    const versions = runTwoVersionGen(
      { S2MinLen: S },
      [schema(S).field("name").had({ minLength: 5 })],
    );
    const v1 = versions.get("v1")!.get("S2MinLen")!.schema as ZodObject<any>;
    expect(findStringCheck(v1.shape.name, "min")?.value).toBe(5);
  });

  it("14. field().had({ maxLength }) on a string", () => {
    const S = z.object({ name: z.string() }).named("S2MaxLen");
    const versions = runTwoVersionGen(
      { S2MaxLen: S },
      [schema(S).field("name").had({ maxLength: 10 })],
    );
    const v1 = versions.get("v1")!.get("S2MaxLen")!.schema as ZodObject<any>;
    expect(findStringCheck(v1.shape.name, "max")?.value).toBe(10);
  });

  it("15. field().had({ regex }) on a string", () => {
    const S = z.object({ slug: z.string() }).named("S2Regex");
    const versions = runTwoVersionGen(
      { S2Regex: S },
      [schema(S).field("slug").had({ regex: /^[a-z]+$/ })],
    );
    const v1 = versions.get("v1")!.get("S2Regex")!.schema as ZodObject<any>;
    const check = findStringCheck(v1.shape.slug, "regex");
    expect(check).toBeDefined();
    expect(check.regex.source).toBe("^[a-z]+$");
  });

  it("16. field().had({ min }) on a number (becomes gte)", () => {
    const S = z.object({ age: z.number() }).named("S2NumMin");
    const versions = runTwoVersionGen(
      { S2NumMin: S },
      [schema(S).field("age").had({ min: 0 })],
    );
    const v1 = versions.get("v1")!.get("S2NumMin")!.schema as ZodObject<any>;
    // ZodNumber.gte is stored as { kind: "min", inclusive: true, value: 0 }
    expect(findNumberCheck(v1.shape.age, "min", true)?.value).toBe(0);
  });

  it("17. field().had({ max }) on a number (becomes lte)", () => {
    const S = z.object({ age: z.number() }).named("S2NumMax");
    const versions = runTwoVersionGen(
      { S2NumMax: S },
      [schema(S).field("age").had({ max: 120 })],
    );
    const v1 = versions.get("v1")!.get("S2NumMax")!.schema as ZodObject<any>;
    expect(findNumberCheck(v1.shape.age, "max", true)?.value).toBe(120);
  });

  it("18. field().had({ gt }) on a number", () => {
    const S = z.object({ x: z.number() }).named("S2Gt");
    const versions = runTwoVersionGen(
      { S2Gt: S },
      [schema(S).field("x").had({ gt: 3 })],
    );
    const v1 = versions.get("v1")!.get("S2Gt")!.schema as ZodObject<any>;
    expect(findNumberCheck(v1.shape.x, "min", false)?.value).toBe(3);
  });

  it("19. field().had({ gte }) on a number", () => {
    const S = z.object({ x: z.number() }).named("S2Gte");
    const versions = runTwoVersionGen(
      { S2Gte: S },
      [schema(S).field("x").had({ gte: 4 })],
    );
    const v1 = versions.get("v1")!.get("S2Gte")!.schema as ZodObject<any>;
    expect(findNumberCheck(v1.shape.x, "min", true)?.value).toBe(4);
  });

  it("20. field().had({ lt }) on a number", () => {
    const S = z.object({ x: z.number() }).named("S2Lt");
    const versions = runTwoVersionGen(
      { S2Lt: S },
      [schema(S).field("x").had({ lt: 10 })],
    );
    const v1 = versions.get("v1")!.get("S2Lt")!.schema as ZodObject<any>;
    expect(findNumberCheck(v1.shape.x, "max", false)?.value).toBe(10);
  });

  it("21. field().had({ lte }) on a number", () => {
    const S = z.object({ x: z.number() }).named("S2Lte");
    const versions = runTwoVersionGen(
      { S2Lte: S },
      [schema(S).field("x").had({ lte: 11 })],
    );
    const v1 = versions.get("v1")!.get("S2Lte")!.schema as ZodObject<any>;
    expect(findNumberCheck(v1.shape.x, "max", true)?.value).toBe(11);
  });

  it("22. field().had({ int: true }) marks a number as integer", () => {
    const S = z.object({ count: z.number() }).named("S2Int");
    const versions = runTwoVersionGen(
      { S2Int: S },
      [schema(S).field("count").had({ int: true })],
    );
    const v1 = versions.get("v1")!.get("S2Int")!.schema as ZodObject<any>;
    expect(findNumberCheck(v1.shape.count, "int")).toBeDefined();
  });

  it("23. field().had({ multipleOf }) on a number", () => {
    const S = z.object({ step: z.number() }).named("S2MultipleOf");
    const versions = runTwoVersionGen(
      { S2MultipleOf: S },
      [schema(S).field("step").had({ multipleOf: 5 })],
    );
    const v1 = versions.get("v1")!.get("S2MultipleOf")!.schema as ZodObject<any>;
    expect(findNumberCheck(v1.shape.step, "multipleOf")?.value).toBe(5);
  });

  it("24. field().had({ description }) stores metadata", () => {
    const S = z.object({ summary: z.string() }).named("S2Desc");
    const versions = runTwoVersionGen(
      { S2Desc: S },
      [schema(S).field("summary").had({ description: "A short blurb" })],
    );
    const v1 = versions.get("v1")!.get("S2Desc")!.schema as ZodObject<any>;
    expect((v1.shape.summary as any)._def.description).toBe("A short blurb");
  });

  it("25. field().didntHave('min') strips the numeric min constraint", () => {
    const S = z.object({ age: z.number().gte(18) }).named("S2DrilledMin");
    const versions = runTwoVersionGen(
      { S2DrilledMin: S },
      [schema(S).field("age").didntHave("min")],
    );
    const v1 = versions.get("v1")!.get("S2DrilledMin")!.schema as ZodObject<any>;
    // After removing min (gte), the "min" inclusive check should be gone.
    expect(findNumberCheck(v1.shape.age, "min", true)).toBeUndefined();

    // v2 should still have the original constraint
    const v2 = versions.get("v2")!.get("S2DrilledMin")!.schema as ZodObject<any>;
    expect(findNumberCheck(v2.shape.age, "min", true)?.value).toBe(18);
  });

  it("26. field().didntHave('regex') strips a regex constraint from a string", () => {
    const S = z
      .object({ slug: z.string().regex(/^[a-z]+$/) })
      .named("S2DrilledRegex");
    const versions = runTwoVersionGen(
      { S2DrilledRegex: S },
      [schema(S).field("slug").didntHave("regex")],
    );
    const v1 = versions.get("v1")!.get("S2DrilledRegex")!.schema as ZodObject<any>;
    expect(findStringCheck(v1.shape.slug, "regex")).toBeUndefined();
  });

  it("27. field().didntHave('description') removes the description", () => {
    const S = z
      .object({ note: z.string().describe("Some note") })
      .named("S2DrilledDesc");
    const versions = runTwoVersionGen(
      { S2DrilledDesc: S },
      [schema(S).field("note").didntHave("description")],
    );
    const v1 = versions.get("v1")!.get("S2DrilledDesc")!.schema as ZodObject<any>;
    expect((v1.shape.note as any)._def.description).toBeUndefined();

    // v2 should still have the description
    const v2 = versions.get("v2")!.get("S2DrilledDesc")!.schema as ZodObject<any>;
    expect((v2.shape.note as any)._def.description).toBe("Some note");
  });
});

// ════════════════════════════════════════════════════════════════════════
// Section 3: Schema-level DSL
// ════════════════════════════════════════════════════════════════════════

describe("Section 3: schema().had({ name }) (schema renaming)", () => {
  it("28. schema is renamed in the older version registry", () => {
    const User = z.object({ id: z.string() }).named("S3User");

    const versions = runTwoVersionGen(
      { S3User: User },
      [schema(User).had({ name: "S3LegacyUser" })],
    );

    // v2 latest still has the new name
    const v2 = versions.get("v2")!;
    expect(v2.has("S3User")).toBe(true);
    expect(v2.has("S3LegacyUser")).toBe(false);

    // v1 old should have the legacy name
    const v1 = versions.get("v1")!;
    expect(v1.has("S3LegacyUser")).toBe(true);
    expect(v1.has("S3User")).toBe(false);

    // The schema object's tsadwyn name should match the registry key
    const legacy = v1.get("S3LegacyUser")!.schema;
    expect(getSchemaName(legacy)).toBe("S3LegacyUser");
  });

  it("29. rename a schema that is embedded as a field in another schema", () => {
    const Address = z
      .object({ street: z.string(), city: z.string() })
      .named("S3Address");
    const UserWithAddress = z
      .object({ id: z.string(), address: Address })
      .named("S3UserAddr");

    const versions = runTwoVersionGen(
      { S3Address: Address, S3UserAddr: UserWithAddress },
      [schema(Address).had({ name: "S3OldAddress" })],
    );

    const v1 = versions.get("v1")!;
    // The old registry should have S3OldAddress, not S3Address
    expect(v1.has("S3OldAddress")).toBe(true);
    expect(v1.has("S3Address")).toBe(false);

    // The user's nested address field must still resolve to a ZodObject
    // with the same shape (rename is the only change).
    const v1User = v1.get("S3UserAddr")!.schema as ZodObject<any>;
    const v1Addr = v1User.shape.address as ZodObject<any>;
    expect(v1Addr).toBeInstanceOf(ZodObject);
    expect(Object.keys(v1Addr.shape)).toContain("street");
    expect(Object.keys(v1Addr.shape)).toContain("city");
  });
});

// ════════════════════════════════════════════════════════════════════════
// Section 4: existedAs (fields added in newer versions)
// ════════════════════════════════════════════════════════════════════════

describe("Section 4: schema().field().existedAs()", () => {
  it("30. existedAs with a string field: older version gains the field", () => {
    // In v2 the schema has NO `nickname`. Instruction states that in older
    // versions the field existedAs z.string(), so v1 should have it.
    const User = z.object({ id: z.string() }).named("S4User");

    const versions = runTwoVersionGen(
      { S4User: User },
      [
        schema(User)
          .field("nickname")
          .existedAs({ type: z.string() }),
      ],
    );

    const v2 = versions.get("v2")!.get("S4User")!.schema as ZodObject<any>;
    expect(v2.shape.nickname).toBeUndefined();

    const v1 = versions.get("v1")!.get("S4User")!.schema as ZodObject<any>;
    expect(v1.shape.nickname).toBeInstanceOf(ZodString);
  });

  it("31. existedAs with a nullable type", () => {
    const User = z.object({ id: z.string() }).named("S4NullUser");

    const versions = runTwoVersionGen(
      { S4NullUser: User },
      [
        schema(User)
          .field("bio")
          .existedAs({ type: z.string().nullable() }),
      ],
    );

    const v2 = versions.get("v2")!.get("S4NullUser")!.schema as ZodObject<any>;
    expect(v2.shape.bio).toBeUndefined();

    const v1 = versions.get("v1")!.get("S4NullUser")!.schema as ZodObject<any>;
    expect(v1.shape.bio).toBeInstanceOf(ZodNullable);
    expect(peel(v1.shape.bio)).toBeInstanceOf(ZodString);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Section 5: Registry lookup and transformSchemaReferences
// ════════════════════════════════════════════════════════════════════════

describe("Section 5: registry lookup + transformSchemaReferences", () => {
  it("32. registry.getVersioned returns versioned schema for a named original", () => {
    const Original = z.object({ x: z.string() }).named("S5Lookup");

    const versions = runTwoVersionGen(
      { S5Lookup: Original },
      [schema(Original).field("x").had({ type: z.number() })],
    );

    // Latest version registry: getVersioned on the original should return
    // a schema whose shape matches the latest (x is still a string).
    const v2 = versions.get("v2")!;
    const v2Looked = v2.getVersioned(Original) as ZodObject<any>;
    expect(v2Looked).toBeInstanceOf(ZodObject);
    expect(v2Looked.shape.x).toBeInstanceOf(ZodString);

    // Oldest version registry: x should be a number.
    const v1 = versions.get("v1")!;
    const v1Looked = v1.getVersioned(Original) as ZodObject<any>;
    expect(v1Looked).toBeInstanceOf(ZodObject);
    expect(v1Looked.shape.x).toBeInstanceOf(ZodNumber);

    // If the passed schema is unnamed, getVersioned must return the same object.
    const loose = z.object({ y: z.string() });
    expect(v1.getVersioned(loose)).toBe(loose);

    // If it's named but not in the registry, it's also returned unchanged.
    const stranger = z.object({ z: z.string() }).named("S5NotRegistered");
    expect(v1.getVersioned(stranger)).toBe(stranger);
  });

  it("33. transformSchemaReferences replaces named refs in a deeply nested tree", () => {
    // Build an "original" tree:
    //   Root { profile: Profile, history: z.array(Profile), tag: z.string() }
    // Then create a "versioned" Profile and register it.
    // transformSchemaReferences should swap both the plain `profile` field
    // and the `history` array's element with the versioned Profile.
    const Profile = z.object({ handle: z.string() }).named("S5Profile");
    const Root = z
      .object({
        profile: Profile,
        history: z.array(Profile),
        tag: z.string(),
      })
      .named("S5Root");

    const registry = new ZodSchemaRegistry();
    // A "new" Profile with a different field shape, tagged with the same
    // tsadwyn name so transformSchemaReferences recognises the match.
    const VersionedProfile = z
      .object({ handle: z.number() })
      .named("S5Profile");
    registry.register("S5Profile", VersionedProfile);

    const transformed = transformSchemaReferences(Root, registry) as ZodObject<any>;
    expect(transformed).toBeInstanceOf(ZodObject);

    const tProfile = transformed.shape.profile as ZodObject<any>;
    expect(tProfile).toBeInstanceOf(ZodObject);
    expect(tProfile.shape.handle).toBeInstanceOf(ZodNumber);

    const tHistory = transformed.shape.history as ZodArray<any>;
    expect(tHistory).toBeInstanceOf(ZodArray);
    const historyElem = (tHistory._def as any).type as ZodObject<any>;
    expect(historyElem.shape.handle).toBeInstanceOf(ZodNumber);

    // Unrelated primitives are preserved as-is.
    expect(transformed.shape.tag).toBeInstanceOf(ZodString);

    // No changes: empty registry returns the same tree.
    const empty = new ZodSchemaRegistry();
    expect(transformSchemaReferences(Root, empty)).toBe(Root);
  });
});
