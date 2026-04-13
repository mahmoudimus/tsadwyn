/**
 * Simplified Stripe-like Payments API — 3 versions demonstrating real
 * Stripe API versioning patterns:
 *
 *   v2024-01-15  (oldest)  — charges use `source` (card token string),
 *                            customers have `account_balance`
 *   v2024-06-01  (middle)  — `account_balance` renamed to `balance`,
 *                            charges gain `payment_method` alongside `source`,
 *                            new `/v1/payment_intents` resource added
 *   v2024-11-01  (latest)  — `source` removed from charges (payment_method only),
 *                            charges gain `payment_intent` back-reference,
 *                            payment_intents gain `automatic_payment_methods`
 *
 * Run:  npx vitest run tests/stripe-api.test.ts
 */
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import crypto from "node:crypto";
import { z } from "zod";
import {
  Tsadwyn,
  Version,
  VersionBundle,
  VersionChange,
  VersionedRouter,
  schema,
  endpoint,
  convertRequestToNextVersionFor,
  convertResponseToPreviousVersionFor,
  RequestInfo,
  ResponseInfo,
} from "../src/index.js";

// ═══════════════════════════════════════════════════════════════════════════
// Schemas — latest version (2024-11-01)
// ═══════════════════════════════════════════════════════════════════════════

const CustomerCreate = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  balance: z.number().int().default(0),
  metadata: z.record(z.string()).optional(),
}).named("CustomerCreate");

const CustomerResource = z.object({
  id: z.string(),
  object: z.literal("customer"),
  email: z.string(),
  name: z.string(),
  balance: z.number().int(),
  currency: z.string(),
  created: z.number().int(),
  metadata: z.record(z.string()),
}).named("CustomerResource");

const ChargeCreate = z.object({
  amount: z.number().int().positive(),
  currency: z.string().length(3),
  payment_method: z.string(),
  customer: z.string().optional(),
  description: z.string().optional(),
  metadata: z.record(z.string()).optional(),
}).named("ChargeCreate");

const ChargeResource = z.object({
  id: z.string(),
  object: z.literal("charge"),
  amount: z.number().int(),
  currency: z.string(),
  payment_method: z.string(),
  payment_intent: z.string().nullable(),
  customer: z.string().nullable(),
  description: z.string().nullable(),
  status: z.enum(["succeeded", "pending", "failed"]),
  created: z.number().int(),
  metadata: z.record(z.string()),
}).named("ChargeResource");

const PaymentIntentCreate = z.object({
  amount: z.number().int().positive(),
  currency: z.string().length(3),
  payment_method: z.string().optional(),
  customer: z.string().optional(),
  description: z.string().optional(),
  automatic_payment_methods: z.object({ enabled: z.boolean() }).optional(),
  metadata: z.record(z.string()).optional(),
}).named("PaymentIntentCreate");

const PaymentIntentResource = z.object({
  id: z.string(),
  object: z.literal("payment_intent"),
  amount: z.number().int(),
  currency: z.string(),
  payment_method: z.string().nullable(),
  customer: z.string().nullable(),
  description: z.string().nullable(),
  status: z.enum(["requires_payment_method", "requires_confirmation",
                   "processing", "succeeded", "canceled"]),
  automatic_payment_methods: z.object({ enabled: z.boolean() }).nullable(),
  created: z.number().int(),
  metadata: z.record(z.string()),
}).named("PaymentIntentResource");

// ═══════════════════════════════════════════════════════════════════════════
// Database + helpers
// ═══════════════════════════════════════════════════════════════════════════

const customers: Record<string, any> = {};
const charges: Record<string, any> = {};
const paymentIntents: Record<string, any> = {};

function genId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Routes — latest version only
// ═══════════════════════════════════════════════════════════════════════════

const router = new VersionedRouter({ prefix: "/v1" });

router.post("/customers", CustomerCreate, CustomerResource, async (req) => {
  const id = genId("cus");
  const c = {
    id, object: "customer" as const,
    email: req.body.email, name: req.body.name,
    balance: req.body.balance ?? 0, currency: "usd",
    created: Math.floor(Date.now() / 1000),
    metadata: req.body.metadata ?? {},
  };
  customers[id] = c;
  return c;
});

router.get("/customers/:cid", null, CustomerResource, async (req) => {
  return customers[req.params.cid];
});

router.get("/customers", null, null, async () => {
  return { object: "list", data: Object.values(customers), has_more: false, url: "/v1/customers" };
});

