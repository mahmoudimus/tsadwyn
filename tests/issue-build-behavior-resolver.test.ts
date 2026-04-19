/**
 * Covers `buildBehaviorResolver(map, fallback, opts?)` — the low-level
 * behavior-map resolver consumers reach for when they want a raw
 * `Map<version, value>` lookup without the full `createVersionedBehavior`
 * typed-shape ceremony. Exercises the `'silent' | 'warn-once' | 'warn-every'`
 * telemetry for unknown-version lookups.
 *
 * Run: npx vitest run tests/issue-build-behavior-resolver.test.ts
 */
import { describe, it, expect, vi } from "vitest";

import { apiVersionStorage, buildBehaviorResolver } from "../src/index.js";

interface Behavior {
  feature: string;
}

describe("Issue: buildBehaviorResolver helper", () => {
  it("returns the mapped behavior for a known version", () => {
    const map = new Map<string, Behavior>([
      ["2024-01-01", { feature: "v1" }],
      ["2025-01-01", { feature: "v2" }],
    ]);
    const fallback: Behavior = { feature: "head" };
    const resolve = buildBehaviorResolver(map, fallback);

    let result: Behavior | undefined;
    apiVersionStorage.run("2024-01-01", () => {
      result = resolve();
    });
    expect(result).toEqual({ feature: "v1" });
  });

  it("returns fallback when version is unknown", () => {
    const map = new Map<string, Behavior>([
      ["2024-01-01", { feature: "v1" }],
    ]);
    const fallback: Behavior = { feature: "head" };
    const resolve = buildBehaviorResolver(map, fallback);

    let result: Behavior | undefined;
    apiVersionStorage.run("2099-12-31", () => {
      result = resolve();
    });
    expect(result).toEqual({ feature: "head" });
  });

  it("returns fallback when no version is set in async storage", () => {
    const map = new Map<string, Behavior>([
      ["2024-01-01", { feature: "v1" }],
    ]);
    const fallback: Behavior = { feature: "head" };
    const resolve = buildBehaviorResolver(map, fallback);

    // Outside of any apiVersionStorage.run() — store is undefined
    expect(resolve()).toEqual({ feature: "head" });
  });

  it("warn-once dedupes per-version on unknown lookups", () => {
    const map = new Map<string, Behavior>([
      ["2024-01-01", { feature: "v1" }],
    ]);
    const fallback: Behavior = { feature: "head" };
    const warn = vi.fn();
    const resolve = buildBehaviorResolver(map, fallback, {
      onUnknown: "warn-once",
      logger: { warn },
    });

    apiVersionStorage.run("2099-12-31", () => {
      resolve();
      resolve();
      resolve();
    });
    apiVersionStorage.run("1999-12-31", () => {
      resolve();
      resolve();
    });

    // Two distinct unknown versions — two warns total
    expect(warn).toHaveBeenCalledTimes(2);
    const ctxArgs = warn.mock.calls.map((c) => c[0]);
    expect(ctxArgs.some((c: any) => c.version === "2099-12-31")).toBe(true);
    expect(ctxArgs.some((c: any) => c.version === "1999-12-31")).toBe(true);
  });

  it("warn-every emits on every unknown lookup", () => {
    const fallback: Behavior = { feature: "head" };
    const warn = vi.fn();
    const resolve = buildBehaviorResolver(new Map(), fallback, {
      onUnknown: "warn-every",
      logger: { warn },
    });

    apiVersionStorage.run("2099-12-31", () => {
      resolve();
      resolve();
      resolve();
    });

    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("silent mode emits no warnings", () => {
    const fallback: Behavior = { feature: "head" };
    const warn = vi.fn();
    const resolve = buildBehaviorResolver(new Map(), fallback, {
      onUnknown: "silent",
      logger: { warn },
    });

    apiVersionStorage.run("2099-12-31", () => {
      resolve();
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("warning context includes the supportedVersions for diagnosis", () => {
    const map = new Map<string, Behavior>([
      ["2024-01-01", { feature: "v1" }],
      ["2025-01-01", { feature: "v2" }],
    ]);
    const warn = vi.fn();
    const resolve = buildBehaviorResolver(map, { feature: "head" }, {
      onUnknown: "warn-every",
      logger: { warn },
    });

    apiVersionStorage.run("bogus", () => {
      resolve();
    });

    expect(warn).toHaveBeenCalledOnce();
    const ctx = warn.mock.calls[0][0];
    expect(ctx.version).toBe("bogus");
    expect(ctx.supportedVersions).toEqual(["2024-01-01", "2025-01-01"]);
  });
});

describe("buildBehaviorResolver — logger-required enforcement", () => {
  // Asking for warnings but providing nowhere to send them is the silent-
  // no-op footgun we want to eliminate. Throw loudly at construction so
  // the misconfiguration surfaces at boot, not in production when a
  // warning quietly fails to appear.
  it("throws when onUnknown is 'warn-once' and logger is missing", () => {
    const map = new Map<string, Behavior>([["2024-01-01", { feature: "v1" }]]);
    expect(() =>
      buildBehaviorResolver(map, { feature: "head" }, {
        onUnknown: "warn-once",
      }),
    ).toThrow(/requires a logger/i);
  });

  it("throws when onUnknown is 'warn-every' and logger is missing", () => {
    const map = new Map<string, Behavior>([["2024-01-01", { feature: "v1" }]]);
    expect(() =>
      buildBehaviorResolver(map, { feature: "head" }, {
        onUnknown: "warn-every",
      }),
    ).toThrow(/requires a logger/i);
  });

  it("does not throw when onUnknown is 'silent' and logger is missing", () => {
    const map = new Map<string, Behavior>([["2024-01-01", { feature: "v1" }]]);
    expect(() =>
      buildBehaviorResolver(map, { feature: "head" }, {
        onUnknown: "silent",
      }),
    ).not.toThrow();
  });

  it("does not throw when onUnknown is unspecified (defaults to 'silent')", () => {
    const map = new Map<string, Behavior>([["2024-01-01", { feature: "v1" }]]);
    expect(() =>
      buildBehaviorResolver(map, { feature: "head" }),
    ).not.toThrow();
  });
});
