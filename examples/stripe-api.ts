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
 * Run:   npx tsx examples/stripe-api.ts
 */
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

// ── Customers ──────────────────────────────────────────────────────────────

const CustomerCreate = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  balance: z.number().int().default(0),                // cents
  metadata: z.record(z.string()).optional(),
}).named("CustomerCreate");

const CustomerResource = z.object({
  id: z.string(),
  object: z.literal("customer"),
  email: z.string(),
  name: z.string(),
  balance: z.number().int(),
  currency: z.string(),
  created: z.number().int(),                           // unix timestamp
  metadata: z.record(z.string()),
}).named("CustomerResource");

// ── Charges ────────────────────────────────────────────────────────────────

const ChargeCreate = z.object({
  amount: z.number().int().positive(),                  // cents
  currency: z.string().length(3),
  payment_method: z.string(),                           // pm_xxx
  customer: z.string().optional(),                      // cus_xxx
  description: z.string().optional(),
  metadata: z.record(z.string()).optional(),
}).named("ChargeCreate");

const ChargeResource = z.object({
  id: z.string(),
  object: z.literal("charge"),
  amount: z.number().int(),
  currency: z.string(),
  payment_method: z.string(),
  payment_intent: z.string().nullable(),                // pi_xxx or null
  customer: z.string().nullable(),
  description: z.string().nullable(),
  status: z.enum(["succeeded", "pending", "failed"]),
  created: z.number().int(),
  metadata: z.record(z.string()),
}).named("ChargeResource");

// ── Payment Intents ────────────────────────────────────────────────────────

const PaymentIntentCreate = z.object({
  amount: z.number().int().positive(),
  currency: z.string().length(3),
  payment_method: z.string().optional(),
  customer: z.string().optional(),
  description: z.string().optional(),
  automatic_payment_methods: z.object({
    enabled: z.boolean(),
  }).optional(),
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
  automatic_payment_methods: z.object({
    enabled: z.boolean(),
  }).nullable(),
  created: z.number().int(),
  metadata: z.record(z.string()),
}).named("PaymentIntentResource");

// ── List wrappers ──────────────────────────────────────────────────────────

const CustomerList = z.object({
  object: z.literal("list"),
  data: z.array(CustomerResource),
  has_more: z.boolean(),
  url: z.string(),
}).named("CustomerList");

const ChargeList = z.object({
  object: z.literal("list"),
  data: z.array(ChargeResource),
  has_more: z.boolean(),
  url: z.string(),
}).named("ChargeList");

const PaymentIntentList = z.object({
  object: z.literal("list"),
  data: z.array(PaymentIntentResource),
  has_more: z.boolean(),
  url: z.string(),
}).named("PaymentIntentList");

// ═══════════════════════════════════════════════════════════════════════════
// Database
// ═══════════════════════════════════════════════════════════════════════════

const customers: Record<string, any> = {};
const charges: Record<string, any> = {};
const paymentIntents: Record<string, any> = {};

function genId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Routes — all written against the latest version only
// ═══════════════════════════════════════════════════════════════════════════

const router = new VersionedRouter({ prefix: "/v1" });

// ── Customers ──────────────────────────────────────────────────────────────

router.post("/customers", CustomerCreate, CustomerResource, async (req) => {
  const id = genId("cus");
  const customer = {
    id,
    object: "customer" as const,
    email: req.body.email,
    name: req.body.name,
    balance: req.body.balance ?? 0,
    currency: "usd",
    created: Math.floor(Date.now() / 1000),
    metadata: req.body.metadata ?? {},
  };
  customers[id] = customer;
  return customer;
});

router.get("/customers/:customerId", null, CustomerResource, async (req) => {
  const c = customers[req.params.customerId];
  if (!c) throw new Error("No such customer");
  return c;
});

router.get("/customers", null, CustomerList, async () => {
  const data = Object.values(customers);
  return { object: "list" as const, data, has_more: false, url: "/v1/customers" };
});

// ── Charges ────────────────────────────────────────────────────────────────

router.post("/charges", ChargeCreate, ChargeResource, async (req) => {
  const id = genId("ch");
  const charge = {
    id,
    object: "charge" as const,
    amount: req.body.amount,
    currency: req.body.currency,
    payment_method: req.body.payment_method,
    payment_intent: null,
    customer: req.body.customer ?? null,
    description: req.body.description ?? null,
    status: "succeeded" as const,
    created: Math.floor(Date.now() / 1000),
    metadata: req.body.metadata ?? {},
  };
  charges[id] = charge;
  return charge;
});

