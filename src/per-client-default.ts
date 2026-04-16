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
}

/**
 * Build an `apiVersionDefaultValue`-compatible resolver.
 */
export function perClientDefaultVersion(
  opts: PerClientDefaultVersionOptions,
): (req: Request) => Promise<string> {
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
      opts.logger?.warn(
        { clientId, reason: "no-stored-pin" },
        `No stored pin for client "${clientId}"; using fallback.`,
      );
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
