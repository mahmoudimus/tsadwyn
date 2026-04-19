/**
 * `createVersionedBehavior` — typed overlay primitive for per-version
 * behavior (not schema) changes.
 *
 * Schema migrations cover wire-shape changes (field renames, additions,
 * endpoint lifecycle). The other half of API versioning is behavior: same
 * shape, different side effects, policy, or defaults. Consumers already
 * have `VersionChangeWithSideEffects` for on/off flags and
 * `buildBehaviorResolver` for raw `Map<version, value>` lookups. This
 * primitive fills the middle: a typed behavior shape + per-change deltas
 * (`behaviorHad: Partial<B>`) that overlay newest-to-oldest to derive each
 * supported version's snapshot at build time.
 *
 * Semantics:
 *   `change.version` = the version at which the change TAKES EFFECT. At that
 *   version (and any newer version that doesn't introduce a newer overriding
 *   change), the post-change value is `head[field]`. At versions STRICTLY
 *   OLDER than `change.version`, the pre-change value (`behaviorHad[field]`)
 *   is active.
 *
 * Usage:
 *
 *   interface Behavior { requireIdempotencyKey: boolean; rateLimitPerSec: number; }
 *   const HEAD: Behavior = { requireIdempotencyKey: true, rateLimitPerSec: 1000 };
 *
 *   const behavior = createVersionedBehavior({
 *     head: HEAD,
 *     initialVersion: '2024-01-01',
 *     changes: [
 *       { version: '2025-06-01', description: 'rate limit bumped',
 *         behaviorHad: { rateLimitPerSec: 100 } },
 *       { version: '2025-01-01', description: 'idem now required',
 *         behaviorHad: { requireIdempotencyKey: false } },
 *     ],
 *   });
 *
 *   behavior.get().rateLimitPerSec;       // inside a request
 *   behavior.at('2025-01-01');             // explicit lookup (tests, admin)
 *   behavior.map;                          // readonly Map for changelog UI
 */

import { buildBehaviorResolver } from "./behavior-resolver.js";
import { TsadwynStructureError } from "./exceptions.js";

export interface VersionBehaviorChange<B> {
  /**
   * The version at which this change takes effect. At this version (and
   * newer), the post-change value is head's value. At versions strictly
   * older, `behaviorHad` is active.
   */
  version: string;
  /** Human-readable description — pairs with the changelog entry. */
  description?: string;
  /** Field values in the version BEFORE this change was introduced. */
  behaviorHad: Partial<B>;
}

export interface CreateVersionedBehaviorOptions<B> {
  /** The head (latest) behavior snapshot. All older versions derive from this. */
  head: B;
  /**
   * Per-version deltas. Order doesn't matter — the builder groups by
   * `version` and walks newest-first internally.
   */
  changes: ReadonlyArray<VersionBehaviorChange<B>>;
  /**
   * Optional version string representing the oldest supported version.
   * When supplied, `map[initialVersion]` contains the snapshot with every
   * change's `behaviorHad` applied (i.e., before any tracked change).
   * Typical use: the `INITIAL_VERSION` constant in your `VersionBundle`.
   */
  initialVersion?: string;
  /**
   * Fallback when an unknown version is active at `.get()` time. Default: `head`.
   */
  fallback?: B;
  /** Telemetry policy for unknown-version lookups via `.get()`. */
  onUnknown?: "silent" | "warn-once" | "warn-every";
  /**
   * Structured logger. **Required** when `onUnknown !== 'silent'` —
   * `createVersionedBehavior` throws `TsadwynStructureError` at
   * construction if you ask for warnings without providing a sink.
   * Delegated to `buildBehaviorResolver`'s enforcement.
   */
  logger?: {
    warn: (ctx: Record<string, unknown>, msg: string) => void;
  };
  /**
   * Optional comparator controlling "strictly older than" ordering. Default:
   * ISO-date string compare (works for `YYYY-MM-DD` version strings). Supply
   * a custom comparator for semver or other formats.
   *
   * Contract: `compare(a, b) < 0` iff `a` is older than `b`.
   */
  compare?: (a: string, b: string) => number;
}

