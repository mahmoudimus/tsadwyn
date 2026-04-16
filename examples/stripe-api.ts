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
import type { Request } from "express";
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
  HttpError,
  exceptionMap,
  deletedResponseSchema,
  createVersioningRoutes,
  perClientDefaultVersion,
} from "../src/index.js";

// ═══════════════════════════════════════════════════════════════════════════
// Domain exceptions (no HTTP semantics leak into service layers)
//
// Keyed by err.name string in exceptionMap — survives module-boundary
// identity traps (Jest resetModules, dual-install, ESM/CJS interop).
// ═══════════════════════════════════════════════════════════════════════════

class NoSuchCustomerError extends Error {
  constructor(public readonly customerId: string) {
    super(`No such customer: '${customerId}'`);
    this.name = "NoSuchCustomerError";
  }
}

class NoSuchChargeError extends Error {
  constructor(public readonly chargeId: string) {
    super(`No such charge: '${chargeId}'`);
    this.name = "NoSuchChargeError";
  }
}

class NoSuchPaymentIntentError extends Error {
  constructor(public readonly piId: string) {
    super(`No such payment_intent: '${piId}'`);
    this.name = "NoSuchPaymentIntentError";
  }
}

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

// ── Deleted-resource envelopes (Stripe shape: {id, object, deleted}) ──────

const DeletedCustomer = deletedResponseSchema("customer").named("DeletedCustomer");
const DeletedCharge = deletedResponseSchema("charge").named("DeletedCharge");
const DeletedPaymentIntent = deletedResponseSchema("payment_intent").named("DeletedPaymentIntent");

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

// ─────────────────────────────────────────────────────────────────────────
// Client → pinned version store (in-memory for the demo).
// In production, this would be a column on the `accounts` table, a Redis
// key, or a remote account-service call — the createVersioningRoutes and
// perClientDefaultVersion helpers don't care. They only see these two
// small callbacks (load + save).
// ─────────────────────────────────────────────────────────────────────────
const clientPins: Record<string, string> = {};
const SUPPORTED_VERSIONS = ["2024-11-01", "2024-06-01", "2024-01-15"] as const;

/**
 * Extract the calling account from the request. In production this comes
 * from the authenticated session (Stripe uses the secret key's account
 * binding). Here we use an `x-account-id` header so curl examples are
 * easy to run.
 */
function identifyAccount(req: Request): string | null {
  const hdr = req.headers["x-account-id"];
  return typeof hdr === "string" && hdr.length > 0 ? hdr : null;
}

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
  if (!c) throw new NoSuchCustomerError(req.params.customerId);
  return c;
});

