#!/usr/bin/env node

/**
 * CLI tool for tsadwyn.
 *
 * Usage:
 *   npx tsadwyn codegen --app path/to/app.ts
 *   npx tsadwyn info --app path/to/app.ts
 *   npx tsadwyn --version
 *
 * Commands:
 *   codegen - Dynamically imports the module specified by --app, looks for a
 *             default or named `app` export that is a Tsadwyn instance, calls
 *             app.generateAndIncludeVersionedRouters() to trigger generation,
 *             and prints a summary of generated versions and routes.
 *
 *   info    - Prints structured information about the app's versions: version
 *             count, version list, route count per version, and a changelog
 *             summary. Accepts an optional `--version <value>` to scope output
 *             to a single version, and `--json` to emit JSON instead of text.
 */

import { Command, CommanderError } from "commander";
import { pathToFileURL } from "node:url";
import { resolve, join, dirname } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

import { isExceptionMapFn, type ExceptionMapEntry } from "./exception-map.js";
import { dumpRouteTable, type RouteTableEntry } from "./route-table.js";
import { inspectMigrationChain, type MigrationChainEntry } from "./migration-chain.js";
import { simulateRoute, type SimulationResult } from "./route-simulation.js";

/**
 * The version string reported by `tsadwyn --version` / `tsadwyn -V`.
 * Kept in sync with package.json's `version` field.
 */
export const CLI_VERSION = "0.1.0";

/**
 * Result of running a command handler. `output` contains the lines that should
 * be printed to the user (stdout-style messages plus error messages); callers
 * decide whether to route the lines to stdout, stderr, or a test buffer based
 * on `exitCode`.
 */
export interface CommandResult {
  exitCode: number;
  output: string[];
}

/**
 * Alternative command-result shape for subcommands that emit tabular/JSON
 * payloads and should distinguish between the primary output stream
 * (stdout — the rendered data) and diagnostic / error output (stderr).
 */
export interface StreamedCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Dynamically import a user's app module from the given path.
 *
 * Returns the imported module. Throws on I/O / resolution errors; callers
 * should catch and convert to a friendly error message.
 */
async function loadAppModule(appPath: string): Promise<any> {
  const modulePath = resolve(process.cwd(), appPath);
  const moduleUrl = pathToFileURL(modulePath).href;
  return await import(moduleUrl);
}

/**
 * Extract the Tsadwyn `app` instance from a loaded module, checking the default
 * export first and then the named `app` export.
 *
 * Returns `null` if the module does not export a Tsadwyn app in either slot, or
 * if the exported value does not look like a Tsadwyn instance (missing the
 * `generateAndIncludeVersionedRouters` method).
 */
function resolveAppInstance(mod: any): any | null {
  const app = mod?.default ?? mod?.app;
  if (!app) return null;
  if (typeof app.generateAndIncludeVersionedRouters !== "function") {
    return null;
  }
  return app;
}

/**
 * Options accepted by the `codegen` command.
 */
export interface CodegenOptions {
  app: string;
}

/**
 * Run the `codegen` command: load the user's app module, trigger versioned
 * router generation if needed, and return a summary of the generated routers.
 *
 * Returns `{ exitCode: 0, output }` on success, or `{ exitCode: 1, output }`
 * on failure. `output` is a list of human-readable lines; the CLI prints them
 * to stdout (success) or stderr (failure).
 */
export async function runCodegen(options: CodegenOptions): Promise<CommandResult> {
  const output: string[] = [];
  try {
    const modulePath = resolve(process.cwd(), options.app);
    output.push(`Loading module from: ${modulePath}`);

    const mod = await loadAppModule(options.app);

    const app = mod?.default ?? mod?.app;
    if (!app) {
      output.push(
        "Error: Could not find a Tsadwyn app export. " +
        "The module should have a default export or a named 'app' export.",
      );
      return { exitCode: 1, output };
    }

    if (typeof app.generateAndIncludeVersionedRouters !== "function") {
      output.push(
        "Error: The exported object does not appear to be a Tsadwyn instance. " +
        "It must have a generateAndIncludeVersionedRouters() method.",
      );
      return { exitCode: 1, output };
    }

    // Print the list of API versions from the bundle, if available.
    if (typeof app.versions?.versionValues !== "undefined") {
      const versionValues: string[] = app.versions.versionValues;
      output.push(`\nFound ${versionValues.length} API version(s):`);
      for (const v of versionValues) {
        output.push(`  - ${v}`);
      }
    }

    // If the module also exports routers, pass them to the generator. Otherwise
    // assume the module already called generateAndIncludeVersionedRouters() at
    // construction time.
    const routers = mod.routers ?? mod.versionedRouters;
    if (routers) {
      const routerArr = Array.isArray(routers) ? routers : [routers];
      app.generateAndIncludeVersionedRouters(...routerArr);
    } else if (app._pendingRouters) {
      app._performInitialization?.();
    }

    // Print a summary of the generated versioned routers.
    const versionedRouters: Map<string, any> = app._versionedRouters;
    if (versionedRouters && versionedRouters.size > 0) {
      output.push(`\nGenerated ${versionedRouters.size} versioned router(s).`);
      for (const [version, router] of versionedRouters) {
        const routeCount = router?.stack?.length ?? "unknown";
        output.push(`  Version ${version}: ${routeCount} route(s)`);
      }
    } else {
      output.push("\nNo versioned routers were generated.");
      output.push(
        "Make sure the module exports routers (as 'routers' or 'versionedRouters') " +
        "or calls generateAndIncludeVersionedRouters() before export.",
      );
    }

    output.push("\nCode generation complete.");
    return { exitCode: 0, output };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.push(`Error during code generation: ${message}`);
    return { exitCode: 1, output };
  }
}

/**
 * Options accepted by the `info` command.
 */
export interface InfoOptions {
  app: string;
  version?: string;
  json?: boolean;
}

/**
 * Structured info payload printed by the `info` command when `--json` is used.
 * Also used internally to format the plaintext output.
 */
export interface InfoPayload {
  versions: Array<{
    value: string;
    isLatest: boolean;
    isOldest: boolean;
    routeCount: number | null;
    changeCount: number;
  }>;
  totalVersions: number;
  totalSchemas: number;
  totalChanges: number;
}

/**
 * Build an InfoPayload from a Tsadwyn app instance. Extracted from runInfo so
 * the rendering logic can be unit-tested independently of module loading.
 */
