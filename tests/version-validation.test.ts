import { describe, it, expect } from "vitest";
import { z } from "zod";

import {
  Tsadwyn,
  Version,
  VersionBundle,
  VersionChange,
  VersionChangeWithSideEffects,
  schema,
  apiVersionStorage,
  TsadwynError,
  TsadwynStructureError,
} from "../src/index.js";

// Helper schema for instructions
const TestSchema = z.object({ name: z.string() }).named("TestSchema");

// --- T-1000: VersionChange validation ---

describe("T-1000: VersionChange validation at definition time", () => {
  it("throws TsadwynStructureError when description is empty", () => {
    class BadChange extends VersionChange {
      description = "";
      instructions = [];
    }

    expect(() => new Version("2024-01-01", BadChange)).toThrow(TsadwynStructureError);
    expect(() => new Version("2024-01-01", BadChange)).toThrow(
      /description is not set/,
    );
  });

  it("throws TsadwynStructureError when description is whitespace only", () => {
    class WhitespaceChange extends VersionChange {
      description = "   ";
      instructions = [];
    }

    expect(() => new Version("2024-01-01", WhitespaceChange)).toThrow(TsadwynStructureError);
    expect(() => new Version("2024-01-01", WhitespaceChange)).toThrow(
      /description is not set/,
    );
  });

  it("throws TsadwynStructureError when instructions is not an array", () => {
    class BadInstrChange extends VersionChange {
      description = "Some change";
      instructions = "not an array" as any;
    }

    expect(() => new Version("2024-01-01", BadInstrChange)).toThrow(TsadwynStructureError);
    expect(() => new Version("2024-01-01", BadInstrChange)).toThrow(
      /must be an array/,
    );
  });

  it("throws TsadwynStructureError when an instruction has unknown kind", () => {
    class UnknownInstrChange extends VersionChange {
      description = "Some change";
      instructions = [{ kind: "totally_unknown", foo: "bar" } as any];
    }

    expect(() => new Version("2024-01-01", UnknownInstrChange)).toThrow(TsadwynStructureError);
    expect(() => new Version("2024-01-01", UnknownInstrChange)).toThrow(
      /not a recognized instruction type/,
    );
  });

  it("throws TsadwynStructureError when an instruction is null", () => {
    class NullInstrChange extends VersionChange {
      description = "Some change";
      instructions = [null as any];
    }

    expect(() => new Version("2024-01-01", NullInstrChange)).toThrow(TsadwynStructureError);
  });

  it("throws TsadwynStructureError when VersionChange base class is used directly", () => {
    expect(() => new Version("2024-01-01", VersionChange as any)).toThrow(TsadwynStructureError);
    expect(() => new Version("2024-01-01", VersionChange as any)).toThrow(
      /used directly instead of being subclassed/,
    );
  });

  it("accepts a valid VersionChange subclass", () => {
    class GoodChange extends VersionChange {
      description = "Added new field";
      instructions = [
        schema(TestSchema).field("name").had({ name: "oldName" }),
      ];
    }

    // Should not throw
    const version = new Version("2024-01-01", GoodChange);
    expect(version.changes).toHaveLength(1);
  });

  it("accepts a VersionChange with empty instructions array", () => {
    class EmptyInstrChange extends VersionChange {
      description = "Side-effect only change";
      instructions = [];
    }

    const version = new Version("2024-01-01", EmptyInstrChange);
    expect(version.changes).toHaveLength(1);
  });
});

// --- T-1001: VersionChangeWithSideEffects ---

