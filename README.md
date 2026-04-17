# tsadwyn

[![CI](https://github.com/mahmoudimus/tsadwyn/actions/workflows/ci.yml/badge.svg)](https://github.com/mahmoudimus/tsadwyn/actions/workflows/ci.yml)

Stripe-like API versioning for TypeScript/Express. tsadwyn is a TypeScript port of [Cadwyn](https://github.com/zmievsa/cadwyn) by Stanislav Zmiev — it enables you to maintain a single codebase that serves multiple API versions simultaneously. Instead of duplicating routes for each version, you define version changes declaratively and tsadwyn generates versioned routers with automatic request/response migration.

## Installation

```bash
npm install tsadwyn
```

## Quick Start

```typescript
import { z } from "zod";
import {
  Tsadwyn,
  Version,
  VersionBundle,
  VersionChange,
  VersionedRouter,
  schema,
  convertRequestToNextVersionFor,
  convertResponseToPreviousVersionFor,
  RequestInfo,
  ResponseInfo,
} from "tsadwyn";

// 1. Define your latest (head) schemas
const UserCreateRequest = z
  .object({ addresses: z.array(z.string()) })
  .named("UserCreateRequest");

const UserResource = z
  .object({ id: z.string().uuid(), addresses: z.array(z.string()) })
  .named("UserResource");

// 2. Define what changed between versions
class ChangeAddressToList extends VersionChange {
  description = "Changed address from string to array of strings";

  instructions = [
    schema(UserCreateRequest)
      .field("addresses")
      .had({ name: "address", type: z.string() }),
    schema(UserResource)
      .field("addresses")
      .had({ name: "address", type: z.string() }),
  ];

  @convertRequestToNextVersionFor(UserCreateRequest)
  migrateRequest(request: RequestInfo) {
    request.body.addresses = [request.body.address];
    delete request.body.address;
  }

  @convertResponseToPreviousVersionFor(UserResource)
  migrateResponse(response: ResponseInfo) {
    response.body.address = response.body.addresses[0];
    delete response.body.addresses;
  }
}

// 3. Register routes against the latest schema
const router = new VersionedRouter();

router.post("/users", UserCreateRequest, UserResource, async (req) => {
  // req.body is typed as { addresses: string[] }
  return { id: "some-uuid", addresses: req.body.addresses };
});

// 4. Create the app with version declarations
const app = new Tsadwyn({
  versions: new VersionBundle(
    new Version("2025-01-01", ChangeAddressToList),
    new Version("2024-01-01"), // oldest version, no changes
  ),
});
app.generateAndIncludeVersionedRouters(router);

// 5. Start the server
app.expressApp.listen(3000);
```

Now clients can send requests with the `x-api-version` header:

- `x-api-version: 2025-01-01` -- uses the latest schema with `addresses` array
- `x-api-version: 2024-01-01` -- uses the old schema with `address` string

tsadwyn automatically migrates requests from old versions to the latest format before your handler runs, and migrates responses back to the requested version's format before sending.

## Concepts

- **VersionedRouter**: Register routes once against the latest schema shape
- **VersionChange**: Declare what changed between two adjacent versions
- **schema().field().had()**: Describe how schema fields changed (renamed, type changed, added, removed)
- **endpoint().didntExist / existed**: Describe routes added or removed between versions
- **convertRequestToNextVersionFor**: Migrate request bodies from old to new format
- **convertResponseToPreviousVersionFor**: Migrate response bodies from new to old format

For full documentation on the head-first API versioning pattern, see the [Cadwyn docs](https://docs.cadwyn.dev/) — the concepts carry over directly.

## Client pinning

tsadwyn implements the **Stripe-style per-client pinning** model. Every client is associated with a specific API version — the **version they signed up under** or upgraded to — and tsadwyn migrates requests and responses to match that pin transparently. The client never sees a behavior change unless they explicitly upgrade.

Three terms you'll see throughout the docs:

- **initial version** — the oldest supported version in the bundle. Clients that signed up before any changes shipped are pinned here. Still a first-class contract.
- **previous version** — any version one step back from the latest. Useful when discussing "clients on the version right before we added X".
- **latest / head version** — the newest version. Business logic runs against this shape; all migrations are expressed relative to it.

Two widely-used patterns for deciding which version a request runs under:

### 1. Explicit per-request header

The simplest: the client sets `x-api-version` (or Stripe's `stripe-version`) on every request. Works out of the box with `new Tsadwyn({ apiVersionHeaderName: 'x-api-version' })`.

### 2. Per-client default from your database (Stripe's model)

Each client has a pinned version stored in a DB row. When no header is present, tsadwyn resolves the default from the authenticated identity. Pair the `preVersionPick` hook (runs auth before version resolution) with the `perClientDefaultVersion` helper:

```ts
import { Tsadwyn, perClientDefaultVersion } from 'tsadwyn';

const app = new Tsadwyn({
  versions: /* ... */,

  preVersionPick: (req, res, next) => {
    authenticate(req)
      .then(user => { (req as any).user = user; next(); })
      .catch(next);
  },

  apiVersionDefaultValue: perClientDefaultVersion({
    identify:   req => (req as any).user?.accountId ?? null,
    resolvePin: accountId => accountRepo.getApiVersion(accountId),
    saveVersion: (accountId, v) => accountRepo.setApiVersion(accountId, v),
    fallback:   bundle.versionValues[0],       // latest — Stripe's "pin to current latest at signup" model
    pinOnFirstResolve: true,                   // persist the pin on first authenticated call
    supportedVersions: bundle.versionValues,
    onStalePin: 'fallback',                    // if stored pin isn't in bundle
  }),

  // Strict 400 when the header names a version that isn't in the bundle.
  // Default is 'passthrough' (preserves historical behavior).
  // Pass to versionPickingMiddleware options when you own the picker.
});
```

An explicit `x-api-version` header always wins over the resolver — useful for staging, per-request overrides, and admin tooling.

### Stale pins — what they are, and why tsadwyn doesn't auto-heal them

A **stale pin** is a stored pin value that points at a version no longer in the current `VersionBundle`. The pin was written at some point, persisted, and is now orphaned because the bundle has evolved out from under it. This happens in four realistic scenarios:

1. **Version retirement.** The team sunsets `2024-01-15` — removes it from the `VersionBundle`, deploys the new build. Every account still pinned to `"2024-01-15"` is stale until they upgrade. Stripe themselves retire old versions eventually.
2. **Data seed / backfill drift.** An ops migration imports accounts from a legacy system with pin strings that don't match the current bundle — typos (`2024-1-15`), old formats (`v3` vs `2024-01-15`), or values from a different environment. Surfaces the first time those accounts make a call.
3. **Cross-environment pin drift.** Staging has `2025-06-01` in the bundle; production doesn't yet. A pin written in staging gets promoted to production and is stale until the production bundle catches up.
4. **Rollback.** Production deployed `2025-06-01`, accounts pinned to it (explicitly via `/versioning` or implicitly via `pinOnFirstResolve`). A regression was found, the team rolled back to a build without `2025-06-01`. All those accounts are now stale.

**Why tsadwyn doesn't auto-heal** (silently overwrite stale pins with the fallback):

- **Typos are bugs, not fixes.** If the stale pin is `2024-1-15` (missing a zero-pad), silently coercing to fallback hides the bug forever — the operator never finds out the source of the corruption and the wrong value gets normalized in.
- **Retirement-with-coercion violates the versioning contract.** A client who was explicitly pinned to `2024-01-15` made integration decisions based on that contract. Silently moving them to fallback means they wake up with responses they didn't sign up for.
- **Most consumers want to notice.** Operators generally want stale-pin events to page someone for investigation, not auto-silent-fixed. That's why the default is `onStalePin: 'fallback'` with a **warn** (via the logger) rather than an overwrite.
- **Healing is a consumer concern.** When you actually want to rewrite stale pins (e.g., you just retired v1 and want every v1 client upgraded to v2 next time they log in), that's a policy decision with business-specific rules. Do it in your own middleware or a scheduled task — with audit logging — not as a side-effect of a framework's default path.

**What tsadwyn does give you** via `perClientDefaultVersion.onStalePin`:

```ts
perClientDefaultVersion({
  // ...
  onStalePin: 'fallback',    // (default) use fallback + emit warn — SAFE, observable
  // onStalePin: 'passthrough',  // store the stale string; downstream picker decides
  // onStalePin: 'reject',       // throw — surfaces immediately as 500 (great in dev/CI)
  logger: pinoLogger,        // warns include { pin, clientId, supportedVersions }
});
```

Three modes + a structured log surface. When you decide to actually heal, you do it deliberately — a scheduled task that calls `saveVersion(clientId, targetVersion)` with whatever logic you want (upgrade to next-supported, force-pin to latest, flag the account for manual review, etc.). tsadwyn stays out of the write path.

For the common cases, `onStalePin: 'fallback'` + pino-style warn telemetry is usually enough: stale accounts keep getting served something reasonable, alerts page on-call when the warn rate is non-zero, the team investigates before reaching for the overwrite.

### Versioning error responses

Error responses (4xx / 5xx) **run response migrations by default** — tsadwyn's version-pin contract applies to error envelopes just as it does to successful responses, matching Stripe's actual behavior. An `errorMapper`-produced `HttpError` or a handler-thrown `HttpError` or an auto-generated `ValidationError` all flow through the same pipeline:

```ts
class AddErrorCode extends VersionChange {
  description = "v2 adds `code` to error bodies; v1 clients get just `message`";
  instructions = [];

  // Default migrateHttpErrors: true — migration fires on 4xx/5xx bodies too.
  migrate = convertResponseToPreviousVersionFor(MyErrorEnvelope)(
    (res: ResponseInfo) => {
      if (res.body?.code !== undefined) {
        delete res.body.code;         // legacy clients don't have the field
      }
    },
  );
}
```

**Defensive pattern.** Since a schema-targeted migration can now fire on error bodies whose shape may NOT match the schema (e.g., a `UserResource`-targeted migration running against `{detail: [...]}` validation envelope), migrations should null-check the fields they touch:

```ts
migrate = convertResponseToPreviousVersionFor(UserResource)(
  (res: ResponseInfo) => {
    if (res.body?.addresses) {        // ← null-check the field before mutating
      res.body.address = res.body.addresses[0];
      delete res.body.addresses;
    }
  },
);
```

**Opting out per-migration** — `{migrateHttpErrors: false}` when a migration should only apply to success-response bodies:

```ts
convertResponseToPreviousVersionFor(UserResource, { migrateHttpErrors: false })(
  transformer,   // runs on 2xx only — skips every 4xx/5xx
);
```

**Interaction with `errorMapper`.** Domain exceptions translated by `errorMapper` enter the same pipeline:

```
domain throw  →  errorMapper produces HttpError(status, body)
             →  response migrations apply to body (default: all of them,
                unless they pass migrateHttpErrors: false)
             →  client receives the version-migrated error envelope
```

`errorMapper` defines the **head-shape** error body; the response migrations down-shift that body for each client's pin. `ValidationError` (thrown automatically on Zod validation failures) flows through the exact same pipeline — consumers can reshape validation-error envelopes via either mechanism.

**The `headerOnly: true` cousin.** Some migrations only mutate `res.headers` (e.g., renaming an `x-rate-limit-*` header across versions). Flag those with `headerOnly: true` — they run on body-less responses (204, 304, HEAD requests, null handler returns) where body-mutating migrations would NPE on `undefined`. `headerOnly` and `migrateHttpErrors` are orthogonal: a migration can set both (runs everywhere) or just `headerOnly` (runs everywhere but only touches headers).

### Versioning behavior changes (not just schemas)

Schema migrations only cover **shape**: fields rename, types change, endpoints appear and disappear. The other half of API versioning is **behavior** — same shape, different side effects, policy, or semantics.

Real examples:

- v1 `POST /charges` captures funds immediately; v2 requires an explicit `/capture` follow-up
- v1's rate limit is 100 req/s; v2's is 1000 req/s on the same endpoints
- v1 `DELETE /users/:id` cascades to delete associated posts; v2 soft-deletes only
- v1 idempotency keys live 24h; v2 live 7 days
- v1 webhooks retry 3×; v2 retries 5× with exponential backoff

None of these show up in the request/response body — the shape is identical across versions. The difference is what the handler (or surrounding infrastructure) *does*. Your handlers need to branch on the caller's pinned version — but hard-coding `apiVersionStorage.getStore()` checks in every handler is the same sprawl pattern versioning was supposed to avoid.

tsadwyn ships two primitives for centralizing those branches. Use whichever matches the shape of the behavior change.

#### Pattern 1: `VersionChangeWithSideEffects.isApplied` — boolean toggles

Good for **on/off** behavior changes. A `VersionChangeWithSideEffects` subclass is a lint-trackable marker: the class is bound to a version, carries a description (so it lands in the changelog automatically), and exposes a static `isApplied` getter that returns true when the current request's version is at-or-newer-than the bound version.

```ts
import { VersionChangeWithSideEffects, VersionBundle, Version } from 'tsadwyn';

class SoftDeleteUsers extends VersionChangeWithSideEffects {
  description = "v2 soft-deletes users instead of cascading delete";
  instructions = [];  // pure behavior change — no schema instructions
}

const versions = new VersionBundle(
  new Version('2025-01-01', SoftDeleteUsers),
  new Version('2024-01-01'),
);

// Handler reads isApplied, not the raw version string:
router.delete('/users/:id', null, null, async (req) => {
  if (SoftDeleteUsers.isApplied) {
    await userRepo.softDelete(req.params.id);
  } else {
    await userRepo.deleteWithCascade(req.params.id);
  }
  return undefined;
});
```

**Why this over `if (apiVersionStorage.getStore() === '2025-01-01')`:**

- The comparison is **named and centralized**: one place in your codebase says "SoftDeleteUsers is the change at 2025-01-01," and every handler just asks `SoftDeleteUsers.isApplied`. Rename the version, don't touch the handlers.
- The change auto-documents: `description` lands in the changelog endpoint + generated OpenAPI.
- It's lint-grep-able: `git grep VersionChangeWithSideEffects` surfaces every behavior-level change at once.
- The `isApplied` getter enforces the "at-or-newer-than" semantic correctly — you don't hand-roll date comparisons per handler.

#### Pattern 2: `buildBehaviorResolver(map, fallback)` — map version → value

Good for **configurable values** that differ per version: rate limits, timeouts, retry counts, feature flags, field defaults. One resolver, many callsites, zero scattered comparisons.

```ts
import { buildBehaviorResolver } from 'tsadwyn';

// Define the map once, close to the other versioning concerns.
const getRateLimit = buildBehaviorResolver(
  new Map([
    ['2025-01-01', { perSecond: 1000, burst: 2000 }],
    ['2024-06-01', { perSecond: 500,  burst: 1000 }],
    ['2024-01-01', { perSecond: 100,  burst:  200 }],
  ]),
  { perSecond: 1000, burst: 2000 },  // fallback when version is unknown/absent
  { onUnknown: 'warn-once', logger: pinoLogger },  // optional telemetry
);

// Handlers and middleware read a value, never a version string:
router.use((req, res, next) => {
  const limit = getRateLimit();           // reads apiVersionStorage, returns the right config
  enforceRateLimit(req, limit);
  next();
});

router.post('/bulk-import', ..., async (req) => {
  const { burst } = getRateLimit();        // same resolver, different callsite
  // ...
});
```

**When `buildBehaviorResolver` beats `isApplied`:**

- The behavior has **more than two states** — e.g., three different rate limits across three versions
- You want to surface the per-version values in docs / admin UIs (`Object.fromEntries(map)` gives you the snapshot)
- A future version might want to introduce a new tier without touching every caller

**`onUnknown` telemetry** (`'silent'` / `'warn-once'` / `'warn-every'`) gives you a signal when a request shows up with a version the map doesn't know about — usually a typo'd header or a stale pin. The resolver returns `fallback` so the request still completes while the log alerts you.

#### Which to reach for

| Shape of the change | Reach for |
|---|---|
| One thing on; one thing off — "v2 does X differently" | `VersionChangeWithSideEffects.isApplied` |
| A value that changes per version (int, config object, feature flags) | `buildBehaviorResolver` |
| A behavior change that ALSO changes the wire shape | A regular `VersionChange` with migrations + `isApplied` in the handler |

Both primitives read from the same `apiVersionStorage` the request-dispatch pipeline writes — so whichever version a client resolved to (explicit header, `perClientDefaultVersion`, fallback) is what the behavior branches see. No extra wiring.

### Upgrade semantics — the `/versioning` resource (optional)

tsadwyn ships a pre-wired RESTful `/versioning` resource so consumers don't have to hand-roll the upgrade endpoint. It's **fully opt-in** — you don't have to mount it at all, and you don't have to use it if you do. If your API doesn't expose self-service upgrades (clients pin via an admin ticket, their signup config, etc.) just skip this section.

**tsadwyn owns no persistence.** Pinned versions live in whatever storage the consumer already has — an `api_version` column on the accounts table, a Redis key, an entry in a config service. The helper is a three-callback adapter:

- `identify(req)` — consumer's auth layer extracts the client id from the request
- `loadVersion(clientId)` — consumer reads their storage
- `saveVersion(clientId, version)` — consumer writes their storage

tsadwyn never sees the DB, doesn't ship a migration, doesn't assume a column name, and doesn't run SQL. If the consumer swaps Postgres for DynamoDB, only their callbacks change.

```ts
import { Tsadwyn, VersionBundle, createVersioningRoutes } from 'tsadwyn';

const versions = new VersionBundle(/* ... */);

const versioningRoutes = createVersioningRoutes({
  // path: '/versioning',                              // default
  identify:    req => (req as any).user?.accountId ?? null,
  loadVersion: accountId => accountRepo.getApiVersion(accountId),
  saveVersion: (accountId, v) => accountRepo.setApiVersion(accountId, v),
  supportedVersions: versions.versionValues,
  // allowDowngrade: false,                            // default
  // allowNoChange:  false,                            // default
  // compare:  'iso-date',                             // 'semver' | custom fn
});

const app = new Tsadwyn({ versions, preVersionPick: authMiddleware });
app.generateAndIncludeVersionedRouters(versioningRoutes, myDomainRoutes);
```

**Different persistence backends, same callbacks.** The helper doesn't care what's on the other side of `loadVersion` / `saveVersion`. Three common shapes:

```ts
// Postgres via a repo class — the shape we recommend when a dedicated
// api_version column fits on your existing accounts table.
createVersioningRoutes({
  identify:    req => req.user?.accountId ?? null,
  loadVersion: accountId => db.selectFrom('accounts')
                              .select('api_version')
                              .where('id', '=', accountId)
                              .executeTakeFirst().then(r => r?.api_version ?? null),
  saveVersion: (accountId, v) => db.updateTable('accounts')
                                   .set({ api_version: v })
                                   .where('id', '=', accountId)
                                   .execute().then(() => {}),
  supportedVersions: versions.versionValues,
});

// Redis — when the pin is a cache-layer concern or you're doing a
// side-car deployment before touching the primary DB schema.
createVersioningRoutes({
  identify:    req => req.user?.accountId ?? null,
  loadVersion: accountId => redis.get(`account:${accountId}:api_version`),
  saveVersion: (accountId, v) => redis.set(`account:${accountId}:api_version`, v).then(() => {}),
  supportedVersions: versions.versionValues,
});

// Remote config service — if your pins live in a separate account-service
// that your API calls out to. (Great fit for the warn-once logger pattern
// from perClientDefaultVersion too.)
createVersioningRoutes({
  identify:    req => req.user?.accountId ?? null,
  loadVersion: accountId => accountService.getApiVersion({ accountId }),
  saveVersion: (accountId, v) => accountService.setApiVersion({ accountId, version: v }),
  supportedVersions: versions.versionValues,
});
```

`async` / `Promise`-returning callbacks are awaited; sync-returning callbacks are treated as resolved. Throwing from a callback surfaces as 500 via the standard error pipeline (or as a structured `HttpError` if your `errorMapper` maps the underlying exception).

The resource:

| Method | Body | Success 200 | Failure |
|---|---|---|---|
| `GET /versioning` | — | `{version, supported[], latest}` | 401 unauthenticated |
| `POST /versioning` | `{from, to}` | `{previous_version, current_version}` | **409** `version_mismatch` (`from` ≠ stored), **400** `unsupported` / `downgrade-blocked` / `no-change`, **401** unauthenticated, **422** malformed body |

Two design decisions worth calling out:

**1. Optimistic concurrency via `{from, to}`.** The client reads their current pin with GET, then posts `{from: <current>, to: <target>}`. If another actor (an admin force-pin, a replicated DB converging) changed the stored pin in between, the server rejects with 409 rather than silently overwriting:

```json
{ "error": "version_mismatch", "expected": "2024-01-01", "actual": "2025-01-01" }
```

The client re-reads and decides whether to retry.

**2. First-upgrade convention.** A client who has never explicitly pinned reads `GET /versioning` and sees either:

- **`{version: null, ...}`** — when no `fallback` option is configured. The client is truly unpinned from tsadwyn's perspective.
- **`{version: <fallback>, ...}`** — when `fallback` is set (pass the same value you pass to `perClientDefaultVersion.fallback`). `GET /versioning` then reports the *effective* version tsadwyn would use at dispatch, so the resource shape and the runtime behavior stay in sync.

Either way, the first upgrade can pass either `from: null` OR `from: <fallback>` — they describe the same unpinned state:

```http
POST /versioning
{ "from": null, "to": "2024-06-01" }    # works when unpinned, no matter whether fallback is set
POST /versioning
{ "from": "2024-01-15", "to": "2024-06-01" }  # equivalent when fallback: "2024-01-15"

HTTP/1.1 200 OK
{ "previous_version": null, "current_version": "2024-06-01" }
```

When `fallback` is set, the first-upgrade also runs through the standard downgrade / no-change policy: `POST {from: "2024-01-15", to: "2024-01-15"}` against `fallback: "2024-01-15"` is 400 `no-change`, not 200, which matches what a second upgrade would do from that same starting point.

**Admin force-pin** (bypass the forward-only policy) is supported via `allowDowngrade: true`. The test suite covers this case. Typically the admin endpoint is a separate route that mounts its own version of `createVersioningRoutes({...allowDowngrade: true, identify: adminIdentify})` with a different auth scope.

If you need finer control than the helper provides, the underlying pieces — `validateVersionUpgrade` + `HttpError` — compose directly:

```ts
router.post('/versioning', UpgradeReq, UpgradeRes, async (req) => {
  const current = await accountRepo.getApiVersion(req.body.accountId);
  const decision = validateVersionUpgrade({
    current,
    target: req.body.target,
    supported: versions.versionValues,
  });
  if (!decision.ok) {
    throw new HttpError(400, { code: decision.reason, detail: decision.detail });
  }
  await accountRepo.setApiVersion(req.body.accountId, decision.next);
  return { previous_version: decision.previous, current_version: decision.next };
});
```

Forward-only upgrades are the Stripe convention — `allowDowngrade: true` is the admin escape hatch.

### Adopting tsadwyn incrementally alongside existing Express routes

You don't have to version your whole surface at once. tsadwyn mounts on an Express app with fall-through semantics — the versioned dispatcher catches its registered paths, and everything else passes through to the rest of your Express chain:

```ts
const expressApp = express();
expressApp.use(express.json());
expressApp.use(authMiddleware);

// tsadwyn handles the routes it owns
const versioned = new Tsadwyn({ versions: /* ... */ });
versioned.generateAndIncludeVersionedRouters(myVersionedRouter);
expressApp.use(versioned.expressApp);

// Existing unversioned routes still work — tsadwyn falls through on unregistered paths
expressApp.use(existingRouter);
```

**One landmine to watch for:** path-to-regexp is first-match-wins. If you register a parameterized route like `GET /widgets/:id` before a sibling literal `GET /widgets/archived` (whether in tsadwyn or upstream Express), the wildcard will shadow the literal silently. tsadwyn emits a generation-time warning when it detects this; register the literal first to fix.

For running examples of both patterns end-to-end, see [`examples/stripe-api.ts`](./examples/stripe-api.ts) (Stripe-style multi-version API) and [`examples/task-api.ts`](./examples/task-api.ts) (webhook versioning, CSV export via `raw()`, domain exceptions, `deletedResponseSchema`).

## API Reference

### Core

| Export | Description |
|--------|-------------|
| `Tsadwyn` | Main application class wrapping Express |
| `VersionedRouter` | Route collector with typed schema parameters |
| `Version` | A single API version declaration |
| `VersionBundle` | Bundle of all API versions (newest first) |
| `VersionChange` | Base class for version change declarations |

### Schema DSL

| Export | Description |
|--------|-------------|
| `schema(zodSchema)` | Entry point for schema alteration instructions |
| `.field(name).had({...})` | Field had different properties in previous version |
| `.field(name).didntExist` | Field did not exist in previous version |
| `.field(name).existedAs({type})` | Field existed with a different type |

### Migration Decorators

| Export | Description |
|--------|-------------|
| `convertRequestToNextVersionFor(Schema)` | Decorator for request migration |
| `convertResponseToPreviousVersionFor(Schema)` | Decorator for response migration |
| `RequestInfo` | Request context available in migration callbacks |
| `ResponseInfo` | Response context available in migration callbacks |

### Utilities

| Export | Description |
|--------|-------------|
| `getSchemaName(schema)` | Get the tsadwyn name from a Zod schema |
| `setSchemaName(schema, name)` | Set a tsadwyn name on a Zod schema |
| `apiVersionStorage` | AsyncLocalStorage holding the current version |
| `generateVersionedRouters` | Low-level router generation function |

### Error handling

| Export | Description |
|--------|-------------|
| `HttpError` | Throw from a handler to send a versionable error response (flows through `migrateHttpErrors: true` migrations) |
| `TsadwynOptions.errorMapper` | `(err) => HttpError \| null` invoked in the handler catch block before the HTTP-likeness check — translate domain exceptions into HTTP errors without coupling your domain layer |
| `exceptionMap(config)` | Declarative table form of `errorMapper` keyed by `err.name` (survives module-boundary identity drift) with introspection (`describe()`, `has`, `lookup`, `registeredNames`). Pass directly as `errorMapper`. |
| `exceptionMap.merge(a, b, …)` | Merge multiple configs; throws `TsadwynStructureError` on duplicate keys |
| `isExceptionMapFn(value)` | Type guard for introspectable mappers |

### Middleware & version resolution

| Export | Description |
|--------|-------------|
| `versionPickingMiddleware(options)` | Built-in middleware that extracts the version and runs the `apiVersionDefaultValue` resolver |
| `VersionPickingOptions.onUnsupportedVersion` | `'reject'` (400 with `{error, sent, supported}`) \| `'fallback'` (substitute default + warn) \| `'passthrough'` (default, stores verbatim) |
| `TsadwynOptions.preVersionPick` | Middleware that runs **before** `versionPickingMiddleware` — the place to put auth so `apiVersionDefaultValue` can read `req.user`. Scoped to versioned dispatch (utility endpoints bypass). |
| `perClientDefaultVersion(opts)` | Canonical DB-backed default resolver: `identify` extracts client id, `resolvePin` loads their version, `onStalePin` handles bundle evictions. Per-request WeakMap cache. Optional `pinOnFirstResolve: true` + `saveVersion` implements Stripe's "pin to current latest on the first authenticated call" behavior. |

### Helpers

| Export | Description |
|--------|-------------|
| `deletedResponseSchema(objectName, extraFields?)` | Stripe-style `{id, object, deleted: true}` schema for DELETE endpoints (use with `statusCode: 200` — 204 strips the body at the wire level per RFC 9110) |
| `raw({mimeType, supportsRanges?})` | Response-schema marker for binary/streaming routes; sets `Content-Type` at emission and marks response migrations targeting this route as dead code |
| `migratePayloadToVersion(schemaName, payload, targetVersion, versionBundle)` | Standalone payload reshaper — runs the same response migrations used in-flight against an outbound webhook payload for the destination client's pin |
| `buildBehaviorResolver(map, fallback, opts?)` | Resolve per-version behavior flags in handlers; reads from `apiVersionStorage`, optional `warn-once`/`warn-every` telemetry on unknown versions |
| `validateVersionUpgrade(args)` | Pure policy helper. Discriminated-union result (`{ok, previous, next}` \| `{ok: false, reason}`). Blocks downgrade + no-change by default; `allowDowngrade`/`allowNoChange` opt-outs; `iso-date` / `semver` / custom comparator. |
| `createVersioningRoutes(opts)` | Pre-wired `VersionedRouter` exposing the RESTful `/versioning` resource (GET + POST with optimistic concurrency). Wraps `validateVersionUpgrade` with identify/load/save callbacks so consumers don't hand-roll the endpoint. |
| `migrateResponseBody` | Standalone response migration utility (T-1701) |

### Route & handler options

| Export | Description |
|--------|-------------|
| `VersionedRouter.head(path, reqSchema, resSchema, handler, opts?)` | Explicit HEAD handler registration. Wins over Express's auto-mirror to GET. Pipeline skips response-body migrations on HEAD and emits no body at the wire (HEAD is body-less per HTTP spec). |
| `RouteOptions.tags: string[]` | OpenAPI tags for Swagger/ReDoc grouping — flow into `operation.tags`. Composes with `endpoint().had({tags})` across versions. |
| `RouteOptions.statusCode: number` | Override the emitted status code (default 200). Common: `201` for creates, `202` for async, `204` for truly body-less. |
| `ResponseMigrationOptions.migrateHttpErrors: true` | Migration also runs on 4xx/5xx error responses |
| `ResponseMigrationOptions.headerOnly: true` | Migration runs on body-less responses too (204, 304, null/undefined handler return) |

### Introspection (programmatic)

| Export | Description |
|--------|-------------|
| `dumpRouteTable(app, opts?)` | Enumerate registered routes per version; filter by method/path/visibility |
| `inspectMigrationChain(app, opts)` | Return the ordered migration chain for a schema + client version, direction `'request'` or `'response'` |
| `simulateRoute(app, opts)` | Simulate a request against the route table: matched route, every candidate with match reason, fallthrough diagnostics, migration chain summaries, up-migrated body preview |

### Generation-time lints (free, no opt-in)

tsadwyn warns at `generateAndIncludeVersionedRouters()` time on these common mistakes:

- Wildcard route registered before a sibling literal (`/users/:id` before `/users/archived`) — path-to-regexp is first-match-wins and the wildcard shadows the literal silently.
- `statusCode: 204` with a non-null `responseSchema` — Node strips the body at the wire level; body won't arrive at the client. Recommends `statusCode: 200` or `deletedResponseSchema()`.
- Body-mutating response migration targeting a 204/304 route without `headerOnly: true` — dead code (body is stripped).
- Response migration targeting a `raw()` route — dead code (body is opaque bytes, not JSON).
- Both `.get()` and `.head()` registered for the same path — Express auto-mirrors GET to HEAD; explicit HEAD is rarely intentional when GET also exists.
- Tags starting with `_TSADWYN` — reserved for internal bookkeeping.

## CLI

tsadwyn ships a small CLI for codegen and introspection. When the package is installed, the `tsadwyn` binary is available on your `PATH`; during development you can invoke it with `npx tsx src/cli.ts`.

```bash
tsadwyn --version            # prints the CLI version
tsadwyn -V                   # alias for --version
tsadwyn --help               # lists available commands
```

### `tsadwyn codegen --app <path>`

Loads a TypeScript/JavaScript module that exports a Tsadwyn application (either as `default` or as a named `app` export), triggers versioned-router generation, and prints a summary of the resulting versions and route counts.

```bash
tsadwyn codegen --app ./src/app.ts
```

If the module also exports a `routers` (or `versionedRouters`) value, it is forwarded to `generateAndIncludeVersionedRouters()`; otherwise the CLI assumes the module already called it at import time.

### `tsadwyn info --app <path>`

Prints structured information about an app's versions: the number of versions, a per-version route count, and a rollup of schemas touched by version changes. Useful for introspecting a deployed app or diffing versioned surface area in CI.

```bash
tsadwyn info --app ./src/app.ts
tsadwyn info --app ./src/app.ts --api-version 2024-11-01
tsadwyn info --app ./src/app.ts --json
```

Options:

| Flag | Description |
|------|-------------|
| `--app <path>` | Required. Path to the module exporting the Tsadwyn app. |
| `--api-version <value>` | Show info for a single API version only. Named `--api-version` (not `--version`) to avoid collision with the program's own `--version` flag. |
| `--json` | Emit a single JSON line instead of formatted text, suitable for piping through `jq`. |

tsadwyn's schemas are runtime Zod objects rather than source code, so `info` is the canonical way to introspect the versioned surface area of a deployed app.

### `tsadwyn routes --app <path>`

Enumerate the registered route table per version — complements `info` with per-route detail (handler name, schemas, tags, visibility). Useful for code review (`did this PR actually register the route?`), incident triage (`what's the v1 surface?`), and OpenAPI audit.

```bash
tsadwyn routes --app ./src/app.ts
tsadwyn routes --app ./src/app.ts --version 2025-01-01
tsadwyn routes --app ./src/app.ts --method POST --path-matches billing
tsadwyn routes --app ./src/app.ts --format json | jq '.[] | select(.deprecated)'
tsadwyn routes --app ./src/app.ts --include-private
```

| Flag | Description |
|------|-------------|
| `--app <path>` | Required. Path to the Tsadwyn app module. |
| `--version <value>` | Restrict output to one version. Default: all versions. |
| `--method <METHOD>` | Filter by HTTP method (case-insensitive). |
| `--path-matches <pattern>` | Filter by path — regex source or substring. |
| `--include-private` | Include routes with `includeInSchema: false`. |
| `--format <format>` | `table` (default) \| `json` \| `markdown`. |

### `tsadwyn migrations --app <path> --schema <name> --version <value>`

Show the ordered migration chain that fires for a given schema + client version. Answers "why is my v1 client receiving a v2-shape field?" without stepping through code.

```bash
# Response migrations (head → client) for UserResponse at 2024-01-01
tsadwyn migrations --app ./src/app.ts --schema UserResponse --version 2024-01-01

# Request direction (client → head)
tsadwyn migrations --app ./src/app.ts --schema UserCreateRequest --version 2024-01-01 --direction request

# JSON output for piping
tsadwyn migrations --app ./src/app.ts --schema UserResponse --version 2024-01-01 --format json
```

| Flag | Description |
|------|-------------|
| `--app <path>` | Required. |
| `--schema <name>` | Required. Schema name (set via `.named()`). |
| `--version <value>` | Required. Client pin version. |
| `--direction <dir>` | `response` (default) \| `request`. |
| `--path <path>` | Scope to a single path-based migration target. |
| `--method <method>` | Paired with `--path`. |
| `--no-error-migrations` | Exclude migrations with `migrateHttpErrors: true`. |
| `--format <format>` | `pipeline` (default) \| `json`. |

### `tsadwyn simulate --app <path> --method <M> --path <p>`

Simulate a request against the route table *without* dispatching. Answers "is tsadwyn responsible for this 4xx?" and "what migrations would fire?" in one command. Essential during incident triage.

```bash
# Matched route + candidates + migration chain
tsadwyn simulate --app ./src/app.ts \
  --method POST --path /api/virtual-accounts/abc/payout \
  --version 2025-06-01

# With body — get an up-migrated preview (head-shape body the handler sees)
tsadwyn simulate --app ./src/app.ts \
  --method POST --path /api/charges --version 2024-01-01 \
  --body '{"amount": 100}'

# JSON for piping
tsadwyn simulate --app ./src/app.ts --method GET --path /api/users/xyz \
  --version 2024-01-01 --format json
```

| Flag | Description |
|------|-------------|
| `--app <path>` | Required. |
| `--method <METHOD>` | Required. |
| `--path <path>` | Required. |
| `--version <value>` | API version. Explicit overrides headers/default. |
| `--body <json>` | Optional. Enables `upMigratedBody` preview. |
| `--format <format>` | `table` (default) \| `json`. |

### `tsadwyn exceptions --app <path>`

Introspect the configured `errorMapper`'s exception → HttpError table. Requires the app's mapper to be built via `exceptionMap()` (plain function mappers aren't introspectable).

```bash
tsadwyn exceptions --app ./src/app.ts
tsadwyn exceptions --app ./src/app.ts --format json | jq '.[] | select(.kind == "function")'
tsadwyn exceptions --app ./src/app.ts --filter '^Idempotency'
```

| Flag | Description |
|------|-------------|
| `--app <path>` | Required. |
| `--format <format>` | `table` (default) \| `json` \| `markdown`. |
| `--filter <regex>` | Filter entries by exception class name. |

### `tsadwyn new version --date <YYYY-MM-DD>`

Scaffolds a new `VersionChange` file for a breaking API change. The easiest way to answer "I need to make a breaking change — what do I type?"

```bash
# Empty scaffold — fill in the instructions yourself
tsadwyn new version --date 2024-12-01 --description "Rename payment_method to payment_source"

# Scaffold with a field rename pre-populated (both instruction and migration callbacks)
tsadwyn new version --date 2024-12-01 \
  --description "Rename payment_method to payment_source on charges" \
  --rename-field "ChargeResource.payment_source=payment_method"

# Scaffold with multiple changes
tsadwyn new version --date 2024-12-01 \
  --description "Remove legacy flag, add phone field" \
  --remove-field "UserResource.legacy_flag" \
  --add-field "UserResource.phone_number" \
  --remove-endpoint "DELETE /users/:id/legacy"

# Print without writing
tsadwyn new version --date 2024-12-01 --dry-run
```

**What it generates:** a TypeScript file at `./src/versions/<date>.ts` (configurable via `--dir`) containing:
- A `VersionChange` subclass with a derived PascalCase name (or `--name` override)
- Imports for `VersionChange`, any helpers you need (`schema`, `endpoint`, migration decorators), and placeholder schema imports
- The `instructions` array pre-populated with inline TODO comments
- Request and response migration callback stubs that correctly route data in both directions
- A "Next steps" block telling you exactly which line to add to your `VersionBundle`

**Rename convention:** `--rename-field "Schema.currentName=oldName"` means the field is currently called `currentName` in the head schema and was called `oldName` in the previous version. The generated request migration converts old clients' `oldName` → `currentName`, and the response migration rewrites the head's `currentName` → `oldName` for old clients.

**Add vs remove semantics:**
- `--add-field "Schema.field"` — the field is *new* in this version. The older version didn't have it. Generates `schema().field().didntExist` (no migration callback needed — Zod just drops unknown fields from responses going back to old clients).
- `--remove-field "Schema.field"` — the field was *removed* in this version. The older version still expects it. Generates `schema().field().existedAs({ type: z.unknown() })` plus a response migration stub where you need to supply a sensible default for the removed field.

**Endpoint semantics:** `--add-endpoint "METHOD /path"` and `--remove-endpoint "METHOD /path"` produce `endpoint().didntExist` / `endpoint().existed` instructions.

Options:

| Flag | Description |
|------|-------------|
| `--date <YYYY-MM-DD>` | Required. ISO date for the new version. |
| `--description <text>` | Human-readable description. Defaults to a TODO placeholder. |
| `--dir <path>` | Output directory. Default: `./src/versions`. |
| `--name <ClassName>` | Override the derived class name. |
| `--rename-field <spec>` | Pre-populate a field rename. Repeatable. |
| `--add-field <spec>` | Pre-populate a field addition. Repeatable. |
| `--remove-field <spec>` | Pre-populate a field removal. Repeatable. |
| `--add-endpoint <spec>` | Pre-populate an endpoint addition. Repeatable. |
| `--remove-endpoint <spec>` | Pre-populate an endpoint removal. Repeatable. |
| `--dry-run` | Print generated content without writing. |
| `--force` | Overwrite an existing file at the target path. |

After scaffolding, the CLI prints a "Next steps" box with the exact `import` and `new Version(...)` lines to add to your `VersionBundle`. tsadwyn does NOT auto-wire the VersionBundle for you — that's intentional, so you stay in control of your version ordering.

**Known limitation:** `--remove-field` emits `existedAs({ type: z.unknown() })` with a TODO comment because the CLI doesn't parse your source to infer the field's real Zod type. Fill it in manually with the correct type (e.g. `z.string()`, `z.number().int()`). A future release will parse your schemas file via the TypeScript compiler API to emit the exact type automatically. Same caveat applies to `--add-field` when generating a default-value callback.

## Development

Clone, install, test:

```bash
npm ci
npm test         # vitest run
npm run typecheck
npm run build
```

### Test pool

Vitest defaults to `pool: "forks"` in this repo because supertest-heavy suites are flaky under `threads` due to shared Node HTTP keep-alive parser state (~20–30% per-file flake rate observed vs. 0% with forks). To validate behavior under the threads pool anyway:

```bash
TSADWYN_TEST_POOL=threads npm test
```

Vitest will print a warning and run under the legacy pool. The standard `npx vitest run --pool=threads` CLI override also works and takes precedence over the env var.

## License

MIT
