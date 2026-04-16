/**
 * `perClientDefaultVersion` — canonical per-client default-version resolver
 * suitable for the `apiVersionDefaultValue` option on `Tsadwyn`.
 *
 * Every Stripe-style adopter writes the same identify→resolvePin→fallback
 * chain (usually against a DB row keyed by authenticated client id). This
 * helper standardizes the pattern, adds a per-request WeakMap cache, and
 * codifies the "what if the stored pin is no longer in the bundle?" policy.
 */

import type { Request } from "express";
import { TsadwynStructureError } from "./exceptions.js";

export interface PerClientDefaultVersionOptions {
  /** Extract a stable client identifier from the request. Return null for unknown. */
  identify: (req: Request) => string | null | Promise<string | null>;
  /** Look up the client's stored pin. Return null if none. */
  resolvePin: (clientId: string) => string | null | Promise<string | null>;
  /** Value returned when identity is unknown or no pin is stored. Required. */
  fallback: string;
  /**
   * Policy when the resolved pin is not in `supportedVersions`. Default: 'fallback'.
   * - 'fallback'    — substitute `fallback` and emit warn (if logger supplied).
   * - 'passthrough' — return the stale pin as-is (the downstream picker will
   *                   treat it as unknown per its own onUnsupportedVersion).
   * - 'reject'      — throw TsadwynStructureError.
   */
  onStalePin?: "fallback" | "passthrough" | "reject";
  /** Per-request caching. Default: 'per-request'. */
  cache?: "per-request" | "none";
  /** Optional structured logger for telemetry. */
  logger?: {
    warn: (ctx: Record<string, unknown>, msg: string) => void;
  };
  /** Enables the stale-pin check. When omitted, the check is skipped. */
  supportedVersions?: readonly string[];
  /**
   * Persist the client's pin. Required when `pinOnFirstResolve: true`.
   * Called with (clientId, version) — tsadwyn doesn't know your storage.
   */
  saveVersion?: (clientId: string, version: string) => void | Promise<void>;
  /**
   * Stripe-style "pin-on-first-call" semantic: when an authenticated
   * client has no stored pin, save `fallback` as their pin (via
   * `saveVersion`) BEFORE returning it. Subsequent calls read the
   * stored pin and behave identically to any other pinned client.
   *
   * Requires `saveVersion` to be supplied. Default: false.
   *
   * Does NOT overwrite existing stored pins (including stale ones —
   * those flow through the `onStalePin` policy instead).
   */
  pinOnFirstResolve?: boolean;
}

/**
 * Build an `apiVersionDefaultValue`-compatible resolver.
 */
export function perClientDefaultVersion(
  opts: PerClientDefaultVersionOptions,
): (req: Request) => Promise<string> {
  if (opts.pinOnFirstResolve && typeof opts.saveVersion !== "function") {
    throw new TsadwynStructureError(
      "perClientDefaultVersion: pinOnFirstResolve requires a saveVersion callback " +
        "to persist the pin on the client's first authenticated call.",
    );
  }

  const cacheEnabled = opts.cache !== "none";
  const cache = new WeakMap<Request, Promise<string>>();

  async function doResolve(req: Request): Promise<string> {
    const clientId = await Promise.resolve(opts.identify(req));
    if (clientId === null || clientId === undefined) {
      opts.logger?.warn(
        { reason: "unauthenticated" },
        "No client identity for default-version resolution; using fallback.",
      );
      return opts.fallback;
    }
    const pin = await Promise.resolve(opts.resolvePin(clientId));
    if (pin === null || pin === undefined) {
      // Stripe-style pin-on-first-call: persist the fallback as the
      // client's pin so subsequent calls find it in storage. Only
      // triggers on genuinely unpinned clients (stored = null) —
      // stale stored pins are handled via onStalePin below.
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
      // passthrough
      return pin;
    }
    return pin;
  }

  return function resolver(req: Request): Promise<string> {
    if (cacheEnabled) {
      const cached = cache.get(req);
      if (cached) return cached;
      const promise = doResolve(req);
      cache.set(req, promise);
      return promise;
    }
    return doResolve(req);
  };
}
