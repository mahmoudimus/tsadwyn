/**
 * `currentRequest()` — request-scoped accessor for the raw Express `Request`
 * inside a tsadwyn handler.
 *
 * Tsadwyn handlers receive a stripped view: `{ body, params, query, headers }`.
 * Anything upstream middleware mutates on `req` (auth claims, tenant context,
 * trace IDs) is invisible through that stripped view. This module captures
 * the full `Request` into an `AsyncLocalStorage` immediately before invoking
 * the user's handler, so handlers (and migration callbacks) can recover the
 * raw request via `currentRequest()` without plumbing it through the handler
 * signature or wiring a "mount-last" `captureRequestContext` middleware per
 * route.
 *
 * Capture happens inside the framework dispatch wrapper — consumers never
 * mount anything.
 */

import type { Request } from "express";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Internal ALS instance holding the current request for the duration of a
 * dispatch. Exported for advanced use (tests, instrumentation); most code
 * should call `currentRequest()` or `currentRequestOrNull()` instead.
 */
export const requestContextStorage = new AsyncLocalStorage<Request>();

/**
 * Returns the Express `Request` for the currently-executing tsadwyn handler
 * or migration callback.
 *
 * Throws if called outside a tsadwyn dispatch scope (e.g., during module
 * import, from a background worker, or from a plain Express route that
 * bypassed the tsadwyn router). Use `currentRequestOrNull()` if the absence
 * of a request context is a valid state at the call site.
 */
export function currentRequest(): Request {
  const req = requestContextStorage.getStore();
  if (!req) {
    throw new Error(
      "currentRequest() called outside a tsadwyn handler scope. " +
        "This accessor only works inside handlers, migration callbacks, or code " +
        "awaited by them. For optional access, use currentRequestOrNull().",
    );
  }
  return req;
}

/**
 * Returns the Express `Request` for the currently-executing tsadwyn handler,
 * or `null` when called outside a dispatch scope. Use when absence is a
 * valid state (library-internal helpers, optional instrumentation).
 */
export function currentRequestOrNull(): Request | null {
  return requestContextStorage.getStore() ?? null;
}