describe("T-1001: VersionChangeWithSideEffects", () => {
  it("isApplied throws TsadwynError when not bound to any VersionBundle", () => {
    class UnboundSideEffect extends VersionChangeWithSideEffects {
      description = "Some side effect";
      instructions = [];
    }

    // Not bound to any bundle yet
    expect(() => UnboundSideEffect.isApplied).toThrow(TsadwynError);
    expect(() => UnboundSideEffect.isApplied).toThrow(
      /never bound to any version/,
    );
  });

  it("isApplied returns true when no version is set (unversioned request)", () => {
    class SideEffectChange extends VersionChangeWithSideEffects {
      description = "Feature flag change";
      instructions = [];
    }

    new VersionBundle(
      new Version("2024-02-01", SideEffectChange),
      new Version("2024-01-01"),
    );

    // Outside of any AsyncLocalStorage context -> no version set
    expect(SideEffectChange.isApplied).toBe(true);
  });

  it("isApplied returns true when change version >= current request version", () => {
    class AppliedChange extends VersionChangeWithSideEffects {
      description = "Applied change";
      instructions = [];
    }

    new VersionBundle(
      new Version("2024-02-01", AppliedChange),
      new Version("2024-01-01"),
    );

    // Simulate a request with version 2024-01-01 (older version)
    // The change is at 2024-02-01, which is >= 2024-01-01, so isApplied = true
    let result: boolean | undefined;
    apiVersionStorage.run("2024-01-01", () => {
      result = AppliedChange.isApplied;
    });
    expect(result).toBe(true);
  });

  it("isApplied returns true when change version equals current request version", () => {
    class ExactVersionChange extends VersionChangeWithSideEffects {
      description = "Exact version change";
      instructions = [];
    }

    new VersionBundle(
      new Version("2024-02-01", ExactVersionChange),
      new Version("2024-01-01"),
    );

    let result: boolean | undefined;
    apiVersionStorage.run("2024-02-01", () => {
      result = ExactVersionChange.isApplied;
    });
    expect(result).toBe(true);
  });

  it("isApplied returns false when change version < current request version", () => {
    class OlderChange extends VersionChangeWithSideEffects {
      description = "Older change";
      instructions = [];
    }

    new VersionBundle(
      new Version("2024-03-01"),
      new Version("2024-02-01", OlderChange),
      new Version("2024-01-01"),
    );

    // Request version 2024-03-01 is newer than the change version 2024-02-01
    // So the change is NOT applied for this request version
    let result: boolean | undefined;
    apiVersionStorage.run("2024-03-01", () => {
      result = OlderChange.isApplied;
    });
    expect(result).toBe(false);
  });

  it("can be used as a regular VersionChange in a Version", () => {
    class SideEffectWithInstructions extends VersionChangeWithSideEffects {
      description = "Change with instructions and side effects";
      instructions = [
        schema(TestSchema).field("name").didntExist,
      ];
    }

    const version = new Version("2024-01-01", SideEffectWithInstructions);
    expect(version.changes).toHaveLength(1);
    expect(version.changes[0]._alterSchemaInstructions).toHaveLength(1);
  });
});

// --- T-1002: VersionChange binding ---

describe("T-1002: VersionChange binding to VersionBundle", () => {
  it("binds VersionChange classes to the bundle on construction", () => {
    class BoundChange extends VersionChange {
      description = "Bound change";
      instructions = [];
    }

    const bundle = new VersionBundle(
      new Version("2024-02-01", BoundChange),
      new Version("2024-01-01"),
    );

    // The static property should now be set
    expect((BoundChange as any)._boundToBundle).toBe(bundle);
    expect((BoundChange as any)._boundVersion).toBe("2024-02-01");
  });

  it("throws TsadwynStructureError when re-binding a VersionChange to a different VersionBundle", () => {
    class ReusableChange extends VersionChange {
      description = "Reusable change";
      instructions = [];
    }

    // First binding
    const bundle1 = new VersionBundle(
      new Version("2024-02-01", ReusableChange),
      new Version("2024-01-01"),
    );
    expect((ReusableChange as any)._boundToBundle).toBe(bundle1);

    // Re-binding to a different bundle should throw (T-1602)
    expect(() => {
      new VersionBundle(
        new Version("2025-02-01", ReusableChange),
        new Version("2025-01-01"),
      );
    }).toThrow(TsadwynStructureError);
  });

  it("allows different VersionChange classes in different bundles", () => {
    class ChangeA extends VersionChange {
      description = "Change A";
      instructions = [];
    }

    class ChangeB extends VersionChange {
      description = "Change B";
      instructions = [];
    }

    const bundle1 = new VersionBundle(
      new Version("2024-02-01", ChangeA),
      new Version("2024-01-01"),
    );

    const bundle2 = new VersionBundle(
      new Version("2025-02-01", ChangeB),
      new Version("2025-01-01"),
    );

    expect(bundle1.versions).toHaveLength(2);
    expect(bundle2.versions).toHaveLength(2);
    expect((ChangeA as any)._boundToBundle).toBe(bundle1);
    expect((ChangeB as any)._boundToBundle).toBe(bundle2);
  });
});

// --- T-1003: Version ordering validation ---

