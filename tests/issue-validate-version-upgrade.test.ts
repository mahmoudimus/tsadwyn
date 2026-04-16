/**
 * FAILING TEST — verifies the gap described in tsadwyn-issues-additional-gaps.md §4
 *
 * Every adopter writing a `/versioning/upgrade` endpoint re-implements the
 * same upgrade-policy decisions: is target supported, is it a downgrade, is
 * it a no-op, how do we compare version strings. The proposed
 * `validateVersionUpgrade()` standardizes this as a pure function.
 *
 * Run: npx vitest run tests/issue-validate-version-upgrade.test.ts
 */
import { describe, it, expect } from "vitest";

// GAP: validateVersionUpgrade is not exported from tsadwyn yet.
// @ts-expect-error — intentional: drives the failing-import signal
import { validateVersionUpgrade } from "../src/index.js";

const SUPPORTED = ["2026-01-01", "2025-06-01", "2025-01-01", "2024-01-01"] as const;

describe("Issue: validateVersionUpgrade policy helper", () => {
  it("accepts a valid forward upgrade and returns previous + next", () => {
    const decision = validateVersionUpgrade({
      current: "2025-01-01",
      target: "2025-06-01",
      supported: SUPPORTED,
    });
    expect(decision).toEqual({
      ok: true,
      previous: "2025-01-01",
      next: "2025-06-01",
    });
  });

  it("rejects an unsupported target version", () => {
    const decision = validateVersionUpgrade({
      current: "2024-01-01",
      target: "2099-01-01",
      supported: SUPPORTED,
    });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("unsupported");
  });

  it("rejects downgrade by default", () => {
    const decision = validateVersionUpgrade({
      current: "2026-01-01",
      target: "2025-01-01",
      supported: SUPPORTED,
    });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("downgrade-blocked");
  });

  it("permits downgrade when allowDowngrade is true", () => {
    const decision = validateVersionUpgrade({
      current: "2026-01-01",
      target: "2025-01-01",
      supported: SUPPORTED,
      allowDowngrade: true,
    });
    expect(decision).toEqual({
      ok: true,
      previous: "2026-01-01",
      next: "2025-01-01",
    });
  });

  it("rejects no-change by default", () => {
    const decision = validateVersionUpgrade({
      current: "2025-01-01",
      target: "2025-01-01",
      supported: SUPPORTED,
    });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("no-change");
  });

  it("permits no-change when allowNoChange is true", () => {
    const decision = validateVersionUpgrade({
      current: "2025-01-01",
      target: "2025-01-01",
      supported: SUPPORTED,
      allowNoChange: true,
    });
    expect(decision.ok).toBe(true);
  });

  it("default 'iso-date' comparison sorts lexicographically (which works for YYYY-MM-DD)", () => {
    // 2025-06-01 > 2025-01-01 lexicographically — forward upgrade
    const fwd = validateVersionUpgrade({
      current: "2025-01-01",
      target: "2025-06-01",
      supported: SUPPORTED,
    });
    expect(fwd.ok).toBe(true);

    // 2025-01-01 < 2025-06-01 → downgrade blocked
    const back = validateVersionUpgrade({
      current: "2025-06-01",
      target: "2025-01-01",
      supported: SUPPORTED,
    });
    expect(back.ok).toBe(false);
  });

  it("supports a custom comparator", () => {
    const SEMVER = ["v1.0.0", "v2.0.0", "v3.0.0"] as const;
    const decision = validateVersionUpgrade({
      current: "v1.0.0",
      target: "v3.0.0",
      supported: SEMVER,
      compare: (a: string, b: string) =>
        parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10),
    });
    expect(decision).toEqual({ ok: true, previous: "v1.0.0", next: "v3.0.0" });
  });
});
