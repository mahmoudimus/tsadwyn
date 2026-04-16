/**
 * FAILING TEST — verifies the gap described in tsadwyn-issues-additional-gaps.md §2
 *
 * `convertResponseToPreviousVersionFor` only fires for in-flight HTTP
 * responses. Outbound webhooks dispatched from background jobs hand-build
 * payloads that bypass the migration pipeline entirely — a client pinned to
 * an older API version receives head-shaped webhook bodies.
 *
 * The proposal is a standalone helper:
 *
 *   migratePayloadToVersion(schemaName, payload, targetVersion, versionBundle)
 *
 * that walks the same response migrations registered against `schemaName`
 * and returns the payload reshaped for `targetVersion`.
 *
 * NOTE: VersionChange subclasses are bound to one VersionBundle for life
 * (T-1602). Each `it()` declares its own classes so the bundles are
 * independent.
 *
 * Run: npx vitest run tests/issue-migrate-payload-to-version.test.ts
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";

import {
  Version,
  VersionBundle,
  VersionChange,
  ResponseInfo,
  convertResponseToPreviousVersionFor,
} from "../src/index.js";

// GAP: migratePayloadToVersion is not exported. The import is intentionally
// expected to fail at module-load until the helper ships.
// @ts-expect-error — intentional: drives the failing-import signal
import { migratePayloadToVersion } from "../src/index.js";

const VirtualAccount = z
  .object({
    id: z.string(),
    status: z.enum(["pending", "ok", "declined", "failed"]),
  })
  .named("IssueWebhook_VirtualAccount");

describe("Issue: migratePayloadToVersion for outbound webhooks", () => {
  it("applies the response migration to take a head payload back to a legacy version", () => {
    class RenameDeclinedToFailed_a extends VersionChange {
      description =
        "Initial webhook payload used status: 'failed'; head renamed to 'declined'";
      instructions = [];

      r1 = convertResponseToPreviousVersionFor(VirtualAccount)(
        (res: ResponseInfo) => {
          if (res.body?.status === "declined") {
            res.body.status = "failed";
          }
        },
      );
    }

    const versions = new VersionBundle(
      new Version("2025-01-01", RenameDeclinedToFailed_a),
      new Version("2024-01-01"),
    );

    const headPayload = { id: "va_123", status: "declined" as const };

    const legacyPayload = migratePayloadToVersion(
      "IssueWebhook_VirtualAccount",
      headPayload,
      "2024-01-01",
      versions,
    );

    expect(legacyPayload).toEqual({ id: "va_123", status: "failed" });
  });

  it("returns the payload unchanged when target == head", () => {
    class RenameDeclinedToFailed_b extends VersionChange {
      description = "rename declined to failed";
      instructions = [];

      r1 = convertResponseToPreviousVersionFor(VirtualAccount)(
        (res: ResponseInfo) => {
          if (res.body?.status === "declined") {
            res.body.status = "failed";
          }
        },
      );
    }

    const versions = new VersionBundle(
      new Version("2025-01-01", RenameDeclinedToFailed_b),
      new Version("2024-01-01"),
    );

    const headPayload = { id: "va_123", status: "declined" as const };

    const result = migratePayloadToVersion(
      "IssueWebhook_VirtualAccount",
      headPayload,
      "2025-01-01",
      versions,
    );

    expect(result).toEqual(headPayload);
  });

  it("does not mutate the input payload", () => {
    class RenameDeclinedToFailed_c extends VersionChange {
      description = "rename declined to failed";
      instructions = [];

      r1 = convertResponseToPreviousVersionFor(VirtualAccount)(
        (res: ResponseInfo) => {
          if (res.body?.status === "declined") {
            res.body.status = "failed";
          }
        },
      );
    }

    const versions = new VersionBundle(
      new Version("2025-01-01", RenameDeclinedToFailed_c),
      new Version("2024-01-01"),
    );

    const headPayload = { id: "va_123", status: "declined" as const };
    const headPayloadSnapshot = { ...headPayload };

    migratePayloadToVersion(
      "IssueWebhook_VirtualAccount",
      headPayload,
      "2024-01-01",
      versions,
    );

    expect(headPayload).toEqual(headPayloadSnapshot);
  });

  it("walks multiple intermediate version changes", () => {
    class RenameDeclinedToFailed_d extends VersionChange {
      description = "rename declined to failed";
      instructions = [];

      r1 = convertResponseToPreviousVersionFor(VirtualAccount)(
        (res: ResponseInfo) => {
          if (res.body?.status === "declined") {
            res.body.status = "failed";
          }
        },
      );
    }

    class AddNestedMeta_d extends VersionChange {
      description = "Earlier shape had a nested meta object";
      instructions = [];

      r1 = convertResponseToPreviousVersionFor(VirtualAccount)(
        (res: ResponseInfo) => {
          res.body.meta = { id: res.body.id };
          delete res.body.id;
        },
      );
    }

    const versions = new VersionBundle(
      new Version("2026-01-01", RenameDeclinedToFailed_d),
      new Version("2025-01-01", AddNestedMeta_d),
      new Version("2024-01-01"),
    );

    const headPayload = { id: "va_123", status: "declined" as const };
    const legacyPayload = migratePayloadToVersion(
      "IssueWebhook_VirtualAccount",
      headPayload,
      "2024-01-01",
      versions,
    );

    // Both migrations applied: rename, then nest
    expect(legacyPayload).toEqual({
      meta: { id: "va_123" },
      status: "failed",
    });
  });

  it("throws or returns clearly when targetVersion is not in the bundle", () => {
    class RenameDeclinedToFailed_e extends VersionChange {
      description = "rename declined to failed";
      instructions = [];

      r1 = convertResponseToPreviousVersionFor(VirtualAccount)(
        (res: ResponseInfo) => {
          if (res.body?.status === "declined") {
            res.body.status = "failed";
          }
        },
      );
    }

    const versions = new VersionBundle(
      new Version("2025-01-01", RenameDeclinedToFailed_e),
      new Version("2024-01-01"),
    );

    expect(() =>
      migratePayloadToVersion(
        "IssueWebhook_VirtualAccount",
        { id: "x", status: "declined" as const },
        "1999-01-01",
        versions,
      ),
    ).toThrow();
  });
});