function buildInfoPayload(app: any, onlyVersion?: string): InfoPayload {
  const versionValues: string[] = app.versions?.versionValues ?? [];
  const versionedRouters: Map<string, any> | undefined = app._versionedRouters;

  const payload: InfoPayload = {
    versions: [],
    totalVersions: versionValues.length,
    totalSchemas: 0,
    totalChanges: 0,
  };

  // Best-effort schema + change counting. Swallow errors so `info` never
  // crashes just because an exotic app is missing a field.
  try {
    const versions = app.versions?.versions ?? [];
    const schemaNames = new Set<string>();
    for (const version of versions) {
      for (const change of version.changes ?? []) {
        payload.totalChanges++;
        for (const instr of change._alterSchemaInstructions ?? []) {
          const name = instr?.schemaName;
          if (typeof name === "string") schemaNames.add(name);
        }
      }
    }
    payload.totalSchemas = schemaNames.size;
  } catch {
    // Ignore introspection failures.
  }

  for (let i = 0; i < versionValues.length; i++) {
    const value = versionValues[i];
    if (onlyVersion !== undefined && value !== onlyVersion) continue;

    const router = versionedRouters?.get(value);
    const routeCount = router?.stack?.length ?? null;

    let changeCount = 0;
    const versionObj = app.versions?.versions?.[i];
    if (versionObj && Array.isArray(versionObj.changes)) {
      changeCount = versionObj.changes.length;
    }

    payload.versions.push({
      value,
      isLatest: i === 0,
      isOldest: i === versionValues.length - 1,
      routeCount,
      changeCount,
    });
  }

  return payload;
}

/**
 * Render an InfoPayload as plaintext output lines.
 */
function renderInfoPayload(payload: InfoPayload): string[] {
  const lines: string[] = [];
  lines.push("tsadwyn info");
  lines.push("============");
  lines.push(`Versions: ${payload.totalVersions}`);
  for (const v of payload.versions) {
    const tag = v.isLatest
      ? " (latest)"
      : v.isOldest
        ? " (oldest)"
        : "";
    const routes = v.routeCount === null ? "unknown" : `${v.routeCount}`;
    lines.push(`  ${v.value}${tag} - ${routes} route(s), ${v.changeCount} change(s)`);
  }
  lines.push("");
  lines.push(`Schemas: ${payload.totalSchemas}`);
  lines.push(`Total version changes: ${payload.totalChanges}`);
  return lines;
}

/**
 * Run the `info` command: load the user's app module and print a structured
 * summary of its versions, routes, and schemas. When `options.version` is set,
 * only that version is included. When `options.json` is true, emit a single
 * JSON line instead of formatted text.
 *
 * Returns `{ exitCode: 0, output }` on success and `{ exitCode: 1, output }`
 * on failure.
 */
