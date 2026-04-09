/**
 * Phase 17 — T-1701: Standalone response migration
 *
 * Tests the `migrateResponseBody` utility function that converts a response body
 * from the latest version's shape to a target version's shape, outside of any
 * HTTP request context. Useful for webhooks, background jobs, and event streams.
 *
 * Run: npx vitest run tests/migrate-standalone.test.ts
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";

import {
  Version,
  VersionBundle,
  VersionChange,
  convertResponseToPreviousVersionFor,
  ResponseInfo,
  migrateResponseBody,
  CadwynError,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Setup: schemas and version changes
// ---------------------------------------------------------------------------

const EventResource = z.object({
  id: z.string(),
  type: z.string(),
  payload: z.record(z.unknown()),
  createdAt: z.string(),
}).named("StandaloneEventResource");

// v2024-06-01 -> v2024-11-01: payload was called "data" in older versions
class RenamePayload extends VersionChange {
  description = "Renamed data to payload";
  instructions = [];

  r1 = convertResponseToPreviousVersionFor(EventResource)(
    (res: ResponseInfo) => {
      res.body.data = res.body.payload;
      delete res.body.payload;
    },
  );
}

// v2024-01-01 -> v2024-06-01: createdAt was called "timestamp" in oldest version
class RenameCreatedAt extends VersionChange {
  description = "Renamed timestamp to createdAt";
  instructions = [];

  r1 = convertResponseToPreviousVersionFor(EventResource)(
    (res: ResponseInfo) => {
      res.body.timestamp = res.body.createdAt;
      delete res.body.createdAt;
    },
  );
}

const V1 = "2024-01-01";
const V2 = "2024-06-01";
const V3 = "2024-11-01";

const versions = new VersionBundle(
  new Version(V3, RenamePayload),
  new Version(V2, RenameCreatedAt),
  new Version(V1),
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("migrateResponseBody", () => {
  const latestBody = {
    id: "evt_123",
    type: "payment.created",
    payload: { amount: 5000, currency: "usd" },
    createdAt: "2024-11-01T00:00:00Z",
  };

  it("migrates a response body to the oldest version", () => {
    const result = migrateResponseBody(
      latestBody,
      "StandaloneEventResource",
      V1,
      versions,
    );

    // V3 -> V2 migration: payload -> data
    // V2 -> V1 migration: createdAt -> timestamp
    expect(result.data).toEqual({ amount: 5000, currency: "usd" });
    expect(result.payload).toBeUndefined();
    expect(result.timestamp).toBe("2024-11-01T00:00:00Z");
    expect(result.createdAt).toBeUndefined();
    expect(result.id).toBe("evt_123");
    expect(result.type).toBe("payment.created");
  });

  it("migrates a response body to the middle version", () => {
    const result = migrateResponseBody(
      latestBody,
      "StandaloneEventResource",
      V2,
      versions,
    );

    // Only V3 -> V2 migration: payload -> data
    expect(result.data).toEqual({ amount: 5000, currency: "usd" });
    expect(result.payload).toBeUndefined();
    // createdAt should NOT be renamed (that migration is V2 -> V1)
    expect(result.createdAt).toBe("2024-11-01T00:00:00Z");
    expect(result.timestamp).toBeUndefined();
  });

  it("returns body unchanged for latest version", () => {
    const result = migrateResponseBody(
      latestBody,
      "StandaloneEventResource",
      V3,
      versions,
    );

    // No migrations should be applied for the latest version
    expect(result).toEqual(latestBody);
  });

  it("does not mutate the original body", () => {
    const original = {
      id: "evt_456",
      type: "payment.updated",
      payload: { amount: 9999 },
      createdAt: "2024-06-15T12:00:00Z",
    };
    const originalCopy = JSON.parse(JSON.stringify(original));

    migrateResponseBody(original, "StandaloneEventResource", V1, versions);

    // Original should not be mutated
    expect(original).toEqual(originalCopy);
  });

  it("throws CadwynError for unknown version", () => {
    expect(() =>
      migrateResponseBody(
        latestBody,
        "StandaloneEventResource",
        "9999-12-31",
        versions,
      ),
    ).toThrow(CadwynError);
    expect(() =>
      migrateResponseBody(
        latestBody,
        "StandaloneEventResource",
        "9999-12-31",
        versions,
      ),
    ).toThrow(/not found/);
  });

  it("returns body unchanged when schema has no migrations", () => {
    const body = { id: "evt_789", type: "test", payload: {}, createdAt: "now" };
    const result = migrateResponseBody(
      body,
      "NonExistentSchema",
      V1,
      versions,
    );

    // No migrations match "NonExistentSchema", so body passes through unchanged
    expect(result).toEqual(body);
  });
});