router.get("/charges/:chargeId", null, ChargeResource, async (req) => {
  const ch = charges[req.params.chargeId];
  if (!ch) throw new Error("No such charge");
  return ch;
});

router.get("/charges", null, ChargeList, async () => {
  const data = Object.values(charges);
  return { object: "list" as const, data, has_more: false, url: "/v1/charges" };
});

// ── Payment Intents ────────────────────────────────────────────────────────

router.post("/payment_intents", PaymentIntentCreate, PaymentIntentResource,
  async (req) => {
    const id = genId("pi");
    const pi = {
      id,
      object: "payment_intent" as const,
      amount: req.body.amount,
      currency: req.body.currency,
      payment_method: req.body.payment_method ?? null,
      customer: req.body.customer ?? null,
      description: req.body.description ?? null,
      status: req.body.payment_method
        ? "requires_confirmation" as const
        : "requires_payment_method" as const,
      automatic_payment_methods: req.body.automatic_payment_methods ?? null,
      created: Math.floor(Date.now() / 1000),
      metadata: req.body.metadata ?? {},
    };
    paymentIntents[id] = pi;
    return pi;
  },
);

router.get("/payment_intents/:piId", null, PaymentIntentResource, async (req) => {
  const pi = paymentIntents[req.params.piId];
  if (!pi) throw new Error("No such payment intent");
  return pi;
});

router.get("/payment_intents", null, PaymentIntentList, async () => {
  const data = Object.values(paymentIntents);
  return { object: "list" as const, data, has_more: false, url: "/v1/payment_intents" };
});

// ═══════════════════════════════════════════════════════════════════════════
// Version Changes
// ═══════════════════════════════════════════════════════════════════════════

/**
 * v2024-06-01 → v2024-11-01
 *
 * 1) `charges.source` was removed — only `payment_method` now.
 *    In v2024-06-01, both `source` and `payment_method` existed.
 *    We add `source` back as a copy of `payment_method` for old clients.
 *
 * 2) `charges.payment_intent` is new — didn't exist before.
 *
 * 3) `payment_intents.automatic_payment_methods` is new.
 */
class RemoveSourceAddPaymentIntent extends VersionChange {
  description =
    "Removed charges.source (use payment_method), added charges.payment_intent " +
    "back-reference, added payment_intents.automatic_payment_methods";

  instructions = [
    // In v2024-06-01, charges still had `source` alongside payment_method
    schema(ChargeCreate).field("payment_method").had({
      name: "payment_method",   // keep the field
    }),
    schema(ChargeResource).field("payment_intent").didntExist,
    schema(PaymentIntentCreate).field("automatic_payment_methods").didntExist,
    schema(PaymentIntentResource).field("automatic_payment_methods").didntExist,
  ];

  // Old clients might still send `source` — treat it as `payment_method`
  migrateChargeRequest = convertRequestToNextVersionFor(ChargeCreate)(
    (request: RequestInfo) => {
      if (request.body.source && !request.body.payment_method) {
        request.body.payment_method = request.body.source;
      }
      delete request.body.source;
    },
  );

  migrateChargeResponse = convertResponseToPreviousVersionFor(ChargeResource)(
    (response: ResponseInfo) => {
      // Add `source` back as a copy of payment_method for old clients
      response.body.source = response.body.payment_method;
      // Remove payment_intent (didn't exist in this version)
      delete response.body.payment_intent;
    },
  );

  migrateChargeListResponse = convertResponseToPreviousVersionFor("/v1/charges", ["GET"])(
    (response: ResponseInfo) => {
      if (Array.isArray(response.body?.data)) {
        for (const charge of response.body.data) {
          charge.source = charge.payment_method;
          delete charge.payment_intent;
        }
      }
    },
  );

  migratePIResponse = convertResponseToPreviousVersionFor(PaymentIntentResource)(
    (response: ResponseInfo) => {
      delete response.body.automatic_payment_methods;
    },
  );

  migratePIListResponse = convertResponseToPreviousVersionFor("/v1/payment_intents", ["GET"])(
    (response: ResponseInfo) => {
      if (Array.isArray(response.body?.data)) {
        for (const pi of response.body.data) {
          delete pi.automatic_payment_methods;
        }
      }
    },
  );
}