export interface VersionedBehavior<B> {
  /**
   * Resolve the behavior for the current request (reads `apiVersionStorage`).
   * Returns `fallback` when the version is absent or unknown.
   */
  get(): B;
  /**
   * Explicit lookup for a known version. Throws on unknown — use when
   * absence should surface as a bug (tests, admin UIs, diagnostics).
   */
  at(version: string): B;
  /** Read-only snapshot map for changelog UIs / admin introspection. */
  readonly map: ReadonlyMap<string, B>;
}

export function createVersionedBehavior<B extends object>(
  opts: CreateVersionedBehaviorOptions<B>,
): VersionedBehavior<B> {
  if (!opts.head || typeof opts.head !== "object") {
    throw new TsadwynStructureError(
      "createVersionedBehavior: `head` must be an object describing the latest behavior snapshot.",
    );
  }

  const compare = opts.compare ?? ((a: string, b: string) => a < b ? -1 : a > b ? 1 : 0);

  // Group changes by version so duplicates at the same version merge.
  const byVersion = new Map<string, Array<VersionBehaviorChange<B>>>();
  for (const change of opts.changes) {
    const bucket = byVersion.get(change.version) ?? [];
    bucket.push(change);
    byVersion.set(change.version, bucket);
  }

  // Reject change.version === initialVersion — initialVersion is the floor
  // (the version BEFORE any tracked change), so a change can't be introduced
  // at it.
  if (opts.initialVersion !== undefined && byVersion.has(opts.initialVersion)) {
    throw new TsadwynStructureError(
      `createVersionedBehavior: change.version "${opts.initialVersion}" matches initialVersion. ` +
        `The initial version is the floor (before any tracked change) — changes must be introduced AT a newer version.`,
    );
  }

  // Distinct change versions, newest-first.
  const changeVersions = [...byVersion.keys()].sort((a, b) => compare(b, a));

  // Build snapshots: for each change.version key, the snapshot is HEAD with
  // every `behaviorHad` from changes STRICTLY NEWER than this version applied.
  const map = new Map<string, B>();
  for (const v of changeVersions) {
    const snapshot: B = { ...opts.head };
    for (const newerV of changeVersions) {
      if (compare(newerV, v) <= 0) continue; // only strictly newer
      applyBucket(snapshot, byVersion.get(newerV)!, newerV, opts.logger);
    }
    map.set(v, snapshot);
  }

  // If initialVersion is supplied, its snapshot applies EVERY change (no
  // tracked change is newer than the initial — everything is newer).
  if (opts.initialVersion !== undefined) {
    const initial: B = { ...opts.head };
    for (const v of changeVersions) {
      applyBucket(initial, byVersion.get(v)!, v, opts.logger);
    }
    map.set(opts.initialVersion, initial);
  }

  const fallback = opts.fallback ?? opts.head;
  const resolveViaBase = buildBehaviorResolver<B>(map, fallback, {
    onUnknown: opts.onUnknown,
    logger: opts.logger,
  });

  return {
    get: () => resolveViaBase(),
    at: (version: string) => {
      const snapshot = map.get(version);
      if (!snapshot) {
        throw new TsadwynStructureError(
          `createVersionedBehavior.at("${version}"): unknown version. ` +
            `Known versions: [${[...map.keys()].join(", ")}]`,
        );
      }
      return snapshot;
    },
    map,
  };
}

function applyBucket<B extends object>(
  snapshot: B,
  bucket: ReadonlyArray<VersionBehaviorChange<B>>,
  version: string,
  logger?: { warn: (ctx: Record<string, unknown>, msg: string) => void },
): void {
  const writes = new Map<keyof B, unknown>();
  for (const change of bucket) {
    for (const key of Object.keys(change.behaviorHad) as (keyof B)[]) {
      const nextValue = change.behaviorHad[key];
      if (writes.has(key) && writes.get(key) !== nextValue) {
        logger?.warn(
          { version, field: String(key), previousValue: writes.get(key), nextValue },
          `Two VersionBehaviorChange entries at "${version}" set field "${String(key)}" to different values; last-write-wins.`,
        );
      }
      writes.set(key, nextValue);
      (snapshot as Record<keyof B, unknown>)[key] = nextValue as B[typeof key];
    }
  }
}