export async function runInfo(options: InfoOptions): Promise<CommandResult> {
  const output: string[] = [];
  try {
    const mod = await loadAppModule(options.app);
    const app = resolveAppInstance(mod);

    if (!app) {
      output.push(
        "Error: Could not find a Tsadwyn app export. " +
        "The module should have a default export or a named 'app' export " +
        "that is a Tsadwyn instance.",
      );
      return { exitCode: 1, output };
    }

    // Ensure lazy initialization has run so _versionedRouters is populated.
    if (app._pendingRouters && typeof app._performInitialization === "function") {
      try {
        app._performInitialization();
      } catch {
        // Ignore — info should still work on partially-initialized apps.
      }
    }

    // Validate --version if provided.
    if (options.version !== undefined) {
      const knownVersions: string[] = app.versions?.versionValues ?? [];
      if (!knownVersions.includes(options.version)) {
        output.push(
          `Error: Unknown version "${options.version}". ` +
          `Available versions: ${knownVersions.join(", ") || "(none)"}`,
        );
        return { exitCode: 1, output };
      }
    }

    const payload = buildInfoPayload(app, options.version);

    if (options.json) {
      output.push(JSON.stringify(payload));
    } else {
      output.push(...renderInfoPayload(payload));
    }

    return { exitCode: 0, output };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.push(`Error during info lookup: ${message}`);
    return { exitCode: 1, output };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// `new version` command — scaffold a new VersionChange file
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A single field rename parsed from `--rename-field Schema.currentName=oldName` flags.
 * `currentName` is the name in the head (latest) schema; `oldName` is what the
 * field was called in the previous version.
 */
interface RenameFieldSpec {
  schema: string;
  /** The name in the head (latest) schema. */
  currentName: string;
  /** The name in the previous (older) version. */
  oldName: string;
}

/**
 * A single field addition/removal parsed from `--add-field Schema.name` /
 * `--remove-field Schema.name`. The semantic is from the perspective of the
 * new version: "add" means head gained the field (older version didn't have it),
 * "remove" means head dropped the field (older version kept it).
 */
interface FieldSpec {
  schema: string;
  field: string;
}

/**
 * A single endpoint addition/removal parsed from
 * `--add-endpoint "METHOD /path"` / `--remove-endpoint "METHOD /path"`.
 */
interface EndpointSpec {
  method: string;
  path: string;
}

/**
 * Options accepted by the `new version` command.
 */
export interface NewVersionOptions {
  /** Date string (YYYY-MM-DD) for the new version. */
  date: string;
  /** Human-readable description of what changed. */
  description?: string;
  /** Output directory for the new file (default: `./src/versions`). */
  dir?: string;
  /** Class name for the VersionChange subclass (default: auto-derived). */
  name?: string;
  /** Field rename specs: "Schema.old=new". */
  renameField?: string[];
  /** Field addition specs: "Schema.field" (head added, old version didn't have). */
  addField?: string[];
  /** Field removal specs: "Schema.field" (head removed, old version had). */
  removeField?: string[];
  /** Endpoint addition specs: "METHOD /path" (head added, old version didn't have). */
  addEndpoint?: string[];
  /** Endpoint removal specs: "METHOD /path" (head removed, old version had). */
  removeEndpoint?: string[];
  /** Print the generated content without writing to disk. */
  dryRun?: boolean;
  /** Overwrite existing file if present. */
  force?: boolean;
}

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const VALID_HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/**
 * Parse a "Schema.currentName=oldName" rename spec.
 * LHS is the name in the head schema (current), RHS is the name in the previous version.
 */
function parseRenameFieldSpec(spec: string): RenameFieldSpec | null {
  const [left, right] = spec.split("=", 2);
  if (!left || !right) return null;
  const dotIdx = left.indexOf(".");
  if (dotIdx < 0) return null;
  const schema = left.slice(0, dotIdx).trim();
  const currentName = left.slice(dotIdx + 1).trim();
  const oldName = right.trim();
  if (!schema || !currentName || !oldName) return null;
  return { schema, currentName, oldName };
}

/**
 * Parse a "Schema.field" spec.
 */
function parseFieldSpec(spec: string): FieldSpec | null {
  const dotIdx = spec.indexOf(".");
  if (dotIdx < 0) return null;
  const schema = spec.slice(0, dotIdx).trim();
  const field = spec.slice(dotIdx + 1).trim();
  if (!schema || !field) return null;
  return { schema, field };
}

/**
 * Parse a "METHOD /path" spec.
 */
function parseEndpointSpec(spec: string): EndpointSpec | null {
  const match = spec.trim().match(/^([A-Za-z]+)\s+(\S+)$/);
  if (!match) return null;
  const method = match[1].toUpperCase();
  if (!VALID_HTTP_METHODS.has(method)) return null;
  return { method, path: match[2] };
}

/**
 * Convert a date + optional name into a valid TypeScript class name.
 * Example: "2024-12-01" -> "V20241201Change"
 *          "2024-12-01" + "Rename payment_method" -> "RenamePaymentMethod"
 */
function deriveClassName(date: string, explicitName?: string, description?: string): string {
  if (explicitName) {
    // Ensure first character is a letter
    const cleaned = explicitName.replace(/[^A-Za-z0-9]/g, "");
    if (cleaned && /^[A-Za-z]/.test(cleaned)) return cleaned;
    return `V${cleaned || date.replace(/-/g, "")}Change`;
  }
  if (description) {
    // PascalCase from description, max 40 chars
    const words = description
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0 && !/^\d/.test(w))
      .slice(0, 6);
    if (words.length > 0) {
      return words.map((w) => w[0].toUpperCase() + w.slice(1)).join("");
    }
  }
  return `V${date.replace(/-/g, "")}Change`;
}

/**
 * Collect all unique schema names referenced across all field specs so we
 * can emit a single import statement for the user to fill in.
 */
function collectSchemaNames(
  renames: RenameFieldSpec[],
  adds: FieldSpec[],
  removes: FieldSpec[],
): string[] {
  const set = new Set<string>();
  for (const r of renames) set.add(r.schema);
  for (const a of adds) set.add(a.schema);
  for (const r of removes) set.add(r.schema);
  return [...set].sort();
}

/**
 * Generate the TypeScript source for a new VersionChange file. Pure function —
 * no file I/O — so it can be tested independently.
 */
export function generateVersionChangeSource(
  options: NewVersionOptions,
): { className: string; source: string } {
  const date = options.date;
  const description =
    options.description ?? `TODO: describe what changed in version ${date}`;
  const className = deriveClassName(date, options.name, options.description);

  const renames = (options.renameField ?? [])
    .map(parseRenameFieldSpec)
    .filter((s): s is RenameFieldSpec => s !== null);
  const adds = (options.addField ?? [])
    .map(parseFieldSpec)
    .filter((s): s is FieldSpec => s !== null);
  const removes = (options.removeField ?? [])
    .map(parseFieldSpec)
    .filter((s): s is FieldSpec => s !== null);
  const addEndpoints = (options.addEndpoint ?? [])
    .map(parseEndpointSpec)
    .filter((s): s is EndpointSpec => s !== null);
  const removeEndpoints = (options.removeEndpoint ?? [])
    .map(parseEndpointSpec)
    .filter((s): s is EndpointSpec => s !== null);

  const schemaNames = collectSchemaNames(renames, adds, removes);
  const hasSchemaInstructions =
    renames.length > 0 || adds.length > 0 || removes.length > 0;
  const hasEndpointInstructions =
    addEndpoints.length > 0 || removeEndpoints.length > 0;
  const hasAnyInstructions = hasSchemaInstructions || hasEndpointInstructions;
  const hasMigrationCallbacks = renames.length > 0 || removes.length > 0;

  const tsadwynImports: string[] = [
    "VersionChange",
  ];
  if (hasSchemaInstructions) tsadwynImports.push("schema");
  if (hasEndpointInstructions) tsadwynImports.push("endpoint");
  if (hasMigrationCallbacks) {
    tsadwynImports.push(
      "convertRequestToNextVersionFor",
      "convertResponseToPreviousVersionFor",
      "RequestInfo",
      "ResponseInfo",
    );
  }

  const lines: string[] = [];

  lines.push(`/**`);
  lines.push(` * Version ${date}`);
  lines.push(` *`);
  const descLines = description.split("\n");
  for (const dl of descLines) lines.push(` * ${dl}`);
  lines.push(` *`);
  lines.push(` * Next steps:`);
  lines.push(` *   1. Fill in the migration instructions and callbacks below.`);
  lines.push(` *   2. Import this class in your VersionBundle file.`);
  lines.push(` *   3. Add \`new Version("${date}", ${className})\` to the bundle`);
  lines.push(` *      (newest version first).`);
  lines.push(` */`);
  lines.push(`import { ${tsadwynImports.join(", ")} } from "tsadwyn";`);

  if (schemaNames.length > 0) {
    lines.push(
      `import { ${schemaNames.join(", ")} } from "../schemas.js"; // TODO: adjust import path`,
    );
  }
  if (hasMigrationCallbacks) {
    lines.push(`import { z } from "zod";`);
  }
  lines.push(``);

  lines.push(`export class ${className} extends VersionChange {`);
  lines.push(`  description = ${JSON.stringify(description)};`);
  lines.push(``);

  if (hasAnyInstructions) {
    lines.push(`  instructions = [`);
    for (const r of renames) {
      lines.push(
        `    // In the previous version, ${r.schema}.${r.currentName} was called "${r.oldName}".`,
      );
      lines.push(
        `    schema(${r.schema}).field(${JSON.stringify(r.currentName)}).had({ name: ${JSON.stringify(r.oldName)} }),`,
      );
    }
    for (const a of adds) {
      lines.push(
        `    // ${a.schema}.${a.field} is new in this version — the previous version did not have it.`,
      );
      lines.push(
        `    schema(${a.schema}).field(${JSON.stringify(a.field)}).didntExist,`,
      );
    }
    for (const r of removes) {
      lines.push(
        `    // ${r.schema}.${r.field} was removed in this version — the previous version had it.`,
      );
      lines.push(
        `    // TODO: replace z.unknown() with the actual Zod type the field used to have.`,
      );
      lines.push(
        `    schema(${r.schema}).field(${JSON.stringify(r.field)}).existedAs({ type: z.unknown() }),`,
      );
    }
    for (const e of addEndpoints) {
      lines.push(
        `    // ${e.method} ${e.path} is new in this version — the previous version did not have it.`,
      );
      lines.push(
        `    endpoint(${JSON.stringify(e.path)}, [${JSON.stringify(e.method)}]).didntExist,`,
      );
    }
    for (const e of removeEndpoints) {
      lines.push(
        `    // ${e.method} ${e.path} was removed in this version — the previous version had it.`,
      );
      lines.push(
        `    endpoint(${JSON.stringify(e.path)}, [${JSON.stringify(e.method)}]).existed,`,
      );
    }
    lines.push(`  ];`);
  } else {
    lines.push(`  instructions = [`);
    lines.push(`    // TODO: add schema() / endpoint() instructions here.`);
    lines.push(`    //   schema(MySchema).field("name").had({ name: "oldName" }),`);
    lines.push(`    //   endpoint("/users/:id", ["DELETE"]).didntExist,`);
    lines.push(`  ];`);
  }
  lines.push(``);

  // Emit migration callback stubs for each rename.
  // The old version uses `oldName`; the head (latest) version uses `currentName`.
  // Request migration: old client sends `oldName` -> rename to `currentName` for the handler.
  // Response migration: handler returns `currentName` -> rename back to `oldName` for the old client.
  for (const r of renames) {
    const sanitize = (s: string) => s.replace(/[^A-Za-z0-9]/g, "_");
    const methodSuffix = `${sanitize(r.schema)}_${sanitize(r.currentName)}`;
    lines.push(`  // Request migration: old version sends "${r.oldName}", rename to "${r.currentName}".`);
    lines.push(`  migrateRequest_${methodSuffix} = convertRequestToNextVersionFor(${r.schema})(`);
    lines.push(`    (request: RequestInfo) => {`);
    lines.push(`      if (${JSON.stringify(r.oldName)} in request.body) {`);
    lines.push(`        request.body[${JSON.stringify(r.currentName)}] = request.body[${JSON.stringify(r.oldName)}];`);
    lines.push(`        delete request.body[${JSON.stringify(r.oldName)}];`);
    lines.push(`      }`);
    lines.push(`    },`);
    lines.push(`  );`);
    lines.push(``);
    lines.push(`  // Response migration: head returns "${r.currentName}", rename back to "${r.oldName}" for old version.`);
    lines.push(`  migrateResponse_${methodSuffix} = convertResponseToPreviousVersionFor(${r.schema})(`);
    lines.push(`    (response: ResponseInfo) => {`);
    lines.push(`      if (${JSON.stringify(r.currentName)} in response.body) {`);
    lines.push(`        response.body[${JSON.stringify(r.oldName)}] = response.body[${JSON.stringify(r.currentName)}];`);
    lines.push(`        delete response.body[${JSON.stringify(r.currentName)}];`);
    lines.push(`      }`);
    lines.push(`    },`);
    lines.push(`  );`);
    lines.push(``);
  }

  for (const r of removes) {
    const sanitize = (s: string) => s.replace(/[^A-Za-z0-9]/g, "_");
    const methodSuffix = `${sanitize(r.schema)}_${sanitize(r.field)}`;
    lines.push(`  // Response migration: head dropped ${r.field}, but old version still expects it.`);
    lines.push(`  // TODO: compute a sensible value for ${r.field} from the remaining response fields.`);
    lines.push(`  migrateResponse_${methodSuffix} = convertResponseToPreviousVersionFor(${r.schema})(`);
    lines.push(`    (response: ResponseInfo) => {`);
    lines.push(`      response.body[${JSON.stringify(r.field)}] = null; // TODO: replace with real value`);
    lines.push(`    },`);
    lines.push(`  );`);
    lines.push(``);
  }

  lines.push(`}`);
  lines.push(``);

  return { className, source: lines.join("\n") };
}

/**
 * Run the `new version` command: scaffold a new VersionChange file.
 *
 * Writes to disk unless `dryRun` is set. Returns a CommandResult whose output
 * includes the generated file path and next-step instructions.
 */
export async function runNewVersion(options: NewVersionOptions): Promise<CommandResult> {
  const output: string[] = [];

  // Validate date
  if (!options.date || !ISO_DATE_REGEX.test(options.date)) {
    output.push(
      `Error: --date must be an ISO date string (YYYY-MM-DD). Got: "${options.date ?? "(missing)"}"`,
    );
    return { exitCode: 1, output };
  }

  // Validate any rename/add/remove/endpoint specs early so users get clear errors
  for (const spec of options.renameField ?? []) {
    if (!parseRenameFieldSpec(spec)) {
      output.push(
        `Error: --rename-field must be "Schema.currentName=oldName" ` +
        `(e.g. "ChargeResource.payment_source=payment_method"). Got: "${spec}"`,
      );
      return { exitCode: 1, output };
    }
  }
  for (const spec of options.addField ?? []) {
    if (!parseFieldSpec(spec)) {
      output.push(`Error: --add-field must be "Schema.field". Got: "${spec}"`);
      return { exitCode: 1, output };
    }
  }
  for (const spec of options.removeField ?? []) {
    if (!parseFieldSpec(spec)) {
      output.push(`Error: --remove-field must be "Schema.field". Got: "${spec}"`);
      return { exitCode: 1, output };
    }
  }
  for (const spec of options.addEndpoint ?? []) {
    if (!parseEndpointSpec(spec)) {
      output.push(
        `Error: --add-endpoint must be "METHOD /path" (e.g. "POST /users"). Got: "${spec}"`,
      );
      return { exitCode: 1, output };
    }
  }
  for (const spec of options.removeEndpoint ?? []) {
    if (!parseEndpointSpec(spec)) {
      output.push(
        `Error: --remove-endpoint must be "METHOD /path" (e.g. "DELETE /users/:id"). Got: "${spec}"`,
      );
      return { exitCode: 1, output };
    }
  }

  const { className, source } = generateVersionChangeSource(options);
  const dir = options.dir ?? "./src/versions";
  const absDir = resolve(process.cwd(), dir);
  const absFile = join(absDir, `${options.date}.ts`);
  const relFile = join(dir, `${options.date}.ts`);

  if (options.dryRun) {
    output.push(`# Dry run — file would be written to: ${relFile}`);
    output.push(`# Class name: ${className}`);
    output.push(``);
    output.push(source);
    return { exitCode: 0, output };
  }

  // Check for existing file
  if (existsSync(absFile) && !options.force) {
    output.push(
      `Error: File already exists at ${relFile}. Use --force to overwrite.`,
    );
    return { exitCode: 1, output };
  }

  // Create directory if missing
  try {
    if (!existsSync(absDir)) {
      mkdirSync(absDir, { recursive: true });
      output.push(`Created directory: ${dir}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.push(`Error creating directory ${dir}: ${message}`);
    return { exitCode: 1, output };
  }

  // Write file
  try {
    writeFileSync(absFile, source, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.push(`Error writing file ${relFile}: ${message}`);
    return { exitCode: 1, output };
  }

  output.push(`Created new version file: ${relFile}`);
  output.push(``);
  output.push(`Next steps:`);
  output.push(`  1. Edit ${relFile} to fill in the migration details.`);
  output.push(`  2. In your VersionBundle file, add the import:`);
  output.push(`       import { ${className} } from "./versions/${options.date}.js";`);
  output.push(`  3. Add the new Version to your VersionBundle (newest first):`);
  output.push(`       new VersionBundle(`);
  output.push(`         new Version("${options.date}", ${className}),   // <-- add this line`);
  output.push(`         // ... existing versions ...`);
  output.push(`       )`);
  output.push(``);
  output.push(`Remember: tsadwyn versions are sorted newest-first.`);

  return { exitCode: 0, output };
}

/**
 * Pipe a CommandResult's output lines through a Commander command, writing to
 * stdout on success and stderr on failure. On failure, throw a CommanderError
 * so that parseAsync() rejects (or process exits, depending on the caller's
 * exitOverride configuration). Commander provides default writeOut/writeErr
 * sinks that target process.stdout/stderr, so no fallback is needed.
 */
function emitResult(cmd: Command, result: CommandResult, errorCode: string): void {
  const { writeOut, writeErr } = cmd.configureOutput() as {
    writeOut: (s: string) => void;
    writeErr: (s: string) => void;
  };
  const sink = result.exitCode === 0 ? writeOut : writeErr;
  for (const line of result.output) {
    sink(line + "\n");
  }
  if (result.exitCode !== 0) {
    throw new CommanderError(result.exitCode, errorCode, "command failed");
  }
}

// ─────────────────────────────────────────────────────────────────────────
// `routes` — enumerate the registered route table per version
// ─────────────────────────────────────────────────────────────────────────

export interface RoutesOptions {
  app: string;
  version?: string;
  method?: string;
  pathMatches?: string;
  includePrivate?: boolean;
  format?: "table" | "json" | "markdown";
}

function renderRouteTable(
  entries: ReadonlyArray<RouteTableEntry>,
  format: "table" | "json" | "markdown",
): string {
  if (format === "json") return JSON.stringify(entries, null, 2);

  const rows = entries.map((e) => ({
    version: e.version,
    method: e.method,
    path: e.path,
    handler: e.handlerName ?? "<anonymous>",
    status: String(e.statusCode),
    response: e.responseSchemaName ?? "-",
  }));
  const headers = ["Version", "Method", "Path", "Handler", "Status", "Response"];

  if (format === "markdown") {
    const lines: string[] = [];
    lines.push(`| ${headers.join(" | ")} |`);
    lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
    for (const r of rows) {
      lines.push(
        `| ${r.version} | ${r.method} | ${r.path} | ${r.handler} | ${r.status} | ${r.response} |`,
      );
    }
    return lines.join("\n");
  }

  const cols = [
    { key: "version", label: headers[0] },
    { key: "method", label: headers[1] },
    { key: "path", label: headers[2] },
    { key: "handler", label: headers[3] },
    { key: "status", label: headers[4] },
    { key: "response", label: headers[5] },
  ] as const;
  const widths = cols.map((c) =>
    Math.max(c.label.length, ...rows.map((r) => (r as any)[c.key].length)),
  );
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  const sep = "+-" + widths.map((w) => "-".repeat(w)).join("-+-") + "-+";
  const render = (values: string[]) =>
    "| " + values.map((v, i) => pad(v, widths[i])).join(" | ") + " |";

  const lines: string[] = [];
  lines.push(`Routes (${entries.length})`);
  lines.push("");
  lines.push(sep);
  lines.push(render(cols.map((c) => c.label)));
  lines.push(sep);
  for (const r of rows) {
    lines.push(render(cols.map((c) => (r as any)[c.key])));
  }
  lines.push(sep);
  return lines.join("\n");
}

export async function runRoutes(
  options: RoutesOptions,
): Promise<StreamedCommandResult> {
  const format = options.format ?? "table";
  try {
    const mod = await loadAppModule(options.app);
    const app = resolveAppInstance(mod);
    if (!app) {
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          "Error: Could not find a Tsadwyn app export. " +
          "The module should have a default export or a named 'app' export.",
      };
    }
    // Trigger initialization if needed so _versionedRoutes is populated.
    const routers = mod.routers ?? mod.versionedRouters;
    if (routers) {
      const routerArr = Array.isArray(routers) ? routers : [routers];
      app.generateAndIncludeVersionedRouters(...routerArr);
    } else if (app._pendingRouters) {
      app._performInitialization?.();
    }

    const entries = dumpRouteTable(app, {
      version: options.version,
      method: options.method,
      pathMatches: options.pathMatches,
      includePrivate: options.includePrivate ?? false,
    });

    return {
      exitCode: 0,
      stdout: renderRouteTable(entries, format),
      stderr: "",
    };
  } catch (err) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Error in routes command: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// `migrations` — inspect the migration chain for a schema + client version
// ─────────────────────────────────────────────────────────────────────────

export interface MigrationsOptions {
  app: string;
  schema: string;
  version: string;
  direction?: "request" | "response";
  path?: string;
  method?: string;
  includeErrorMigrations?: boolean;
  format?: "pipeline" | "json";
}

function renderMigrationChain(
  entries: ReadonlyArray<MigrationChainEntry>,
  direction: "request" | "response",
  clientVersion: string,
  schemaName: string,
  format: "pipeline" | "json",
): string {
  if (format === "json") return JSON.stringify(entries, null, 2);

  const lines: string[] = [];
  lines.push(`Schema: ${schemaName}`);
  lines.push(`Direction: ${direction} (${direction === "response" ? "head → client" : "client → head"})`);
  lines.push(`Client version: ${clientVersion}`);
  lines.push("");
  if (entries.length === 0) {
    lines.push("No migrations in chain.");
    return lines.join("\n");
  }
  for (const entry of entries) {
    lines.push(
      `  ↓ ${entry.version} — ${entry.changeClassName}.${entry.functionName} (${entry.kind}${
        entry.migrateHttpErrors ? ", migrateHttpErrors" : ""
      })`,
    );
  }
  lines.push("");
  lines.push(`${entries.length} migration(s) in chain.`);
  return lines.join("\n");
}

export async function runMigrations(
  options: MigrationsOptions,
): Promise<StreamedCommandResult> {
  const format = options.format ?? "pipeline";
  const direction = options.direction ?? "response";
  try {
    const mod = await loadAppModule(options.app);
    const app = resolveAppInstance(mod);
    if (!app) {
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          "Error: Could not find a Tsadwyn app export. " +
          "The module should have a default export or a named 'app' export.",
      };
    }
    const routers = mod.routers ?? mod.versionedRouters;
    if (routers) {
      const routerArr = Array.isArray(routers) ? routers : [routers];
      app.generateAndIncludeVersionedRouters(...routerArr);
    } else if (app._pendingRouters) {
      app._performInitialization?.();
    }

    const entries = inspectMigrationChain(app, {
      schemaName: options.schema,
      clientVersion: options.version,
      direction,
      path: options.path,
      method: options.method,
      includeErrorMigrations: options.includeErrorMigrations,
    });

    return {
      exitCode: 0,
      stdout: renderMigrationChain(
        entries,
        direction,
        options.version,
        options.schema,
        format,
      ),
      stderr: "",
    };
  } catch (err) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Error in migrations command: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// `simulate` — simulate a request against the route table
// ─────────────────────────────────────────────────────────────────────────

export interface SimulateOptions {
  app: string;
  method: string;
  path: string;
  version?: string;
  body?: string;
  format?: "table" | "json";
}

function renderSimulation(
  result: SimulationResult,
  format: "table" | "json",
): string {
  if (format === "json") return JSON.stringify(result, null, 2);

  const lines: string[] = [];
  lines.push(`Resolved version: ${result.resolvedVersion}`);
  lines.push("");
  if (result.matchedRoute) {
    lines.push(
      `Matched route: [${result.matchedRoute.method}] ${result.matchedRoute.path}`,
    );
    if (Object.keys(result.matchedRoute.params).length > 0) {
      lines.push(`  params: ${JSON.stringify(result.matchedRoute.params)}`);
    }
    lines.push(`  handler: ${result.matchedRoute.handler}`);
    if (result.matchedRoute.schemaName) {
      lines.push(`  response schema: ${result.matchedRoute.schemaName}`);
    }
  } else {
    lines.push("Matched route: (none — request would fall through)");
  }
  lines.push("");
  lines.push("Candidates:");
  for (const c of result.candidates) {
    const mark = c.matched ? "✓" : "✗";
    lines.push(`  ${mark} [${c.method}] ${c.path}  — ${c.reason}`);
  }
  if (result.fallthrough) {
    lines.push("");
    lines.push("Fallthrough:");
    lines.push(`  reason: ${result.fallthrough.reason}`);
    if (result.fallthrough.availableAtOtherVersions.length > 0) {
      lines.push(
        `  available at other versions: ${result.fallthrough.availableAtOtherVersions.join(", ")}`,
      );
    }
  }
  if (result.requestMigrations.length > 0) {
    lines.push("");
    lines.push("Request migrations:");
    for (const m of result.requestMigrations) {
      lines.push(`  ${m.fromVersion} → ${m.toVersion}  (${m.schemaName ?? m.path})`);
    }
  }
  if (result.responseMigrations.length > 0) {
    lines.push("");
    lines.push("Response migrations:");
    for (const m of result.responseMigrations) {
      lines.push(`  ${m.fromVersion} → ${m.toVersion}  (${m.schemaName ?? m.path})`);
    }
  }
  if (result.upMigratedBody !== undefined) {
    lines.push("");
    lines.push(`Up-migrated body: ${JSON.stringify(result.upMigratedBody)}`);
  }
  return lines.join("\n");
}

export async function runSimulate(
  options: SimulateOptions,
): Promise<StreamedCommandResult> {
  const format = options.format ?? "table";
  if (!options.method) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "Error: --method is required for tsadwyn simulate.",
    };
  }
  if (!options.path) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "Error: --path is required for tsadwyn simulate.",
    };
  }
  try {
    const mod = await loadAppModule(options.app);
    const app = resolveAppInstance(mod);
    if (!app) {
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          "Error: Could not find a Tsadwyn app export. " +
          "The module should have a default export or a named 'app' export.",
      };
    }
    const routers = mod.routers ?? mod.versionedRouters;
    if (routers) {
      const routerArr = Array.isArray(routers) ? routers : [routers];
      app.generateAndIncludeVersionedRouters(...routerArr);
    } else if (app._pendingRouters) {
      app._performInitialization?.();
    }

    let parsedBody: unknown = undefined;
    if (options.body) {
      try {
        parsedBody = JSON.parse(options.body);
      } catch {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `Error: --body is not valid JSON: ${options.body}`,
        };
      }
    }

    const result = simulateRoute(app, {
      method: options.method,
      path: options.path,
      version: options.version,
      body: parsedBody,
    });

    return {
      exitCode: 0,
      stdout: renderSimulation(result, format),
      stderr: "",
    };
  } catch (err) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Error in simulate command: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// `exceptions` — introspect the configured errorMapper's exception table
