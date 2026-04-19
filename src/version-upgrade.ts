/**
 * Canonical upgrade-policy helper for `/versioning/upgrade`-style endpoints.
 *
 * Consumers building a POST /versioning/upgrade endpoint all face the same
 * policy decisions: is the target version supported, is it a downgrade, is it
 * a no-op. This helper standardizes the answer as a pure function so every
 * adopter exposes the same upgrade semantics.
 */

export type CompareFn = (a: string, b: string) => number;

export interface ValidateVersionUpgradeArgs {
  current: string;
  target: string;
  supported: readonly string[];
  /** Default: false — downgrades are rejected. */
  allowDowngrade?: boolean;
  /** Default: false — same-version target is rejected. */
  allowNoChange?: boolean;
  /**
   * Version comparison strategy.
   * - 'iso-date' (default): lexicographic string comparison. Correct for YYYY-MM-DD.
   * - 'semver': strips a leading `v`, compares semver parts numerically.
   * - function: custom comparator returning negative / zero / positive.
   */
  compare?: "iso-date" | "semver" | CompareFn;
}

export type ValidateVersionUpgradeResult =
  | { ok: true; previous: string; next: string }
  | {
      ok: false;
      reason: "unsupported" | "downgrade-blocked" | "no-change";
      detail?: string;
    };

/**
 * Parse a semver-ish string (optionally prefixed with `v`) into an array of
 * numeric parts. Missing parts are treated as 0.
 */
function parseSemverParts(value: string): number[] {
  const stripped = value.startsWith("v") ? value.slice(1) : value;
  return stripped.split(".").map((p) => {
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

function semverCompare(a: string, b: string): number {
  const pa = parseSemverParts(a);
  const pb = parseSemverParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

function isoDateCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Evaluate whether a client may upgrade from `current` to `target`.
 *
 * Returns a discriminated union: either `{ok: true, previous, next}` for a
 * permitted transition, or `{ok: false, reason}` with a structured reason
 * that consumers can map onto their own error codes.
 */
export function validateVersionUpgrade(
  args: ValidateVersionUpgradeArgs,
): ValidateVersionUpgradeResult {
  const {
    current,
    target,
    supported,
    allowDowngrade = false,
    allowNoChange = false,
    compare = "iso-date",
  } = args;

  if (!supported.includes(target)) {
    return {
      ok: false,
      reason: "unsupported",
      detail: `Target version "${target}" is not in the supported list.`,
    };
  }

  const cmp: CompareFn =
    typeof compare === "function"
      ? compare
      : compare === "semver"
        ? semverCompare
        : isoDateCompare;

  const diff = cmp(current, target);

  if (diff === 0) {
    if (allowNoChange) {
      return { ok: true, previous: current, next: target };
    }
    return {
      ok: false,
      reason: "no-change",
      detail: `Target version equals current version "${current}".`,
    };
  }

  if (diff > 0) {
    // current is newer than target -> downgrade
    if (allowDowngrade) {
      return { ok: true, previous: current, next: target };
    }
    return {
      ok: false,
      reason: "downgrade-blocked",
      detail: `Downgrading from "${current}" to "${target}" is not allowed.`,
    };
  }

  return { ok: true, previous: current, next: target };
}