/**
 * v2024-01-15 → v2024-06-01
 *
 * 1) `customers.account_balance` was renamed to `customers.balance`.
 *
 * 2) `/v1/payment_intents` endpoint was added — it didn't exist in v2024-01-15.
 *
 * 3) Charges in v2024-01-15 used `source` (card token) and had no
 *    `payment_method` field at all.
 */
class RenameBalanceAndAddPaymentIntents extends VersionChange {
  description =
    "Renamed customers.account_balance to balance, " +
    "added /v1/payment_intents endpoints, " +
    "charges had only source (no payment_method)";

  instructions = [
    // `balance` was called `account_balance` in v2024-01-15
    schema(CustomerCreate).field("balance").had({ name: "account_balance" }),
    schema(CustomerResource).field("balance").had({ name: "account_balance" }),

    // payment_intents didn't exist at all in v2024-01-15
    endpoint("/v1/payment_intents", ["POST"]).didntExist,
    endpoint("/v1/payment_intents", ["GET"]).didntExist,
    endpoint("/v1/payment_intents/:piId", ["GET"]).didntExist,
  ];

  // Rename account_balance → balance in customer requests
  migrateCustomerRequest = convertRequestToNextVersionFor(CustomerCreate)(
    (request: RequestInfo) => {
      if ("account_balance" in request.body) {
        request.body.balance = request.body.account_balance;
        delete request.body.account_balance;
      }
    },
  );

  // Rename balance → account_balance in customer responses
  migrateCustomerResponse = convertResponseToPreviousVersionFor(CustomerResource)(
    (response: ResponseInfo) => {
      response.body.account_balance = response.body.balance;
      delete response.body.balance;
    },
  );

  migrateCustomerListResponse = convertResponseToPreviousVersionFor("/v1/customers", ["GET"])(
    (response: ResponseInfo) => {
      if (Array.isArray(response.body?.data)) {
        for (const customer of response.body.data) {
          customer.account_balance = customer.balance;
          delete customer.balance;
        }
      }
    },
  );

  // In v2024-01-15, charges used `source` and didn't have `payment_method`.
  // Incoming old requests send `source` — convert to `payment_method`.
  migrateChargeRequest = convertRequestToNextVersionFor(ChargeCreate)(
    (request: RequestInfo) => {
      if (request.body.source && !request.body.payment_method) {
        request.body.payment_method = request.body.source;
      }
      delete request.body.source;
    },
  );

  // Outgoing: strip `payment_method`, keep only `source`
  migrateChargeResponse = convertResponseToPreviousVersionFor(ChargeResource)(
    (response: ResponseInfo) => {
      response.body.source = response.body.source ?? response.body.payment_method;
      delete response.body.payment_method;
    },
  );

  migrateChargeListResponse = convertResponseToPreviousVersionFor("/v1/charges", ["GET"])(
    (response: ResponseInfo) => {
      if (Array.isArray(response.body?.data)) {
        for (const charge of response.body.data) {
          charge.source = charge.source ?? charge.payment_method;
          delete charge.payment_method;
        }
      }
    },
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Wire it up
// ═══════════════════════════════════════════════════════════════════════════

const app = new Tsadwyn({
  versions: new VersionBundle(
    new Version("2024-11-01", RemoveSourceAddPaymentIntent),
    new Version("2024-06-01", RenameBalanceAndAddPaymentIntents),
    new Version("2024-01-15"),
  ),
  title: "Stripe-like Payments API",
  apiVersionHeaderName: "stripe-version",
});

app.generateAndIncludeVersionedRouters(router);

// ═══════════════════════════════════════════════════════════════════════════
// Start
// ═══════════════════════════════════════════════════════════════════════════

const PORT = 4242;
app.expressApp.listen(PORT, () => {
  console.log(`\n  Stripe-like Payments API on http://localhost:${PORT}\n`);
  console.log("  Versions:  2024-01-15 │ 2024-06-01 │ 2024-11-01");
  console.log("  Header:    Stripe-Version: <date>");
  console.log("  Docs:      http://localhost:${PORT}/docs");
  console.log("  Changelog: http://localhost:${PORT}/changelog\n");
});

export { app };
