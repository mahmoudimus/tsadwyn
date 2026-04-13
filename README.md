# tsadwyn

[![CI](https://github.com/mahmoudimus/tsadwyn/actions/workflows/ci.yml/badge.svg)](https://github.com/mahmoudimus/tsadwyn/actions/workflows/ci.yml)

Stripe-like API versioning for TypeScript/Express. tsadwyn enables you to maintain a single codebase that serves multiple API versions simultaneously. Instead of duplicating routes for each version, you define version changes declaratively and tsadwyn generates versioned routers with automatic request/response migration.

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

For deeper background on the head-first API versioning pattern, see the [concept docs](https://docs.cadwyn.dev/).

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

## License

MIT