router.post("/charges", ChargeCreate, ChargeResource, async (req) => {
  const id = genId("ch");
  const ch = {
    id, object: "charge" as const,
    amount: req.body.amount, currency: req.body.currency,
    payment_method: req.body.payment_method,
    payment_intent: null, customer: req.body.customer ?? null,
    description: req.body.description ?? null,
    status: "succeeded" as const,
    created: Math.floor(Date.now() / 1000),
    metadata: req.body.metadata ?? {},
  };
  charges[id] = ch;
  return ch;
});

router.get("/charges/:chid", null, ChargeResource, async (req) => {
  return charges[req.params.chid];
});

router.get("/charges", null, null, async () => {
  return { object: "list", data: Object.values(charges), has_more: false, url: "/v1/charges" };
});

router.post("/payment_intents", PaymentIntentCreate, PaymentIntentResource, async (req) => {
  const id = genId("pi");
  const pi = {
    id, object: "payment_intent" as const,
    amount: req.body.amount, currency: req.body.currency,
    payment_method: req.body.payment_method ?? null,
    customer: req.body.customer ?? null,
    description: req.body.description ?? null,
    status: req.body.payment_method ? "requires_confirmation" as const : "requires_payment_method" as const,
    automatic_payment_methods: req.body.automatic_payment_methods ?? null,
    created: Math.floor(Date.now() / 1000),
    metadata: req.body.metadata ?? {},
  };
  paymentIntents[id] = pi;
  return pi;
});

router.get("/payment_intents/:piid", null, PaymentIntentResource, async (req) => {
  return paymentIntents[req.params.piid];
});

router.get("/payment_intents", null, null, async () => {
  return { object: "list", data: Object.values(paymentIntents), has_more: false, url: "/v1/payment_intents" };
});

// ═══════════════════════════════════════════════════════════════════════════
// Version Changes
// ═══════════════════════════════════════════════════════════════════════════

// v2024-06-01 → v2024-11-01:
// - charges.payment_intent is new (didn't exist)
// - payment_intents.automatic_payment_methods is new (didn't exist)
class AddPaymentIntentRefAndAutoMethods extends VersionChange {
  description = "Added charges.payment_intent back-reference and PI.automatic_payment_methods";

  instructions = [
    schema(ChargeResource).field("payment_intent").didntExist,
    schema(PaymentIntentCreate).field("automatic_payment_methods").didntExist,
    schema(PaymentIntentResource).field("automatic_payment_methods").didntExist,
  ];

  r1 = convertResponseToPreviousVersionFor(ChargeResource)(
    (res: ResponseInfo) => { delete res.body.payment_intent; },
  );

  r2 = convertResponseToPreviousVersionFor("/v1/charges", ["GET"])(
    (res: ResponseInfo) => {
      if (Array.isArray(res.body?.data)) {
        for (const ch of res.body.data) { delete ch.payment_intent; }
      }
    },
  );

  r3 = convertResponseToPreviousVersionFor(PaymentIntentResource)(
    (res: ResponseInfo) => { delete res.body.automatic_payment_methods; },
  );

  r4 = convertResponseToPreviousVersionFor("/v1/payment_intents", ["GET"])(
    (res: ResponseInfo) => {
      if (Array.isArray(res.body?.data)) {
        for (const pi of res.body.data) { delete pi.automatic_payment_methods; }
      }
    },
  );
}

// v2024-01-15 → v2024-06-01:
// - customers.account_balance renamed to customers.balance
// - charges.payment_method was called charges.source
// - /v1/payment_intents endpoints didn't exist
class RenameFieldsAddPI extends VersionChange {
  description = "Renamed account_balance→balance, source→payment_method, added payment_intents";

  instructions = [
    schema(CustomerCreate).field("balance").had({ name: "account_balance" }),
    schema(CustomerResource).field("balance").had({ name: "account_balance" }),
    schema(ChargeCreate).field("payment_method").had({ name: "source" }),
    schema(ChargeResource).field("payment_method").had({ name: "source" }),
    endpoint("/v1/payment_intents", ["POST"]).didntExist,
    endpoint("/v1/payment_intents", ["GET"]).didntExist,
    endpoint("/v1/payment_intents/:piid", ["GET"]).didntExist,
  ];

  r1 = convertRequestToNextVersionFor(CustomerCreate)(
    (req: RequestInfo) => {
      if ("account_balance" in req.body) {
        req.body.balance = req.body.account_balance;
        delete req.body.account_balance;
      }
    },
  );

  r2 = convertResponseToPreviousVersionFor(CustomerResource)(
    (res: ResponseInfo) => {
      res.body.account_balance = res.body.balance;
      delete res.body.balance;
    },
  );

