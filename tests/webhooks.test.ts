/**
 * Tests for webhook versioning — webhooks are documentation-only routes
 * that go through the same versioning pipeline but appear in OpenAPI's
 * `webhooks` section instead of being served as HTTP endpoints.
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
  endpoint,
  RequestInfo,
  ResponseInfo,
} from "../src/index.js";

// -- Schemas (latest version) --

const SubscriptionPayload = z.object({
  id: z.string(),
  customer_id: z.string(),
  plan: z.string(),
  monthly_fee: z.number(),
}).named("SubscriptionPayload");

const InvoicePayload = z.object({
  id: z.string(),
  customer_id: z.string(),
  amount: z.number(),
  currency: z.string(),
  status: z.enum(["draft", "open", "paid", "void"]),
}).named("InvoicePayload");

// -- Version changes --

// v2024-06-01 → v2024-11-01: monthly_fee was added to subscriptions
class AddMonthlyFee extends VersionChange {
  description = "Added monthly_fee to subscription webhook payload";
  instructions = [
    schema(SubscriptionPayload).field("monthly_fee").didntExist,
  ];
}

// v2024-01-15 → v2024-06-01: invoice webhook was added, subscription had "plan_id" not "plan"
class AddInvoiceRenamePlan extends VersionChange {
  description = "Added invoice webhook, renamed subscription plan_id to plan";
  instructions = [
    schema(SubscriptionPayload).field("plan").had({ name: "plan_id" }),
    endpoint("new-invoice", ["POST"]).didntExist,
  ];
}

function createApp() {
  const router = new VersionedRouter({ prefix: "/v1" });

  // A normal endpoint (not a webhook)
  router.get("/subscriptions", null, null, async () => {
    return { object: "list", data: [] };
  });

  const app = new Cadwyn({
    versions: new VersionBundle(
      new Version("2024-11-01", AddMonthlyFee),
      new Version("2024-06-01", AddInvoiceRenamePlan),
      new Version("2024-01-15"),
    ),
    title: "Webhook Test API",
    apiVersionHeaderName: "x-api-version",
  });

  // Define webhooks (documentation-only)
  app.webhooks.post("new-subscription", SubscriptionPayload, null, async () => {});
  app.webhooks.post("new-invoice", InvoicePayload, null, async () => {});

  app.generateAndIncludeVersionedRouters(router);
  return app;
}

describe("webhook versioning", () => {
  const app = createApp();

  it("webhooks are NOT served as HTTP endpoints", async () => {
    const res = await request(app.expressApp)
      .post("/new-subscription")
      .set("x-api-version", "2024-11-01")
      .send({ id: "sub_1", customer_id: "cus_1", plan: "pro", monthly_fee: 99 });

    expect(res.status).toBe(404);
  });

  it("v3 (latest): OpenAPI includes both webhooks with all fields", async () => {
    const doc = app.openapi("2024-11-01");

    expect(doc.webhooks).toBeDefined();
    expect(doc.webhooks!["new-subscription"]).toBeDefined();
    expect(doc.webhooks!["new-invoice"]).toBeDefined();

    // The subscription webhook should reference SubscriptionPayload
    const subOp = doc.webhooks!["new-subscription"].post;
    expect(subOp).toBeDefined();
    expect(subOp.requestBody).toBeDefined();
  });

  it("v2 (middle): OpenAPI has subscription webhook WITHOUT monthly_fee, invoice exists", async () => {
    const doc = app.openapi("2024-06-01");

    expect(doc.webhooks).toBeDefined();
    expect(doc.webhooks!["new-subscription"]).toBeDefined();
    expect(doc.webhooks!["new-invoice"]).toBeDefined();

    // Check the versioned schema for subscription — should NOT have monthly_fee
    const schemas = doc.components?.schemas;
    if (schemas?.SubscriptionPayload) {
      const props = schemas.SubscriptionPayload.properties;
      expect(props?.monthly_fee).toBeUndefined();
      expect(props?.plan).toBeDefined();
    }
  });

  it("v1 (oldest): OpenAPI has subscription webhook with plan_id (not plan), NO invoice webhook", async () => {
    const doc = app.openapi("2024-01-15");

    expect(doc.webhooks).toBeDefined();
    expect(doc.webhooks!["new-subscription"]).toBeDefined();
    // invoice webhook didn't exist in v1
    expect(doc.webhooks!["new-invoice"]).toBeUndefined();

    // Check the versioned schema — should have plan_id, not plan
    const schemas = doc.components?.schemas;
    if (schemas?.SubscriptionPayload) {
      const props = schemas.SubscriptionPayload.properties;
      expect(props?.plan_id).toBeDefined();
      expect(props?.plan).toBeUndefined();
      expect(props?.monthly_fee).toBeUndefined();
    }
  });

  it("regular endpoints still work alongside webhooks", async () => {
    const res = await request(app.expressApp)
      .get("/v1/subscriptions")
      .set("x-api-version", "2024-11-01");

    expect(res.status).toBe(200);
    expect(res.body.object).toBe("list");
  });

  it("OpenAPI paths section does NOT include webhooks", async () => {
    const doc = app.openapi("2024-11-01");

    // Webhooks should only be in the webhooks section, not paths
    expect(doc.paths["/new-subscription"]).toBeUndefined();
    expect(doc.paths["new-subscription"]).toBeUndefined();
  });

  it("OpenAPI via HTTP endpoint includes webhooks", async () => {
    const res = await request(app.expressApp)
      .get("/openapi.json?version=2024-11-01");

    expect(res.status).toBe(200);
    expect(res.body.webhooks).toBeDefined();
    expect(res.body.webhooks["new-subscription"]).toBeDefined();
  });
});