// DELETE using Stripe's exact wire shape — verified via
// `curl -X DELETE https://api.stripe.com/v1/customers/<id>`:
// returns 200 + {id, object, deleted}, NOT 204.
// Status 200 default is correct — 204 would strip the body on the wire.
router.delete("/customers/:customerId", null, DeletedCustomer, async (req) => {
  const c = customers[req.params.customerId];
  if (!c) throw new NoSuchCustomerError(req.params.customerId);
  delete customers[req.params.customerId];
  return {
    id: req.params.customerId,
    object: "customer" as const,
    deleted: true as const,
  };
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
  if (!ch) throw new NoSuchChargeError(req.params.chargeId);
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
  if (!pi) throw new NoSuchPaymentIntentError(req.params.piId);
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
    // At v2024-06-01, `payment_method` was optional and `source` existed as
    // an optional alias — clients could send either. (Validation runs
    // BEFORE request migrations, so the schema itself has to accept
    // both shapes.)
    schema(ChargeCreate).field("payment_method").had({ optional: true }),
    schema(ChargeCreate).field("source").existedAs({ type: z.string().optional() }),
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

    // At v2024-01-15, `source` was the ONLY card token field and it was
    // REQUIRED (payment_method didn't exist yet). Make source non-optional
    // here (undoes the optional wrapper RemoveSourceAddPaymentIntent
    // applied to produce the v2024-06-01 shape).
    schema(ChargeCreate).field("payment_method").didntExist,
    schema(ChargeCreate).field("source").had({ optional: false }),
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

// Pre-wired RESTful /versioning resource. tsadwyn owns no persistence —
// loadVersion and saveVersion hand the callback off to our in-memory
// store; any real consumer would back this with Postgres, Redis, or an
// accounts microservice.
const versioningRoutes = createVersioningRoutes({
  identify: identifyAccount,
  loadVersion: (accountId) => clientPins[accountId] ?? null,
  saveVersion: (accountId, version) => {
    clientPins[accountId] = version;
  },
  supportedVersions: SUPPORTED_VERSIONS,
  // Match perClientDefaultVersion's fallback below so GET /versioning
  // reports what tsadwyn would actually use at dispatch: the initial
  // version (2024-01-15) when no pin is stored.
  fallback: "2024-01-15",
  // allowDowngrade: false,   // default
  // allowNoChange:  false,   // default
});

const app = new Tsadwyn({
  versions: new VersionBundle(
    new Version("2024-11-01", RemoveSourceAddPaymentIntent),
    new Version("2024-06-01", RenameBalanceAndAddPaymentIntents),
    new Version("2024-01-15"),
  ),
  title: "Stripe-like Payments API",
  apiVersionHeaderName: "stripe-version",

  // When a client doesn't send `stripe-version`, fall back to their
  // stored pin. Same identify callback as /versioning so there's one
  // source of truth per account. onStalePin: 'fallback' means if an
  // account has a pin we've since dropped from the bundle, tsadwyn
  // treats them as unpinned and uses `fallback` instead.
  apiVersionDefaultValue: perClientDefaultVersion({
    identify: identifyAccount,
    resolvePin: (accountId) => clientPins[accountId] ?? null,
    fallback: "2024-01-15",
    supportedVersions: SUPPORTED_VERSIONS,
    onStalePin: "fallback",
  }),

  // Domain exceptions → HttpError. Matches Stripe's own error envelope
  // shape: {error: {code, message, param?}}. Keyed by err.name string
  // so dual-install / resetModules never break instanceof checks.
  errorMapper: exceptionMap({
    NoSuchCustomerError: (err) =>
      new HttpError(404, {
        error: {
          code: "resource_missing",
          message: err.message,
          param: "id",
          type: "invalid_request_error",
        },
      }),
    NoSuchChargeError: (err) =>
      new HttpError(404, {
        error: {
          code: "resource_missing",
          message: err.message,
          param: "id",
          type: "invalid_request_error",
        },
      }),
    NoSuchPaymentIntentError: (err) =>
      new HttpError(404, {
        error: {
          code: "resource_missing",
          message: err.message,
          param: "id",
          type: "invalid_request_error",
        },
      }),
  }),
});

// Mount domain routes + the /versioning resource. tsadwyn accepts N
// VersionedRouters and merges them; both are versioned uniformly.
app.generateAndIncludeVersionedRouters(router, versioningRoutes);

// ═══════════════════════════════════════════════════════════════════════════
// Start
// ═══════════════════════════════════════════════════════════════════════════

const PORT = 4242;
app.expressApp.listen(PORT, () => {
  console.log(`\n  Stripe-like Payments API on http://localhost:${PORT}\n`);
  console.log("  Versions:  2024-01-15 │ 2024-06-01 │ 2024-11-01");
  console.log("  Header:    Stripe-Version: <date>");
  console.log(`  Docs:      http://localhost:${PORT}/docs`);
  console.log(`  Changelog: http://localhost:${PORT}/changelog\n`);

  console.log("  Try Stripe's exact DELETE pattern:");
  console.log(`    1) POST /v1/customers → note the id`);
  console.log(`    2) DELETE /v1/customers/<id> → 200 + {id, object, deleted}\n`);

  console.log("  Domain error → HttpError via exceptionMap (404 resource_missing):");
  console.log(`    curl -s -w '\\n%{http_code}\\n' http://localhost:${PORT}/v1/customers/cus_does_not_exist \\`);
  console.log(`      -H 'stripe-version: 2024-11-01' | jq .\n`);

  console.log("  Self-service version upgrades via the /versioning resource:");
  console.log(`    # 1) Read current pin — first read shows null (never pinned)`);
  console.log(`    curl -s http://localhost:${PORT}/versioning -H 'x-account-id: acct_demo' | jq .\n`);
  console.log(`    # 2) First-upgrade flow: from null → install initial pin`);
  console.log(`    curl -s -X POST http://localhost:${PORT}/versioning \\`);
  console.log(`      -H 'Content-Type: application/json' -H 'x-account-id: acct_demo' \\`);
  console.log(`      -d '{"from": null, "to": "2024-01-15"}' | jq .\n`);
  console.log(`    # 3) Now requests without stripe-version automatically use the pin`);
  console.log(`    curl -s -X POST http://localhost:${PORT}/v1/customers \\`);
  console.log(`      -H 'Content-Type: application/json' -H 'x-account-id: acct_demo' \\`);
  console.log(`      -d '{"email":"a@b.c","name":"A"}' | jq .   # → account_balance shape (2024-01-15)\n`);
  console.log(`    # 4) Upgrade to middle version`);
  console.log(`    curl -s -X POST http://localhost:${PORT}/versioning \\`);
  console.log(`      -H 'Content-Type: application/json' -H 'x-account-id: acct_demo' \\`);
  console.log(`      -d '{"from": "2024-01-15", "to": "2024-06-01"}' | jq .\n`);
  console.log(`    # 5) Drift rejection — stale 'from' triggers 409`);
  console.log(`    curl -s -w '\\nstatus: %{http_code}\\n' -X POST http://localhost:${PORT}/versioning \\`);
  console.log(`      -H 'Content-Type: application/json' -H 'x-account-id: acct_demo' \\`);
  console.log(`      -d '{"from": "2024-01-15", "to": "2024-11-01"}' | jq .   # actual is now 2024-06-01\n`);
  console.log(`    # 6) Downgrade blocked by default`);
  console.log(`    curl -s -w '\\nstatus: %{http_code}\\n' -X POST http://localhost:${PORT}/versioning \\`);
  console.log(`      -H 'Content-Type: application/json' -H 'x-account-id: acct_demo' \\`);
  console.log(`      -d '{"from": "2024-06-01", "to": "2024-01-15"}' | jq .   # 400 downgrade-blocked\n`);

  console.log("  Introspection (in another shell):");
  console.log(`    npx tsx src/cli.ts routes      --app examples/stripe-api.ts --format table`);
  console.log(`    npx tsx src/cli.ts migrations  --app examples/stripe-api.ts --schema CustomerResource --version 2024-01-15`);
  console.log(`    npx tsx src/cli.ts simulate    --app examples/stripe-api.ts --method DELETE --path /v1/customers/cus_x --version 2024-06-01`);
  console.log(`    npx tsx src/cli.ts exceptions  --app examples/stripe-api.ts --format table\n`);
});

export { app };
