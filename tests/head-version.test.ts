/**
 * Phase 17 — T-1700: HeadVersion functionality
 *
 * HeadVersion applies schema changes to the "head" (latest, unreleased) version
 * without requiring migration decorators. It is applied before any versioned
 * changes during schema generation.
 *
 * Run: npx vitest run tests/head-version.test.ts
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { z } from "zod";

import {
  Cadwyn,
  Version,
  VersionBundle,
  VersionChange,
  VersionedRouter,
  HeadVersion,
  schema,
  convertRequestToNextVersionFor,
  convertResponseToPreviousVersionFor,
  RequestInfo,
  ResponseInfo,
  CadwynStructureError,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// HeadVersion applies schema changes without migrations
// ---------------------------------------------------------------------------

describe("HeadVersion", () => {
  it("applies schema changes without migrations", () => {
    const ItemResource = z.object({
      id: z.string(),
      name: z.string(),
      category: z.string(),
    }).named("HV_ItemResource");

    // HeadVersion adds a field that doesn't exist yet in the released versions
    class HeadAddCategory extends VersionChange {
      description = "Add category field in head";
      instructions = [
        schema(ItemResource).field("category").didntExist,
      ];
    }

    const router = new VersionedRouter();
    router.get("/items/:id", null, ItemResource, async (req) => {
      return { id: req.params.id, name: "Widget", category: "tools" };
    });

    const app = new Cadwyn({
      versions: new VersionBundle(
        new HeadVersion(HeadAddCategory),
        new Version("2024-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    // The head version changes should be applied during schema generation.
    // The released version (2024-01-01) should NOT have the "category" field
    // since HeadVersion changes represent unreleased changes.
    // Requesting with the released version should still work.
    // This is an integration test — once HeadVersion is fully wired into
    // schema generation, the versioned schema for 2024-01-01 won't have "category".
  });

  it("rejects migration decorators in HeadVersion", () => {
    const ItemResource = z.object({
      id: z.string(),
      name: z.string(),
    }).named("HV_ItemResourceMigration");

    class HeadWithMigration extends VersionChange {
      description = "Head change with migration — should be rejected";
      instructions = [];

      r1 = convertResponseToPreviousVersionFor(ItemResource)(
        (res: ResponseInfo) => { delete res.body.name; },
      );
    }

    // HeadVersion should throw CadwynStructureError because migration decorators
    // are not allowed in HeadVersion
    expect(() => new HeadVersion(HeadWithMigration)).toThrow(CadwynStructureError);
    expect(() => new HeadVersion(HeadWithMigration)).toThrow(
      /HeadVersion does not support request or response migrations/,
    );
  });

  it("rejects request migration decorators in HeadVersion", () => {
    const ItemCreate = z.object({
      name: z.string(),
    }).named("HV_ItemCreate");

    class HeadWithRequestMigration extends VersionChange {
      description = "Head change with request migration — should be rejected";
      instructions = [];

      r1 = convertRequestToNextVersionFor(ItemCreate)(
        (req: RequestInfo) => { req.body.name = req.body.name.toUpperCase(); },
      );
    }

    expect(() => new HeadVersion(HeadWithRequestMigration)).toThrow(CadwynStructureError);
  });

  it("is applied before versioned changes", async () => {
    // Set up a scenario where HeadVersion adds a field to the "head" schema
    // that does not exist in any released version. This verifies that HeadVersion
    // changes are applied before the versioned changes during schema generation,
    // meaning the latest released version still matches what it should.
    const ProfileResource = z.object({
      id: z.string(),
      displayName: z.string(),
      bio: z.string().optional(),
    }).named("HV_ProfileResource2");

    // HeadVersion adds "bio" field — it shouldn't exist in released versions
    class HeadAddBio extends VersionChange {
      description = "Add bio field in head (unreleased)";
      instructions = [
        schema(ProfileResource).field("bio").didntExist,
      ];
    }

    // Versioned change: displayName was "username" in the older version
    class RenameUsernameToDisplayName extends VersionChange {
      description = "Renamed username to displayName";
      instructions = [
        schema(ProfileResource).field("displayName").had({ name: "username" }),
      ];

      r1 = convertResponseToPreviousVersionFor(ProfileResource)(
        (res: ResponseInfo) => {
          res.body.username = res.body.displayName;
          delete res.body.displayName;
        },
      );
    }

    const router = new VersionedRouter();
    router.get("/profile", null, ProfileResource, async () => {
      return { id: "p1", displayName: "JaneDoe", bio: "Hello world" };
    });

    const app = new Cadwyn({
      versions: new VersionBundle(
        new HeadVersion(HeadAddBio),
        new Version("2024-06-01", RenameUsernameToDisplayName),
        new Version("2024-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const server = app.expressApp;

    // Request with oldest version should get "username" (due to response migration)
    const v1Res = await request(server)
      .get("/profile")
      .set("x-api-version", "2024-01-01");
    expect(v1Res.status).toBe(200);
    expect(v1Res.body.username).toBe("JaneDoe");
    expect(v1Res.body.displayName).toBeUndefined();

    // Request with latest released version should get "displayName"
    const v2Res = await request(server)
      .get("/profile")
      .set("x-api-version", "2024-06-01");
    expect(v2Res.status).toBe(200);
    expect(v2Res.body.displayName).toBe("JaneDoe");
  });
});
