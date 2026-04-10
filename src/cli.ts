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
 *             default or named `app` export that is a Cadwyn instance, calls
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
import { resolve } from "node:path";

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
 * Extract the Cadwyn `app` instance from a loaded module, checking the default
 * export first and then the named `app` export.
 *
 * Returns `null` if the module does not export a Cadwyn app in either slot, or
 * if the exported value does not look like a Cadwyn instance (missing the
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
        "Error: Could not find a Cadwyn app export. " +
        "The module should have a default export or a named 'app' export.",
      );
      return { exitCode: 1, output };
    }

    if (typeof app.generateAndIncludeVersionedRouters !== "function") {
      output.push(
        "Error: The exported object does not appear to be a Cadwyn instance. " +
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
 * Build an InfoPayload from a Cadwyn app instance. Extracted from runInfo so
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
        "Error: Could not find a Cadwyn app export. " +
        "The module should have a default export or a named 'app' export " +
        "that is a Cadwyn instance.",
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
    .description("Generate versioned routers from a Cadwyn application module")
    .requiredOption("--app <path>", "Path to the module that exports the Cadwyn app")
    .action(async (options: CodegenOptions) => {
      const result = await runCodegen(options);
      emitResult(cmd, result, "tsadwyn.codegenFailed");
    });

  cmd
    .command("info")
    .description("Print structured info about the app's versions and routes")
    .requiredOption("--app <path>", "Path to the module that exports the Cadwyn app")
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
