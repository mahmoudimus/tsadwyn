/**
 * Phase 16: Validation Strictness (T-1600 through T-1608)
 *
 * Tests that tsadwyn properly rejects invalid input that Tsadwyn also rejects.
 * These cover silent-failure bugs where tsadwyn accepts invalid input.
 *
 * Run: npx vitest run tests/validation-strictness.test.ts
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";

import {
  Tsadwyn,
  Version,
  VersionBundle,
  VersionChange,
  VersionChangeWithSideEffects,
  VersionedRouter,
  schema,
  endpoint,
  convertRequestToNextVersionFor,
  convertResponseToPreviousVersionFor,
  RequestInfo,
  ResponseInfo,
  InvalidGenerationInstructionError,
  TsadwynStructureError,
  RouterGenerationError,
  RouteAlreadyExistsError,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// T-1600: Unregistered schema in schema instructions
// ---------------------------------------------------------------------------

describe("T-1600: unregistered schema in schema instructions", () => {
  it("throws InvalidGenerationInstructionError when a schema instruction targets a truly unknown schema", () => {
    // Create an instruction that references a schema name that was never
    // passed to schema() and never put on a route — a truly unknown name.
    const UsedSchema = z.object({ value: z.string() }).named("T1600_UsedSchema");

    class BadChange extends VersionChange {
      description = "References a schema that doesn't exist anywhere";
      // Manually craft an instruction with a name that was never registered
      instructions = [
        {
          kind: "field_had" as const,
          schemaName: "T1600_CompletelyUnknownSchema",
          fieldName: "name",
          oldName: "old_name",
          oldType: undefined,
          isHiddenFromChangelog: false,
          hasDefault: false,
        },
      ];
    }

    const router = new VersionedRouter();
    router.get("/items", null, UsedSchema, async () => {
      return { value: "hello" };
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", BadChange),
        new Version("2000-01-01"),
      ),
    });

    // The error should be thrown during generation when the schema isn't in the registry
    expect(() => app.generateAndIncludeVersionedRouters(router)).toThrow(
      InvalidGenerationInstructionError,
    );
  });

  it("auto-discovers schemas referenced via schema() even if not on a route (T-2400)", () => {
    // schema() was called with this Zod object, so it IS known — should NOT throw
    const NestedSchema = z.object({ name: z.string() }).named("T1600_NestedSchema");
    const UsedSchema = z.object({ value: z.string() }).named("T1600_UsedSchema2");

    class GoodChange extends VersionChange {
      description = "References a schema via schema() DSL";
      instructions = [
        schema(NestedSchema).field("name").had({ name: "old_name" }),
      ];
    }

    const router = new VersionedRouter();
    router.get("/items", null, UsedSchema, async () => {
      return { value: "hello" };
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", GoodChange),
        new Version("2000-01-01"),
      ),
    });

    // Should NOT throw — schema is discovered from the instruction via T-2400
    expect(() => app.generateAndIncludeVersionedRouters(router)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// T-1602: Double-binding prevention
// ---------------------------------------------------------------------------

describe("T-1602: double-binding prevention", () => {
  it("throws TsadwynStructureError when a VersionChange is used in two different VersionBundles", () => {
    class SharedChange extends VersionChange {
      description = "I am shared between two bundles";
      instructions = [];
    }

    // First bundle binds the change
    const _bundleA = new VersionBundle(
      new Version("2024-02-01", SharedChange),
      new Version("2024-01-01"),
    );

    // Second bundle should reject the same change class
    expect(
      () =>
        new VersionBundle(
          new Version("2025-02-01", SharedChange),
          new Version("2025-01-01"),
        ),
    ).toThrow(TsadwynStructureError);
    expect(
      () =>
        new VersionBundle(
          new Version("2025-02-01", SharedChange),
          new Version("2025-01-01"),
        ),
    ).toThrow(/already bound/);
  });
});

// ---------------------------------------------------------------------------
// T-1603: endpoint().had() no-op detection
// ---------------------------------------------------------------------------

describe("T-1603: endpoint().had() no-op detection", () => {
  it("throws RouterGenerationError when endpoint().had() specifies the same statusCode", () => {
    // The route already has statusCode 200 (default). Trying to set it to 200 is a no-op.
    const Res = z.object({ ok: z.boolean() }).named("T1603_Res");

    class NoOpChange extends VersionChange {
      description = "No-op status code change";
      instructions = [
        endpoint("/items", ["GET"]).had({ statusCode: 200 }),
      ];
    }

    const router = new VersionedRouter();
    router.get("/items", null, Res, async () => ({ ok: true }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", NoOpChange),
        new Version("2000-01-01"),
      ),
    });

    expect(() => app.generateAndIncludeVersionedRouters(router)).toThrow(
      RouterGenerationError,
    );
    expect(() => app.generateAndIncludeVersionedRouters(router)).toThrow(
      /no effect|no-op/i,
    );
  });

  it("does not throw when endpoint().had() specifies a different statusCode", () => {
    const Res = z.object({ ok: z.boolean() }).named("T1603_Res2");

    class RealChange extends VersionChange {
      description = "Real status code change";
      instructions = [
        endpoint("/items", ["GET"]).had({ statusCode: 201 }),
      ];
    }

    const router = new VersionedRouter();
    router.get("/items", null, Res, async () => ({ ok: true }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", RealChange),
        new Version("2000-01-01"),
      ),
    });

    // Should not throw
    expect(() => app.generateAndIncludeVersionedRouters(router)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// T-1605: Ambiguous endpoint().existed
// ---------------------------------------------------------------------------

describe("T-1605: ambiguous endpoint().existed", () => {
  it("throws RouteAlreadyExistsError when multiple deleted routes match without funcName", () => {
    const Res = z.object({ ok: z.boolean() }).named("T1605_Res");

    // Register two routes with the same path+method but different funcNames
    const router = new VersionedRouter();

    async function handlerA() { return { ok: true }; }
    async function handlerB() { return { ok: false }; }

    router.get("/things", null, Res, handlerA);
    router.get("/things", null, Res, handlerB);

    // Mark both as deleted in the latest version
    router.onlyExistsInOlderVersions("/things", ["GET"]);

    // Version change tries to restore without funcName
    class RestoreWithoutFuncName extends VersionChange {
      description = "Restore ambiguous route without funcName";
      instructions = [
        endpoint("/things", ["GET"]).existed,
      ];
    }

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", RestoreWithoutFuncName),
        new Version("2000-01-01"),
      ),
    });

    expect(() => app.generateAndIncludeVersionedRouters(router)).toThrow(
      RouteAlreadyExistsError,
    );
  });
});

// ---------------------------------------------------------------------------
// T-1607: VersionChange subclassing prevention
// ---------------------------------------------------------------------------

describe("T-1607: VersionChange subclassing prevention", () => {
  it("throws TypeError when a VersionChange subclass is itself subclassed", () => {
    class Base extends VersionChange {
      description = "Base change";
      instructions = [];
    }

    // Sub extends Base extends VersionChange — should be rejected
    class Sub extends Base {
      description = "Sub change";
      instructions = [];
    }

    expect(() => new Version("2024-01-01", Sub)).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// T-1608: VersionChange instantiation prevention
// ---------------------------------------------------------------------------

describe("T-1608: VersionChange instantiation prevention", () => {
  it("throws TypeError when a VersionChange is directly instantiated by user code", () => {
    class MyChange extends VersionChange {
      description = "My change";
      instructions = [];
    }

    // Direct instantiation outside of Version constructor should fail
    expect(() => new MyChange()).toThrow(TypeError);
  });

  it("does not throw when VersionChange is constructed through Version", () => {
    class ValidChange extends VersionChange {
      description = "Valid change constructed through Version";
      instructions = [];
    }

    // Version constructor should be able to create instances just fine
    expect(() => new Version("2024-01-01", ValidChange)).not.toThrow();
  });
});
