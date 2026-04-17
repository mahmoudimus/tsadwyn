/**
 * Tests for `createVersionedBehavior` — typed overlay primitive.
 *
 * Covers:
 *   - Two-version (ares-monolith style): HEAD + INITIAL, all changes collapse.
 *   - Three-version: intermediate snapshot correctly reflects partial overlay.
 *   - .at() throws on unknown version.
 *   - .get() returns fallback for unknown version in apiVersionStorage.
 *   - Duplicate changes at same version: partials merge, conflicting keys warn.
 *   - Change at initialVersion throws (floor cannot introduce a change).
 *   - Custom compare function (semver/custom format).
 *   - Empty changes: map is empty; .get() falls back; .at() throws.
 *   - onUnknown: 'warn-once' logs exactly once per unknown version.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createVersionedBehavior,
  apiVersionStorage,
} from "../src/index.js";

interface Behavior {
  requireIdempotencyKey: boolean;
  rateLimitPerSec: number;
  errorShape: "flat" | "rfc7807";
}

const HEAD: Behavior = {
  requireIdempotencyKey: true,
  rateLimitPerSec: 1000,
  errorShape: "rfc7807",
};

describe("createVersionedBehavior — two-version collapse", () => {
  it("maps HEAD to HEAD_BEHAVIOR and INITIAL to HEAD + all behaviorHad", () => {
    const behavior = createVersionedBehavior<Behavior>({
      head: HEAD,
      initialVersion: "2024-01-01",
      changes: [
        {
          version: "2025-06-01",
          description: "idem now required at head",
          behaviorHad: { requireIdempotencyKey: false },
        },
        {
          version: "2025-06-01",
          description: "rate limit bumped",
          behaviorHad: { rateLimitPerSec: 100 },
        },
        {
          version: "2025-06-01",
          description: "error shape switched",
          behaviorHad: { errorShape: "flat" },
        },
      ],
    });

    expect(behavior.at("2025-06-01")).toEqual(HEAD);
    expect(behavior.at("2024-01-01")).toEqual({
      requireIdempotencyKey: false,
      rateLimitPerSec: 100,
      errorShape: "flat",
    });
  });
});

describe("createVersionedBehavior — multi-version interpolation", () => {
  it("intermediate version sees only changes newer than it", () => {
    const behavior = createVersionedBehavior<Behavior>({
      head: HEAD,
      initialVersion: "2024-01-01",
      changes: [
        { version: "2026-04-14", behaviorHad: { requireIdempotencyKey: false } },
        { version: "2025-06-01", behaviorHad: { rateLimitPerSec: 100 } },
        { version: "2025-01-01", behaviorHad: { errorShape: "flat" } },
      ],
    });

    // At 2026-04-14 (newest): no change is newer → pure HEAD.
    expect(behavior.at("2026-04-14")).toEqual(HEAD);

    // At 2025-06-01: the 2026-04-14 change is newer → idem rolled back.
    expect(behavior.at("2025-06-01")).toEqual({
      requireIdempotencyKey: false,
      rateLimitPerSec: 1000,
      errorShape: "rfc7807",
    });

    // At 2025-01-01: both 2026-04-14 and 2025-06-01 are newer → idem + rate rolled back.
    expect(behavior.at("2025-01-01")).toEqual({
      requireIdempotencyKey: false,
      rateLimitPerSec: 100,
      errorShape: "rfc7807",
    });

    // At 2024-01-01 (initial): every change is newer → everything rolled back.
    expect(behavior.at("2024-01-01")).toEqual({
      requireIdempotencyKey: false,
      rateLimitPerSec: 100,
      errorShape: "flat",
    });
  });

  it("exposes the snapshot map for changelog/admin UIs", () => {
    const behavior = createVersionedBehavior<Behavior>({
      head: HEAD,
      initialVersion: "2024-01-01",
      changes: [{ version: "2025-06-01", behaviorHad: { rateLimitPerSec: 100 } }],
    });

    const keys = [...behavior.map.keys()];
    expect(keys).toContain("2025-06-01");
    expect(keys).toContain("2024-01-01");
    expect(behavior.map.size).toBe(2);
  });
});

describe("createVersionedBehavior — .get() via apiVersionStorage", () => {
  it("resolves from the ALS-stored version", () => {
    const behavior = createVersionedBehavior<Behavior>({
      head: HEAD,
      initialVersion: "2024-01-01",
      changes: [{ version: "2025-06-01", behaviorHad: { rateLimitPerSec: 100 } }],
    });

    apiVersionStorage.run("2024-01-01", () => {
      expect(behavior.get().rateLimitPerSec).toBe(100);
    });
    apiVersionStorage.run("2025-06-01", () => {
      expect(behavior.get().rateLimitPerSec).toBe(1000);
    });
  });

  it("returns fallback when the version is unknown", () => {
    const fallback: Behavior = {
      requireIdempotencyKey: true,
      rateLimitPerSec: 42,
      errorShape: "flat",
    };
    const behavior = createVersionedBehavior<Behavior>({
      head: HEAD,
      fallback,
      initialVersion: "2024-01-01",
      changes: [{ version: "2025-06-01", behaviorHad: { rateLimitPerSec: 100 } }],
    });

    apiVersionStorage.run("1999-01-01", () => {
      expect(behavior.get()).toEqual(fallback);
    });
  });

  it("returns fallback (head by default) when ALS has no version", () => {
    const behavior = createVersionedBehavior<Behavior>({
      head: HEAD,
      initialVersion: "2024-01-01",
      changes: [{ version: "2025-06-01", behaviorHad: { rateLimitPerSec: 100 } }],
    });

    expect(behavior.get()).toEqual(HEAD);
  });
});

describe("createVersionedBehavior — errors and edges", () => {
  it(".at() throws on unknown version", () => {
    const behavior = createVersionedBehavior<Behavior>({
      head: HEAD,
      initialVersion: "2024-01-01",
      changes: [{ version: "2025-06-01", behaviorHad: { rateLimitPerSec: 100 } }],
    });

    expect(() => behavior.at("not-a-version")).toThrow(/unknown version/i);
  });

  it("rejects a change whose version equals initialVersion", () => {
    expect(() =>
      createVersionedBehavior<Behavior>({
        head: HEAD,
        initialVersion: "2024-01-01",
        changes: [{ version: "2024-01-01", behaviorHad: { rateLimitPerSec: 100 } }],
      }),
    ).toThrow(/matches initialVersion/i);
  });

  it("throws when head is not an object", () => {
    expect(() =>
      createVersionedBehavior({
        // @ts-expect-error — intentionally invalid
        head: null,
        changes: [],
      }),
    ).toThrow(/must be an object/i);
  });

  it("handles empty changes list: map is empty, .get() falls back", () => {
    const behavior = createVersionedBehavior<Behavior>({
      head: HEAD,
      changes: [],
    });

    expect(behavior.map.size).toBe(0);
    expect(behavior.get()).toEqual(HEAD);
    expect(() => behavior.at("2024-01-01")).toThrow(/unknown version/i);
  });

  it("supports a custom compare function (semver-style)", () => {
    const semverCompare = (a: string, b: string) => {
      const parse = (s: string) => s.split(".").map(Number);
      const [am, an, ap] = parse(a);
      const [bm, bn, bp] = parse(b);
      return am - bm || an - bn || ap - bp;
    };

    const behavior = createVersionedBehavior<Behavior>({
      head: HEAD,
      initialVersion: "1.0.0",
      compare: semverCompare,
      changes: [
        { version: "2.0.0", behaviorHad: { requireIdempotencyKey: false } },
        { version: "1.5.0", behaviorHad: { rateLimitPerSec: 100 } },
      ],
    });

    // At 2.0.0: no change is newer → HEAD.
    expect(behavior.at("2.0.0")).toEqual(HEAD);
    // At 1.5.0: 2.0.0 is newer → idem rolled back.
    expect(behavior.at("1.5.0").requireIdempotencyKey).toBe(false);
    expect(behavior.at("1.5.0").rateLimitPerSec).toBe(1000);
    // At 1.0.0: everything rolled back.
    expect(behavior.at("1.0.0")).toEqual({
      requireIdempotencyKey: false,
      rateLimitPerSec: 100,
      errorShape: "rfc7807",
    });
  });

  it("warns when two changes at same version set a field to different values", () => {
    const warn = vi.fn();
    createVersionedBehavior<Behavior>({
      head: HEAD,
      initialVersion: "2024-01-01",
      logger: { warn },
      changes: [
        { version: "2025-06-01", behaviorHad: { rateLimitPerSec: 100 } },
        { version: "2025-06-01", behaviorHad: { rateLimitPerSec: 50 } }, // conflict
      ],
    });

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ version: "2025-06-01", field: "rateLimitPerSec" }),
      expect.stringMatching(/set field "rateLimitPerSec" to different values/),
    );
  });

  it("does NOT warn when same-value duplicates merge (no conflict)", () => {
    const warn = vi.fn();
    createVersionedBehavior<Behavior>({
      head: HEAD,
      initialVersion: "2024-01-01",
      logger: { warn },
      changes: [
        { version: "2025-06-01", behaviorHad: { rateLimitPerSec: 100 } },
        { version: "2025-06-01", behaviorHad: { rateLimitPerSec: 100 } }, // same value
      ],
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("onUnknown: 'warn-once' logs exactly once per unique unknown version", () => {
    const warn = vi.fn();
    const behavior = createVersionedBehavior<Behavior>({
      head: HEAD,
      initialVersion: "2024-01-01",
      onUnknown: "warn-once",
      logger: { warn },
      changes: [{ version: "2025-06-01", behaviorHad: { rateLimitPerSec: 100 } }],
    });

    apiVersionStorage.run("ghost-1", () => behavior.get());
    apiVersionStorage.run("ghost-1", () => behavior.get()); // dedup
    apiVersionStorage.run("ghost-2", () => behavior.get());
    apiVersionStorage.run("ghost-2", () => behavior.get()); // dedup

    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("createVersionedBehavior — type contract", () => {
  it("rejects behaviorHad fields that don't exist on head (compile-time)", () => {
    // This test is more about forcing the Partial<B> contract to be
    // exercised at build time. Uncomment the block below to verify the
    // type-checker catches it; kept as a ts-expect-error so the regression
    // would surface as a test-file compile error.
    createVersionedBehavior<Behavior>({
      head: HEAD,
      initialVersion: "2024-01-01",
      changes: [
        {
          version: "2025-06-01",
          // @ts-expect-error — `nonExistentField` is not on Behavior
          behaviorHad: { nonExistentField: true },
        },
      ],
    });
    // At runtime we don't assert here — the ts-expect-error above is the
    // contract. This body is just placeholder so the test passes.
    expect(true).toBe(true);
  });
});
