/**
 * `cachedPerClientDefaultVersion` — TTL-cached variant of
 * `perClientDefaultVersion` with explicit invalidation handles.
 *
 * `perClientDefaultVersion` calls `resolvePin` on every unauthenticated-
 * default request. For high-traffic APIs with DB-backed pin storage, that
 * becomes N queries per second. The fix is a cross-request cache keyed by
 * client id — but caching needs invalidation: when a client hits the
 * upgrade endpoint and the stored pin changes, the cache entry must drop or
 * subsequent requests continue seeing the old pin until TTL.
 *
 * This helper exposes `{ resolver, invalidate, invalidateAll }` so the
 * upgrade endpoint can wire invalidation explicitly. Stripe-style
 * `pinOnFirstResolve` is honored and the newly-persisted pin is written to
 * the cache so the next request skips storage entirely.
 *
 * Cache policy:
 *   - In-memory `Map<clientId, { promise, cachedAt }>`.
 *   - TTL-based expiry (default 5min). Stale entries are re-resolved on
 *     access; successful re-resolution replaces the entry.
 *   - Single-flight: concurrent first-misses share one `Promise` so
 *     `resolvePin` is called exactly once.
 *   - Errors bypass the cache (next request retries) — matches the
 *     precedent set by production adopters.
 *
 * When the cache is hit, neither `resolvePin` nor `pinOnFirstResolve`'s
 * `saveVersion` runs — the cached value is returned directly. First-miss
 * after `invalidate(clientId)` behaves like a brand-new client.
 */

import type { Request } from "express";
import { TsadwynStructureError } from "./exceptions.js";

export interface CachedPerClientDefaultVersionOptions {
  /** Extract a stable client identifier from the request. Return null for unknown. */
  identify: (req: Request) => string | null | Promise<string | null>;
  /** Look up the client's stored pin. Return null if none. */
  resolvePin: (clientId: string) => string | null | Promise<string | null>;
  /** Value returned when identity is unknown or no pin is stored. Required. */
  fallback: string;
  /** Stale-pin policy; see `perClientDefaultVersion` for semantics. Default: 'fallback'. */
  onStalePin?: "fallback" | "passthrough" | "reject";
  /** Enables the stale-pin check against the VersionBundle. */
  supportedVersions?: readonly string[];
  /** Persist the client's pin. Required when `pinOnFirstResolve: true`. */
  saveVersion?: (clientId: string, version: string) => void | Promise<void>;
  /**
   * Stripe-style "pin-on-first-call" semantic; see `perClientDefaultVersion`.
   * Triggers when a genuinely-unpinned client hits the resolver. The
   * persisted pin is written to the cache so subsequent requests skip storage.
   */
  pinOnFirstResolve?: boolean;
  /** Optional structured logger for telemetry. */
  logger?: {
    warn: (ctx: Record<string, unknown>, msg: string) => void;
  };
  /**
   * Cache TTL in milliseconds. Default: 5 * 60 * 1000 (5 minutes). A TTL of
   * 0 disables caching (each request re-resolves). Negative values throw.
   */
  ttlMs?: number;
}

export interface CachedPerClientDefaultVersion {
  /** The resolver — pass to `versionPickingMiddleware.apiVersionDefaultValue`. */
  resolver: (req: Request) => Promise<string>;
  /** Drop the cached pin for one client. Call this from your upgrade handler. */
  invalidate: (clientId: string) => void;
  /** Drop every cached pin. Use for rolling deploys / test teardowns. */
  invalidateAll: () => void;
}

interface CacheEntry {
  promise: Promise<string>;
  cachedAt: number;
  // If the underlying resolve rejects, we still let the promise reject —
  // but we bypass caching the rejection so the NEXT access retries fresh.
  // Tracked via a flag so we can drop the entry on rejection.
  settled: "pending" | "fulfilled" | "rejected";
}

export function cachedPerClientDefaultVersion(
  opts: CachedPerClientDefaultVersionOptions,
): CachedPerClientDefaultVersion {
  if (opts.pinOnFirstResolve && typeof opts.saveVersion !== "function") {
    throw new TsadwynStructureError(
      "cachedPerClientDefaultVersion: pinOnFirstResolve requires a saveVersion callback.",
    );
  }

  const ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
  if (ttlMs < 0) {
    throw new TsadwynStructureError(
      `cachedPerClientDefaultVersion: ttlMs must be >= 0 (got ${ttlMs}).`,
    );
  }

  const cache = new Map<string, CacheEntry>();

  async function doResolve(clientId: string): Promise<string> {
    const pin = await Promise.resolve(opts.resolvePin(clientId));
    if (pin === null || pin === undefined) {
      if (opts.pinOnFirstResolve && opts.saveVersion) {
        opts.logger?.warn(
          { clientId, pin: opts.fallback, reason: "pin-on-first-resolve" },
          `Pinning client "${clientId}" to "${opts.fallback}" on first authenticated call.`,
        );
        await Promise.resolve(opts.saveVersion(clientId, opts.fallback));
      } else {
        opts.logger?.warn(
          { clientId, reason: "no-stored-pin" },
          `No stored pin for client "${clientId}"; using fallback.`,
        );
      }
      return opts.fallback;
    }
    if (opts.supportedVersions && !opts.supportedVersions.includes(pin)) {
      const stalePolicy = opts.onStalePin ?? "fallback";
      if (stalePolicy === "reject") {
        throw new TsadwynStructureError(
          `Stored API version pin "${pin}" for client "${clientId}" is not in the current VersionBundle.`,
        );
      }
      if (stalePolicy === "fallback") {
        opts.logger?.warn(
          {
            pin,
            reason: "stale",
            clientId,
            supportedVersions: [...opts.supportedVersions],
          },
          `Stored pin "${pin}" is not in the bundle; using fallback.`,
        );
        return opts.fallback;
      }
      return pin;
    }
    return pin;
  }

  function getOrCreate(clientId: string): Promise<string> {
    const now = Date.now();
    const existing = cache.get(clientId);
    // Cache hit + fresh: return the cached promise directly.
    if (existing) {
      const age = now - existing.cachedAt;
      if (existing.settled !== "rejected" && (ttlMs === 0 ? false : age < ttlMs)) {
        return existing.promise;
      }
      // Stale or rejected — fall through and re-create.
      cache.delete(clientId);
    }
    // Create a new entry, tracking settlement so rejections don't poison
    // the cache for the full TTL.
    const entry: CacheEntry = {
      promise: doResolve(clientId),
      cachedAt: now,
      settled: "pending",
    };
    entry.promise.then(
      () => {
        entry.settled = "fulfilled";
      },
      () => {
        entry.settled = "rejected";
        cache.delete(clientId);
      },
    );
    if (ttlMs > 0) {
      cache.set(clientId, entry);
    }
    return entry.promise;
  }

  async function resolver(req: Request): Promise<string> {
    const clientId = await Promise.resolve(opts.identify(req));
    if (clientId === null || clientId === undefined) {
      opts.logger?.warn(
        { reason: "unauthenticated" },
        "No client identity for default-version resolution; using fallback.",
      );
      return opts.fallback;
    }
    return getOrCreate(clientId);
  }

  return {
    resolver,
    invalidate: (clientId: string) => {
      cache.delete(clientId);
    },
    invalidateAll: () => {
      cache.clear();
    },
  };
}
