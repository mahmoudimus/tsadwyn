/**
 * `createVersioningRoutes` — pre-wired RESTful `/versioning` resource for
 * self-service API-version reads and upgrades. Every Stripe-style adopter
 * ends up writing the same endpoint; this helper collapses it to one
 * import + callbacks.
 *
 * Shape (default path `/versioning`):
 *
 *   GET  /versioning            → 200 { version, supported[], latest }
 *   POST /versioning {from, to} → 200 { previous_version, current_version }
 *                               | 409 { error: "version_mismatch", expected, actual }
 *                               | 400 { error: "unsupported" | "downgrade-blocked" | "no-change" }
 *                               | 401 unauthenticated
 *                               | 422 malformed request body
 *
 * The `{from, to}` shape gives **optimistic concurrency** — if the stored
 * pin has drifted since the client last read it (e.g., an admin force-pin
 * upgraded them), the server rejects with 409 rather than silently
 * overwriting.
 *
 * First-upgrade convention: clients who have never explicitly pinned a
 * version read `GET /versioning` → `{version: null, ...}`. Their first
 * upgrade passes `from: null` to install the initial pin.
 */

import type { Request } from "express";
import { z } from "zod";

import { VersionedRouter } from "./router.js";
import { HttpError } from "./exceptions.js";
import { named } from "./zod-extend.js";
import {
  validateVersionUpgrade,
  type CompareFn,
} from "./version-upgrade.js";

export interface CreateVersioningRoutesOptions {
  /** Default: '/versioning'. */
  path?: string;
  /** Extract a stable client / account identifier. Return null if unauthenticated. */
  identify: (req: Request) => string | null | Promise<string | null>;
  /** Load the stored pinned version for a client. Return null if none. */
  loadVersion: (clientId: string) => string | null | Promise<string | null>;
  /** Persist the new pin. */
  saveVersion: (clientId: string, version: string) => void | Promise<void>;
  /** Versions the upgrade handler will accept as `to`. Typically `bundle.versionValues`. */
  supportedVersions: readonly string[];
  /** Default false — downgrades are rejected with 400 downgrade-blocked. */
  allowDowngrade?: boolean;
  /** Default false — same-version target is rejected with 400 no-change. */
  allowNoChange?: boolean;
  /** Version comparison strategy. Default 'iso-date'. */
  compare?: "iso-date" | "semver" | CompareFn;
}

const VersioningState = named(
  z.object({
    version: z.string().nullable(),
    supported: z.array(z.string()),
    latest: z.string(),
  }),
  "VersioningState",
);

const UpgradeRequest = named(
  z.object({
    from: z.string().nullable(),
    to: z.string(),
  }),
  "UpgradeRequest",
);

const UpgradeResponse = named(
  z.object({
    previous_version: z.string().nullable(),
    current_version: z.string(),
  }),
  "UpgradeResponse",
);

export function createVersioningRoutes(
  opts: CreateVersioningRoutesOptions,
): VersionedRouter {
  const path = opts.path ?? "/versioning";
  const router = new VersionedRouter();

  // ── GET /versioning ────────────────────────────────────────────────────
  // Returns the authenticated client's current pin + the full supported set.
  router.get(path, null, VersioningState, async (req: any) => {
    const clientId = await Promise.resolve(opts.identify(req));
    if (!clientId) {
      throw new HttpError(401, { error: "unauthorized" });
    }
    const current = await Promise.resolve(opts.loadVersion(clientId));
    return {
      version: current,
      supported: [...opts.supportedVersions],
      // supportedVersions is newest-first per tsadwyn convention, so [0] is head.
      latest: opts.supportedVersions[0],
    };
  });

  // ── POST /versioning ───────────────────────────────────────────────────
  // Optimistic-concurrency-aware upgrade. `from` must match the stored pin,
  // or the server 409s and the client must re-read + retry.
  router.post(path, UpgradeRequest, UpgradeResponse, async (req: any) => {
    const clientId = await Promise.resolve(opts.identify(req));
    if (!clientId) {
      throw new HttpError(401, { error: "unauthorized" });
    }

    const { from, to } = req.body as { from: string | null; to: string };
    const current = await Promise.resolve(opts.loadVersion(clientId));

    if (from !== current) {
      throw new HttpError(409, {
        error: "version_mismatch",
        expected: from,
        actual: current,
      });
    }

    // First-upgrade flow: client has never pinned (from === current === null).
    // Install the initial pin, subject only to the supported-list check.
    if (from === null) {
      if (!opts.supportedVersions.includes(to)) {
        throw new HttpError(400, {
          error: "unsupported",
          detail: `Target version "${to}" is not in the supported list.`,
        });
      }
      await Promise.resolve(opts.saveVersion(clientId, to));
      return { previous_version: null, current_version: to };
    }

    // Standard upgrade: both `from` and `to` are concrete versions.
    const decision = validateVersionUpgrade({
      current: from,
      target: to,
      supported: opts.supportedVersions,
      allowDowngrade: opts.allowDowngrade,
      allowNoChange: opts.allowNoChange,
      compare: opts.compare,
    });

    if (!decision.ok) {
      throw new HttpError(400, {
        error: decision.reason,
        detail: decision.detail,
      });
    }

    await Promise.resolve(opts.saveVersion(clientId, decision.next));
    return {
      previous_version: decision.previous,
      current_version: decision.next,
    };
  });

  return router;
}