// ─────────────────────────────────────────────────────────────────────────

/**
 * Options accepted by the `exceptions` command.
 */
export interface ExceptionsOptions {
  app: string;
  format?: "table" | "json" | "markdown";
  filter?: string;
}

/**
 * Render an array of ExceptionMapEntry as a formatted output string per the
 * requested format. Extracted for unit testing.
 */
function renderExceptionsTable(
  entries: ReadonlyArray<ExceptionMapEntry>,
  format: "table" | "json" | "markdown",
): string {
  if (format === "json") {
    return JSON.stringify(entries, null, 2);
  }

  const rows = entries.map((e) => ({
    name: e.name,
    kind: e.kind,
    status: e.status === null ? "(dyn)" : String(e.status),
    code: e.code === null ? "(dyn)" : e.code,
    transform: e.hasTransform ? "yes" : "no",
  }));

  const headers = ["Exception name", "Kind", "Status", "Code", "Transform?"];

  if (format === "markdown") {
    const lines: string[] = [];
    lines.push(
      `| ${headers.join(" | ")} |`,
      `| ${headers.map(() => "---").join(" | ")} |`,
    );
    for (const r of rows) {
      lines.push(
        `| ${r.name} | ${r.kind} | ${r.status} | ${r.code} | ${r.transform} |`,
      );
    }
    return lines.join("\n");
  }

  // ASCII table
  const cols = [
    { key: "name", label: headers[0] },
    { key: "kind", label: headers[1] },
    { key: "status", label: headers[2] },
    { key: "code", label: headers[3] },
    { key: "transform", label: headers[4] },
  ] as const;
  const widths = cols.map((c) =>
    Math.max(c.label.length, ...rows.map((r) => (r as any)[c.key].length)),
  );
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  const sep =
    "+-" + widths.map((w) => "-".repeat(w)).join("-+-") + "-+";
  const render = (values: string[]) =>
    "| " + values.map((v, i) => pad(v, widths[i])).join(" | ") + " |";

  const lines: string[] = [];
  lines.push(`Exception mappings (${entries.length} registered)`);
  lines.push("");
  lines.push(sep);
  lines.push(render(cols.map((c) => c.label)));
  lines.push(sep);
  for (const r of rows) {
    lines.push(render(cols.map((c) => (r as any)[c.key])));
  }
  lines.push(sep);
  return lines.join("\n");
}