describe("T-1003: Version ordering validation", () => {
  describe("via VersionBundle with explicit apiVersionFormat", () => {
    it("validates ISO date format when apiVersionFormat is 'date'", () => {
      expect(
        () =>
          new VersionBundle(
            new Version("not-a-date"),
            new Version("2024-01-01"),
            { apiVersionFormat: "date" },
          ),
      ).toThrow(TsadwynStructureError);
      expect(
        () =>
          new VersionBundle(
            new Version("not-a-date"),
            new Version("2024-01-01"),
            { apiVersionFormat: "date" },
          ),
      ).toThrow(/not a valid ISO date/);
    });

    it("rejects invalid calendar dates like 2024-02-30", () => {
      expect(
        () =>
          new VersionBundle(
            new Version("2024-02-30"),
            new Version("2024-01-01"),
            { apiVersionFormat: "date" },
          ),
      ).toThrow(TsadwynStructureError);
    });

    it("rejects partial date formats", () => {
      expect(
        () =>
          new VersionBundle(
            new Version("2024-02"),
            new Version("2024-01-01"),
            { apiVersionFormat: "date" },
          ),
      ).toThrow(TsadwynStructureError);
    });

    it("throws when versions are not sorted newest-first (date format)", () => {
      expect(
        () =>
          new VersionBundle(
            new Version("2024-01-01"),
            new Version("2024-02-01"),
            { apiVersionFormat: "date" },
          ),
      ).toThrow(TsadwynStructureError);
      expect(
        () =>
          new VersionBundle(
            new Version("2024-01-01"),
            new Version("2024-02-01"),
            { apiVersionFormat: "date" },
          ),
      ).toThrow(/sorted from newest to oldest/);
    });

    it("accepts correctly sorted date versions", () => {
      const bundle = new VersionBundle(
        new Version("2024-03-01"),
        new Version("2024-02-01"),
        new Version("2024-01-01"),
        { apiVersionFormat: "date" },
      );
      expect(bundle.versionValues).toEqual(["2024-03-01", "2024-02-01", "2024-01-01"]);
    });

    it("skips date validation when apiVersionFormat is 'string'", () => {
      const bundle = new VersionBundle(
        new Version("v3"),
        new Version("v2"),
        new Version("v1"),
        { apiVersionFormat: "string" },
      );
      expect(bundle.versionValues).toEqual(["v3", "v2", "v1"]);
    });
  });

  describe("via Tsadwyn (default date format)", () => {
    it("validates ISO date format by default in Tsadwyn", () => {
      expect(
        () =>
          new Tsadwyn({
            versions: new VersionBundle(
              new Version("v2"),
              new Version("v1"),
            ),
          }),
      ).toThrow(TsadwynStructureError);
    });

    it("validates ordering by default in Tsadwyn", () => {
      expect(
        () =>
          new Tsadwyn({
            versions: new VersionBundle(
              new Version("2024-01-01"),
              new Version("2024-02-01"),
            ),
          }),
      ).toThrow(TsadwynStructureError);
    });

    it("skips date validation in Tsadwyn when apiVersionFormat is 'string'", () => {
      expect(
        () =>
          new Tsadwyn({
            versions: new VersionBundle(
              new Version("v2"),
              new Version("v1"),
            ),
            apiVersionFormat: "string",
          }),
      ).not.toThrow();
    });
  });
});

// --- Existing validation still works ---

describe("Existing VersionBundle validation", () => {
  it("throws TsadwynStructureError on empty version list", () => {
    expect(() => new VersionBundle()).toThrow(TsadwynStructureError);
  });

  it("throws TsadwynStructureError when oldest version has changes", () => {
    class SomeChange extends VersionChange {
      description = "A change";
      instructions = [];
    }

    expect(
      () => new VersionBundle(new Version("2024-01-01", SomeChange)),
    ).toThrow(TsadwynStructureError);
    expect(
      () => new VersionBundle(new Version("2024-01-01", SomeChange)),
    ).toThrow(/cannot have any version changes/);
  });

  it("throws TsadwynStructureError on duplicate version values", () => {
    expect(
      () =>
        new VersionBundle(
          new Version("2024-01-01"),
          new Version("2024-01-01"),
        ),
    ).toThrow(TsadwynStructureError);
    expect(
      () =>
        new VersionBundle(
          new Version("2024-01-01"),
          new Version("2024-01-01"),
        ),
    ).toThrow(/Duplicate version value/);
  });
});
