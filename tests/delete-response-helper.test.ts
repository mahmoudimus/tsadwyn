/**
 * Tests for `deletedResponseSchema` — the Stripe-style DELETE response
 * helper. Verifies that:
 *   (1) the schema validates the Stripe-shape body
 *   (2) a real route using it actually delivers the body to the client
 *       at status 200 (unlike 204, which strips the body at the wire)
 *   (3) version migrations on the delete-envelope run end-to-end
 *
 * Motivated by empirical verification against api.stripe.com:
 *   DELETE /v1/customers/{id} → HTTP/2 200 + {id, object, deleted}
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { z } from "zod";

import {
  Tsadwyn,
  Version,
  VersionBundle,
  VersionChange,
  VersionedRouter,
  ResponseInfo,
  convertResponseToPreviousVersionFor,
  deletedResponseSchema,
} from "../src/index.js";

describe("deletedResponseSchema — Stripe-style DELETE helper", () => {
  it("produces a schema that validates the { id, object, deleted } shape", () => {
    const DeletedCustomer = deletedResponseSchema("customer").named(
      "DeletedCustomerShape",
    );

    const ok = DeletedCustomer.safeParse({
      id: "cus_NffrFeUfNV2Hib",
      object: "customer",
      deleted: true,
    });
    expect(ok.success).toBe(true);

    // object literal must match
    const wrongObject = DeletedCustomer.safeParse({
      id: "cus_x",
      object: "subscription",
      deleted: true,
    });
    expect(wrongObject.success).toBe(false);

    // deleted must be literally true
    const wrongDeleted = DeletedCustomer.safeParse({
      id: "cus_x",
      object: "customer",
      deleted: false,
    });
    expect(wrongDeleted.success).toBe(false);
  });

  it("accepts extra fields for richer audit envelopes", () => {
    const DeletedCustomerWithAudit = deletedResponseSchema("customer", {
      deleted_at: z.string(),
      deleted_by: z.string(),
    }).named("DeletedCustomerWithAudit");

    const ok = DeletedCustomerWithAudit.safeParse({
      id: "cus_x",
      object: "customer",
      deleted: true,
      deleted_at: "2026-04-16T12:00:00Z",
      deleted_by: "admin:42",
    });
    expect(ok.success).toBe(true);
  });

  it("end-to-end: route using deletedResponseSchema delivers 200 + body to the client", async () => {
    const DeletedCustomer = deletedResponseSchema("customer").named(
      "DeletedCustomer_E2E",
    );

    const router = new VersionedRouter();
    router.delete("/customers/:id", null, DeletedCustomer, async (req: any) => ({
      id: req.params.id,
      object: "customer" as const,
      deleted: true as const,
    }));

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .delete("/customers/cus_NffrFeUfNV2Hib")
      .set("x-api-version", "2024-01-01");

    // Stripe's exact wire-level behavior: 200 + JSON body
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: "cus_NffrFeUfNV2Hib",
      object: "customer",
      deleted: true,
    });
  });

  it("version migration: head emits rich envelope; legacy clients get the original flat shape", async () => {
    // Stripe itself evolves delete envelopes by adding audit fields (deleted_at
    // etc.). This test demonstrates the flow end-to-end with the helper.
    const DeletedCustomer = deletedResponseSchema("customer", {
      deleted_at: z.string().optional(),
      deleted_by: z.string().optional(),
    }).named("DeletedCustomer_V2");

    class DropAuditFieldsForLegacy extends VersionChange {
      description =
        "v2 adds deleted_at + deleted_by; v1 clients see the original flat shape";
      instructions = [];

      r1 = convertResponseToPreviousVersionFor(DeletedCustomer)(
        (res: ResponseInfo) => {
          if (res.body && typeof res.body === "object") {
            delete res.body.deleted_at;
            delete res.body.deleted_by;
          }
        },
      );
    }

    const router = new VersionedRouter();
    router.delete("/customers/:id", null, DeletedCustomer, async (req: any) => ({
      id: req.params.id,
      object: "customer" as const,
      deleted: true as const,
      deleted_at: "2026-04-16T12:00:00Z",
      deleted_by: "admin:42",
    }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-01-01", DropAuditFieldsForLegacy),
        new Version("2024-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    // Head client — full audit envelope
    const headRes = await request(app.expressApp)
      .delete("/customers/cus_x")
      .set("x-api-version", "2025-01-01");
    expect(headRes.status).toBe(200);
    expect(headRes.body).toEqual({
      id: "cus_x",
      object: "customer",
      deleted: true,
      deleted_at: "2026-04-16T12:00:00Z",
      deleted_by: "admin:42",
    });

    // Legacy client — flat Stripe shape, audit fields stripped by migration
    const legacyRes = await request(app.expressApp)
      .delete("/customers/cus_x")
      .set("x-api-version", "2024-01-01");
    expect(legacyRes.status).toBe(200);
    expect(legacyRes.body).toEqual({
      id: "cus_x",
      object: "customer",
      deleted: true,
    });
  });
});