  r3 = convertResponseToPreviousVersionFor("/v1/customers", ["GET"])(
    (res: ResponseInfo) => {
      if (Array.isArray(res.body?.data)) {
        for (const c of res.body.data) {
          c.account_balance = c.balance;
          delete c.balance;
        }
      }
    },
  );

  r4 = convertRequestToNextVersionFor(ChargeCreate)(
    (req: RequestInfo) => {
      if ("source" in req.body) {
        req.body.payment_method = req.body.source;
        delete req.body.source;
      }
    },
  );

  r5 = convertResponseToPreviousVersionFor(ChargeResource)(
    (res: ResponseInfo) => {
      res.body.source = res.body.payment_method;
      delete res.body.payment_method;
    },
  );

  r6 = convertResponseToPreviousVersionFor("/v1/charges", ["GET"])(
    (res: ResponseInfo) => {
      if (Array.isArray(res.body?.data)) {
        for (const ch of res.body.data) {
          ch.source = ch.payment_method;
          delete ch.payment_method;
        }
      }
    },
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// App
// ═══════════════════════════════════════════════════════════════════════════

const app = new Tsadwyn({
  versions: new VersionBundle(
    new Version("2024-11-01", AddPaymentIntentRefAndAutoMethods),
    new Version("2024-06-01", RenameFieldsAddPI),
    new Version("2024-01-15"),
  ),
  title: "Stripe-like Payments API",
  apiVersionHeaderName: "stripe-version",
});
app.generateAndIncludeVersionedRouters(router);

const V1 = "2024-01-15";
const V2 = "2024-06-01";
const V3 = "2024-11-01";
const server = app.expressApp;

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("customers: account_balance → balance rename", () => {
  let customerId: string;

  it("v1: create with account_balance", async () => {
    const res = await request(server).post("/v1/customers")
      .set("stripe-version", V1)
      .send({ email: "jane@example.com", name: "Jane", account_balance: 5000 });

    expect(res.status).toBe(200);
    expect(res.body.id).toMatch(/^cus_/);
    expect(res.body.account_balance).toBe(5000);
    expect(res.body.balance).toBeUndefined();
    customerId = res.body.id;
  });

  it("v2: same customer shows balance", async () => {
    const res = await request(server).get(`/v1/customers/${customerId}`)
      .set("stripe-version", V2);
    expect(res.body.balance).toBe(5000);
    expect(res.body.account_balance).toBeUndefined();
  });

  it("v3: same customer shows balance", async () => {
    const res = await request(server).get(`/v1/customers/${customerId}`)
      .set("stripe-version", V3);
    expect(res.body.balance).toBe(5000);
  });

  it("v1: list shows account_balance", async () => {
    const res = await request(server).get("/v1/customers")
      .set("stripe-version", V1);
    const jane = res.body.data.find((c: any) => c.id === customerId);
    expect(jane.account_balance).toBe(5000);
    expect(jane.balance).toBeUndefined();
  });
});

describe("charges: source → payment_method rename", () => {
  let chargeId: string;

  it("v1: create with source (old name)", async () => {
    const res = await request(server).post("/v1/charges")
      .set("stripe-version", V1)
      .send({ amount: 2000, currency: "usd", source: "tok_visa_4242" });

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("tok_visa_4242");
    expect(res.body.payment_method).toBeUndefined();  // v1 calls it "source"
    expect(res.body.payment_intent).toBeUndefined();   // v1 doesn't have this
    chargeId = res.body.id;
  });

  it("v2: same charge shows payment_method (new name)", async () => {
    const res = await request(server).get(`/v1/charges/${chargeId}`)
      .set("stripe-version", V2);
    expect(res.body.payment_method).toBe("tok_visa_4242");
    expect(res.body.source).toBeUndefined();           // v2 renamed it
    expect(res.body.payment_intent).toBeUndefined();   // v2 doesn't have this
  });

  it("v3: same charge shows payment_method + payment_intent", async () => {
    const res = await request(server).get(`/v1/charges/${chargeId}`)
      .set("stripe-version", V3);
    expect(res.body.payment_method).toBe("tok_visa_4242");
    expect(res.body.source).toBeUndefined();
    expect(res.body.payment_intent).toBeNull();        // v3 added this field
  });

  it("v3: create with payment_method", async () => {
    const res = await request(server).post("/v1/charges")
      .set("stripe-version", V3)
      .send({ amount: 5000, currency: "gbp", payment_method: "pm_amex" });
    expect(res.body.payment_method).toBe("pm_amex");
    expect(res.body.source).toBeUndefined();
  });

  it("v1: list charges — all show source, no payment_method", async () => {
    const res = await request(server).get("/v1/charges")
      .set("stripe-version", V1);
    for (const ch of res.body.data) {
      expect(ch.source).toBeDefined();
      expect(ch.payment_method).toBeUndefined();
      expect(ch.payment_intent).toBeUndefined();
    }
  });
});

describe("payment_intents: didn't exist in v1, new fields in v3", () => {
  let piId: string;

  it("v1: POST /payment_intents returns 404", async () => {
    const res = await request(server).post("/v1/payment_intents")
      .set("stripe-version", V1)
      .send({ amount: 1000, currency: "usd" });
    expect(res.status).toBe(404);
  });

  it("v1: GET /payment_intents returns 404", async () => {
    const res = await request(server).get("/v1/payment_intents")
      .set("stripe-version", V1);
    expect(res.status).toBe(404);
  });

  it("v2: create PI (no automatic_payment_methods)", async () => {
    const res = await request(server).post("/v1/payment_intents")
      .set("stripe-version", V2)
      .send({ amount: 10000, currency: "usd", payment_method: "pm_visa" });
    expect(res.status).toBe(200);
    expect(res.body.id).toMatch(/^pi_/);
    expect(res.body.automatic_payment_methods).toBeUndefined();
    piId = res.body.id;
  });

  it("v3: same PI shows automatic_payment_methods (null)", async () => {
    const res = await request(server).get(`/v1/payment_intents/${piId}`)
      .set("stripe-version", V3);
    expect(res.body.automatic_payment_methods).toBeNull();
  });

  it("v3: create PI with automatic_payment_methods", async () => {
    const res = await request(server).post("/v1/payment_intents")
      .set("stripe-version", V3)
      .send({ amount: 20000, currency: "usd", automatic_payment_methods: { enabled: true } });
    expect(res.body.automatic_payment_methods).toEqual({ enabled: true });
  });

  it("v2: list PIs — automatic_payment_methods stripped", async () => {
    const res = await request(server).get("/v1/payment_intents")
      .set("stripe-version", V2);
    for (const pi of res.body.data) {
      expect(pi.automatic_payment_methods).toBeUndefined();
    }
  });
});

describe("cross-version: same resource, different shapes", () => {
  let cusId: string;
  let chId: string;

  beforeAll(async () => {
    const c = await request(server).post("/v1/customers")
      .set("stripe-version", V3)
      .send({ email: "cross@test.com", name: "Cross", balance: 9999 });
    cusId = c.body.id;

    const ch = await request(server).post("/v1/charges")
      .set("stripe-version", V3)
      .send({ amount: 4200, currency: "usd", payment_method: "pm_cross", customer: cusId });
    chId = ch.body.id;
  });

  it("customer: v1=account_balance, v2/v3=balance", async () => {
    const r1 = await request(server).get(`/v1/customers/${cusId}`).set("stripe-version", V1);
    const r2 = await request(server).get(`/v1/customers/${cusId}`).set("stripe-version", V2);
    const r3 = await request(server).get(`/v1/customers/${cusId}`).set("stripe-version", V3);

    expect(r1.body.account_balance).toBe(9999);
    expect(r1.body.balance).toBeUndefined();
    expect(r2.body.balance).toBe(9999);
    expect(r2.body.account_balance).toBeUndefined();
    expect(r3.body.balance).toBe(9999);
  });

  it("charge: v1=source, v2=payment_method, v3=payment_method+payment_intent", async () => {
    const r1 = await request(server).get(`/v1/charges/${chId}`).set("stripe-version", V1);
    const r2 = await request(server).get(`/v1/charges/${chId}`).set("stripe-version", V2);
    const r3 = await request(server).get(`/v1/charges/${chId}`).set("stripe-version", V3);

    // v1: source (old name)
    expect(r1.body.source).toBe("pm_cross");
    expect(r1.body.payment_method).toBeUndefined();
    expect(r1.body.payment_intent).toBeUndefined();

    // v2: payment_method (renamed), no payment_intent yet
    expect(r2.body.payment_method).toBe("pm_cross");
    expect(r2.body.source).toBeUndefined();
    expect(r2.body.payment_intent).toBeUndefined();

    // v3: payment_method + payment_intent
    expect(r3.body.payment_method).toBe("pm_cross");
    expect(r3.body.source).toBeUndefined();
    expect(r3.body.payment_intent).toBeNull();
  });
});

describe("validation", () => {
  it("invalid version → 422", async () => {
    const res = await request(server).get("/v1/customers")
      .set("stripe-version", "2099-01-01");
    expect(res.status).toBe(422);
  });
});