/**
 * Run the `exceptions` command: load the user's app, look up the configured
 * errorMapper, and if it's an introspectable ExceptionMapFn (produced by
 * `exceptionMap()`), render its table in the requested format.
 *
 * Returns `{stdout, stderr, exitCode}`. Unlike `runCodegen` / `runInfo`, the
 * rendered table is the primary stdout artifact; diagnostic messages go to
 * stderr. Non-zero exit when the app has no introspectable mapper.
 */
export async function runExceptions(
  options: ExceptionsOptions,
): Promise<StreamedCommandResult> {
  const format = options.format ?? "table";
  try {
    const mod = await loadAppModule(options.app);
    const app = resolveAppInstance(mod);
    if (!app) {
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          "Error: Could not find a Tsadwyn app export. " +
          "The module should have a default export or a named 'app' export.",
      };
    }
    const mapper = app._errorMapper;
    if (!mapper) {
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          "Error: the loaded app does not have an errorMapper configured. " +
          "`tsadwyn exceptions` requires an introspectable errorMapper built via `exceptionMap()`.",
      };
    }
    if (!isExceptionMapFn(mapper)) {
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          "Error: the configured errorMapper is a plain function, not an introspectable ExceptionMapFn. " +
          "Wrap your mapping with `exceptionMap()` to enable `tsadwyn exceptions` introspection.",
      };
    }

    let entries = mapper.describe();
    if (options.filter) {
      const regex = new RegExp(options.filter);
      entries = entries.filter((e) => regex.test(e.name));
    }

    return {
      exitCode: 0,
      stdout: renderExceptionsTable(entries, format),
      stderr: "",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Error in exceptions command: ${message}`,
    };
  }
}

/**
 * Construct a fresh `Command` with every tsadwyn subcommand registered.
 *
 * A factory is exposed (in addition to the singleton `program`) so that tests
 * can obtain a clean program per test case — Commander's internal state
 * (seen-options, exit-override flags, output configuration, etc.) is
 * per-instance, and reusing one instance across tests leaks state.
 */
export function createProgram(): Command {
  const cmd = new Command();

  cmd
    .name("tsadwyn")
    .description("Stripe-like API versioning framework for TypeScript/Express")
    .version(CLI_VERSION, "-V, --version", "output the current version");

  cmd
    .command("codegen")
    .description("Generate versioned routers from a Tsadwyn application module")
    .requiredOption("--app <path>", "Path to the module that exports the Tsadwyn app")
    .action(async (options: CodegenOptions) => {
      const result = await runCodegen(options);
      emitResult(cmd, result, "tsadwyn.codegenFailed");
    });

  cmd
    .command("info")
    .description("Print structured info about the app's versions and routes")
    .requiredOption("--app <path>", "Path to the module that exports the Tsadwyn app")
    .option(
      "--api-version <value>",
      "Show info for a single API version only (use this instead of --version " +
      "to avoid collision with the program's --version flag)",
    )
    .option("--json", "Emit output as JSON instead of formatted text")
    .action(async (options: { app: string; apiVersion?: string; json?: boolean }) => {
      const result = await runInfo({
        app: options.app,
        version: options.apiVersion,
        json: options.json,
      });
      emitResult(cmd, result, "tsadwyn.infoFailed");
    });

  cmd
    .command("exceptions")
    .description(
      "Introspect the configured errorMapper's exception→HttpError table. " +
        "Requires the app's errorMapper to be produced by `exceptionMap()`.",
    )
    .requiredOption("--app <path>", "Path to the module that exports the Tsadwyn app")
    .option("--format <format>", "Output format: table (default) | json | markdown", "table")
    .option("--filter <regex>", "Filter entries by name (regex)")
    .action(async (options: ExceptionsOptions) => {
      const result = await runExceptions(options);
      if (result.stdout) process.stdout.write(result.stdout + "\n");
      if (result.stderr) process.stderr.write(result.stderr + "\n");
      if (result.exitCode !== 0) {
        throw new CommanderError(
          result.exitCode,
          "tsadwyn.exceptionsFailed",
          result.stderr || "exceptions command failed",
        );
      }
    });

  cmd
    .command("routes")
    .description("Enumerate the registered route table per version.")
    .requiredOption("--app <path>", "Path to the module that exports the Tsadwyn app")
    .option("--version <value>", "Filter to a single API version")
    .option("--method <METHOD>", "Filter by HTTP method (case-insensitive)")
    .option("--path-matches <pattern>", "Filter by path — regex source or substring")
    .option("--include-private", "Include routes with includeInSchema: false")
    .option("--format <format>", "Output format: table (default) | json | markdown", "table")
    .action(async (options: RoutesOptions) => {
      const result = await runRoutes(options);
      if (result.stdout) process.stdout.write(result.stdout + "\n");
      if (result.stderr) process.stderr.write(result.stderr + "\n");
      if (result.exitCode !== 0) {
        throw new CommanderError(
          result.exitCode,
          "tsadwyn.routesFailed",
          result.stderr || "routes command failed",
        );
      }
    });

  cmd
    .command("migrations")
    .description(
      "Inspect the request or response migration chain for a schema at a client version.",
    )
    .requiredOption("--app <path>", "Path to the module that exports the Tsadwyn app")
    .requiredOption("--schema <name>", "Schema name (as set via .named())")
    .requiredOption("--version <value>", "Client API version")
    .option("--direction <dir>", "response (default) | request", "response")
    .option("--path <path>", "Scope to a single path-based migration target")
    .option("--method <method>", "Paired with --path")
    .option(
      "--no-error-migrations",
      "Exclude migrations with migrateHttpErrors: true",
    )
    .option("--format <format>", "Output format: pipeline (default) | json", "pipeline")
    .action(
      async (options: MigrationsOptions & { errorMigrations?: boolean }) => {
        const result = await runMigrations({
          ...options,
          includeErrorMigrations: options.errorMigrations !== false,
        });
        if (result.stdout) process.stdout.write(result.stdout + "\n");
        if (result.stderr) process.stderr.write(result.stderr + "\n");
        if (result.exitCode !== 0) {
          throw new CommanderError(
            result.exitCode,
            "tsadwyn.migrationsFailed",
            result.stderr || "migrations command failed",
          );
        }
      },
    );

  cmd
    .command("simulate")
    .description(
      "Simulate a request against the route table: matched route, candidates, " +
        "migration chains, and up-migrated body preview.",
    )
    .requiredOption("--app <path>", "Path to the module that exports the Tsadwyn app")
    .requiredOption("--method <METHOD>", "HTTP method of the simulated request")
    .requiredOption("--path <path>", "Request path")
    .option("--version <value>", "API version (explicit overrides headers/default)")
    .option("--body <json>", "Request body as a JSON string")
    .option("--format <format>", "Output format: table (default) | json", "table")
    .action(async (options: SimulateOptions) => {
      const result = await runSimulate(options);
      if (result.stdout) process.stdout.write(result.stdout + "\n");
      if (result.stderr) process.stderr.write(result.stderr + "\n");
      if (result.exitCode !== 0) {
        throw new CommanderError(
          result.exitCode,
          "tsadwyn.simulateFailed",
          result.stderr || "simulate command failed",
        );
      }
    });

  // ─────────────────────────────────────────────────────────────────────
  // `new` — scaffolding subcommands
  // ─────────────────────────────────────────────────────────────────────
  const newCmd = cmd
    .command("new")
    .description("Scaffold new tsadwyn resources");

  newCmd
    .command("version")
    .description(
      "Scaffold a new VersionChange file for a breaking API change. " +
      "Creates a ready-to-edit TypeScript file with imports, class structure, " +
      "and optional pre-populated migration instructions.",
    )
    .requiredOption("--date <YYYY-MM-DD>", "ISO date for the new version")
    .option("--description <text>", "Human-readable description of what changed")
    .option("--dir <path>", "Output directory for the generated file", "./src/versions")
    .option("--name <ClassName>", "Override the VersionChange class name")
    .option(
      "--rename-field <spec>",
      'Pre-populate a field rename: "Schema.newName=oldName" — ' +
      "the field is currently called 'newName' in the head schema and was called 'oldName' in the previous version. " +
      "Can be repeated.",
      (value: string, previous: string[] | undefined) => (previous ?? []).concat([value]),
    )
    .option(
      "--add-field <spec>",
      'Pre-populate a field addition: "Schema.field" — ' +
      "the field is new in this version (previous version did not have it). Can be repeated.",
      (value: string, previous: string[] | undefined) => (previous ?? []).concat([value]),
    )
    .option(
      "--remove-field <spec>",
      'Pre-populate a field removal: "Schema.field" — ' +
      "the field was removed in this version (previous version had it). Can be repeated.",
      (value: string, previous: string[] | undefined) => (previous ?? []).concat([value]),
    )
    .option(
      "--add-endpoint <spec>",
      'Pre-populate an endpoint addition: "METHOD /path" (e.g. "POST /users"). ' +
      "Endpoint is new in this version. Can be repeated.",
      (value: string, previous: string[] | undefined) => (previous ?? []).concat([value]),
    )
    .option(
      "--remove-endpoint <spec>",
      'Pre-populate an endpoint removal: "METHOD /path" (e.g. "DELETE /users/:id"). ' +
      "Endpoint was removed in this version. Can be repeated.",
      (value: string, previous: string[] | undefined) => (previous ?? []).concat([value]),
    )
    .option("--dry-run", "Print the generated file content without writing to disk")
    .option("--force", "Overwrite an existing file at the target path")
    .action(async (options: NewVersionOptions) => {
      const result = await runNewVersion(options);
      emitResult(cmd, result, "tsadwyn.newVersionFailed");
    });

  return cmd;
}

/**
 * The default singleton program instance. Kept as a named export for
 * backwards compatibility and for CLI-as-script use.
 */
export const program: Command = createProgram();

/**
 * Determine whether the current module is the entrypoint (i.e. being executed
 * directly via `node dist/cli.js` or `tsx src/cli.ts`), as opposed to being
 * imported by tests or library code.
 *
 * We compare the basename of `process.argv[1]` to the expected CLI entry
 * filenames (`cli.js`, `cli.cjs`, `cli.mjs`, `cli.ts`) since `import.meta`
 * cannot be used in files that compile to CommonJS. The vitest runner loads
 * this file via its test runner binary, so `argv[1]` does not match any of
 * those names and the guard correctly returns `false` at import time.
 */
export function isMainModule(): boolean {
  try {
    if (typeof process === "undefined" || !process.argv?.[1]) return false;
    return /[\\/]cli\.(c|m)?(j|t)s$/.test(process.argv[1]);
  } catch {
    return false;
  }
}

// Only parse argv when this file is executed directly, not when it is imported
// by the test suite. The bootstrap block below cannot execute under vitest
// (argv[1] is the vitest runner), so any uncovered statements within it are
// expected.
if (isMainModule()) {
  program.parseAsync(process.argv).catch((err) => {
    process.stderr.write(`${(err as Error).message ?? err}\n`);
    process.exit(1);
  });
}
