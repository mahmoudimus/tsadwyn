/**
 * T-2400: Schemas referenced in alter_schema_instructions but not directly
 * on any route should still be discovered and versioned.
 *
 * Real-world example: An Address schema is embedded inside a UserResource
 * (as a nested field), but only UserResource is the route's response schema.
 * If a version change alters Address fields, the Address schema must still
 * be registered and versioned even though it's not directly on a route.
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
  schema,
  convertResponseToPreviousVersionFor,
  ResponseInfo,
} from "../src/index.js";

// -- Schemas --

// Address is a nested schema — never directly on a route
const Address = z.object({
  street: z.string(),
  city: z.string(),
  zip_code: z.string(),
}).named("Address");

// User embeds Address as a nested field
const UserResource = z.object({
  id: z.string(),
  name: z.string(),
  address: Address,
}).named("UserResource");

const UserCreate = z.object({
  name: z.string(),
  address: Address,
}).named("UserCreate");

describe("T-2400: schema discovery from instructions", () => {
  it("versions a nested schema referenced only in instructions, not on a route", () => {
    // Address.zip_code was called "postal_code" in the older version
    class RenameZipCode extends VersionChange {
      description = "Renamed Address.postal_code to zip_code";
      instructions = [
        schema(Address).field("zip_code").had({ name: "postal_code" }),
      ];

      r1 = convertResponseToPreviousVersionFor(UserResource)(
        (response: ResponseInfo) => {
          if (response.body.address) {
            response.body.address.postal_code = response.body.address.zip_code;
            delete response.body.address.zip_code;
          }
        },
      );
    }

    const router = new VersionedRouter();
    router.post("/users", UserCreate, UserResource, async (req) => {
      return {
        id: "usr_1",
        name: req.body.name,
        address: req.body.address,
      };
    });
    router.get("/users/:id", null, UserResource, async () => {
      return {
        id: "usr_1",
        name: "Alice",
        address: { street: "123 Main St", city: "Springfield", zip_code: "62704" },
      };
    });

    // This should NOT throw — Address should be discovered from the instruction
    const app = new Cadwyn({
      versions: new VersionBundle(
        new Version("2024-06-01", RenameZipCode),
        new Version("2024-01-01"),
      ),
      apiVersionHeaderName: "x-api-version",
    });
    app.generateAndIncludeVersionedRouters(router);

    // Verify it works end-to-end
    return (async () => {
      // v2 (latest): has zip_code
      const r2 = await request(app.expressApp)
        .get("/users/usr_1")
        .set("x-api-version", "2024-06-01");
      expect(r2.status).toBe(200);
      expect(r2.body.address.zip_code).toBe("62704");
      expect(r2.body.address.postal_code).toBeUndefined();

      // v1 (older): has postal_code (migrated)
      const r1 = await request(app.expressApp)
        .get("/users/usr_1")
        .set("x-api-version", "2024-01-01");
      expect(r1.status).toBe(200);
      expect(r1.body.address.postal_code).toBe("62704");
      expect(r1.body.address.zip_code).toBeUndefined();
    })();
  });

  it("versions a schema used only in instructions (no route reference at all)", () => {
    // Metadata schema is never on a route, but has version changes
    const Metadata = z.object({
      version: z.number(),
      tags: z.array(z.string()),
    }).named("Metadata");

    class AddTags extends VersionChange {
      description = "Added tags to metadata";
      instructions = [
        schema(Metadata).field("tags").didntExist,
      ];
    }

    const router = new VersionedRouter();
    router.get("/health", null, null, async () => ({ status: "ok" }));

    // Should NOT throw InvalidGenerationInstructionError
    const app = new Cadwyn({
      versions: new VersionBundle(
        new Version("2024-06-01", AddTags),
        new Version("2024-01-01"),
      ),
      apiVersionHeaderName: "x-api-version",
    });
    app.generateAndIncludeVersionedRouters(router);
  });
});
