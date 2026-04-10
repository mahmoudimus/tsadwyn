import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  createProgram,
  runCodegen,
  runInfo,
  program as defaultProgram,
  CLI_VERSION,
  isMainModule,
} from "../src/cli.js";
import type { Command } from "commander";

// --- Fixture paths ---

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "fixtures");

const HAPPY_APP = resolve(FIXTURES, "cli-happy-app.ts");
const NAMED_APP = resolve(FIXTURES, "cli-named-app.ts");
const NO_APP = resolve(FIXTURES, "cli-no-app.ts");
const BAD_APP = resolve(FIXTURES, "cli-bad-app.ts");
const THROWING_APP = resolve(FIXTURES, "cli-throwing-app.ts");
const PENDING_APP = resolve(FIXTURES, "cli-pending-app.ts");
const PENDING_INFO_APP = resolve(FIXTURES, "cli-pending-info-app.ts");
const EMPTY_APP = resolve(FIXTURES, "cli-empty-app.ts");
const THREE_VERSION_APP = resolve(FIXTURES, "cli-three-version-app.ts");
const SINGLE_ROUTER_APP = resolve(FIXTURES, "cli-single-router-app.ts");
const DUCK_APP = resolve(FIXTURES, "cli-duck-app.ts");

// --- Test helpers ---

interface RunResult {
  stdout: string[];
  stderr: string[];
  error?: { code?: string; exitCode?: number; message?: string };
}

/**
 * Execute a command against a fresh program instance with exitOverride() and
 * output capture. The returned `error` is populated when parseAsync rejects
 * (which happens for --version, --help, and any command that ends in a
 * CommanderError when exitOverride is active).
 */
async function runProgram(argv: string[]): Promise<RunResult> {
  const prog = createProgram();
  const stdout: string[] = [];
  const stderr: string[] = [];
  prog.exitOverride();
  prog.configureOutput({
    writeOut: (s) => stdout.push(s),
    writeErr: (s) => stderr.push(s),
  });
  // Apply the same config to every subcommand so that CommanderError output
  // (missing required option, etc.) is also captured.
  for (const sub of prog.commands) {
    sub.exitOverride();
    sub.configureOutput({
      writeOut: (s) => stdout.push(s),
      writeErr: (s) => stderr.push(s),
    });
  }

  try {
    await prog.parseAsync(argv);
    return { stdout, stderr };
  } catch (err: any) {
    return {
      stdout,
      stderr,
      error: {
        code: err?.code,
        exitCode: err?.exitCode,
        message: err?.message,
      },
    };
  }
}

function joined(lines: string[]): string {
  return lines.join("");
}

// --- Section 1: --version / -V ---

describe("CLI: --version / -V", () => {
  it("prints the CLI version with --version", async () => {
    const res = await runProgram(["node", "tsadwyn", "--version"]);
    expect(res.error?.code).toBe("commander.version");
    expect(joined(res.stdout)).toContain(CLI_VERSION);
  });

  it("prints the CLI version with the -V alias", async () => {
    const res = await runProgram(["node", "tsadwyn", "-V"]);
    expect(res.error?.code).toBe("commander.version");
    expect(joined(res.stdout)).toContain(CLI_VERSION);
  });

  it("exposes CLI_VERSION as a stable constant", () => {
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("exports a singleton program configured with version/codegen/info", () => {
    const names = defaultProgram.commands.map((c: Command) => c.name());
    expect(names).toContain("codegen");
    expect(names).toContain("info");
  });
});

// --- Section 2: --help ---

describe("CLI: --help", () => {
  it("root --help lists both subcommands and Usage", async () => {
    const res = await runProgram(["node", "tsadwyn", "--help"]);
    expect(res.error?.code).toBe("commander.helpDisplayed");
    const combined = joined(res.stdout) + joined(res.stderr);
    expect(combined).toContain("Usage:");
    expect(combined).toContain("codegen");
    expect(combined).toContain("info");
  });

  it("codegen --help documents --app", async () => {
    const res = await runProgram(["node", "tsadwyn", "codegen", "--help"]);
    expect(res.error?.code).toBe("commander.helpDisplayed");
    const combined = joined(res.stdout) + joined(res.stderr);
    expect(combined).toContain("--app");
  });

  it("info --help documents --app, --api-version, and --json", async () => {
    const res = await runProgram(["node", "tsadwyn", "info", "--help"]);
    expect(res.error?.code).toBe("commander.helpDisplayed");
    const combined = joined(res.stdout) + joined(res.stderr);
    expect(combined).toContain("--app");
    expect(combined).toContain("--api-version");
    expect(combined).toContain("--json");
  });
});

// --- Section 3: codegen happy path ---

describe("CLI: runCodegen happy path", () => {
  it("loads a default-export Cadwyn app and prints version + router summary", async () => {
    const result = await runCodegen({ app: HAPPY_APP });
    expect(result.exitCode).toBe(0);
    const text = result.output.join("\n");
    expect(text).toContain("Loading module from:");
    expect(text).toContain("Found 2 API version(s)");
    expect(text).toContain("2001-01-01");
    expect(text).toContain("2000-01-01");
    expect(text).toContain("Generated 2 versioned router(s).");
    expect(text).toContain("Code generation complete.");
  });

  it("loads a named `app` export and forwards `routers`", async () => {
    const result = await runCodegen({ app: NAMED_APP });
    expect(result.exitCode).toBe(0);
    const text = result.output.join("\n");
    expect(text).toContain("Found 1 API version(s)");
    expect(text).toContain("2020-01-01");
    expect(text).toContain("Generated 1 versioned router(s).");
  });

  it("runs via the CLI program with --app and succeeds", async () => {
    const res = await runProgram(["node", "tsadwyn", "codegen", "--app", HAPPY_APP]);
    expect(res.error).toBeUndefined();
    expect(joined(res.stdout)).toContain("Code generation complete.");
  });

  it("initializes a pending app via _performInitialization", async () => {
    const result = await runCodegen({ app: PENDING_APP });
    expect(result.exitCode).toBe(0);
    const text = result.output.join("\n");
    expect(text).toContain("Found 1 API version(s)");
    expect(text).toContain("Generated 1 versioned router(s).");
  });

  it("reports no versioned routers for an empty app", async () => {
    const result = await runCodegen({ app: EMPTY_APP });
    expect(result.exitCode).toBe(0);
    const text = result.output.join("\n");
    expect(text).toContain("No versioned routers were generated.");
    expect(text).toContain("Code generation complete.");
  });

  it("normalizes a non-array `routers` export to a single-element array", async () => {
    const result = await runCodegen({ app: SINGLE_ROUTER_APP });
    expect(result.exitCode).toBe(0);
    const text = result.output.join("\n");
    expect(text).toContain("Found 1 API version(s)");
    expect(text).toContain("Generated 1 versioned router(s).");
  });

  it("handles a duck-typed app and prints 'unknown' for routers without a stack", async () => {
    const result = await runCodegen({ app: DUCK_APP });
    expect(result.exitCode).toBe(0);
    const text = result.output.join("\n");
    // versions.versionValues is present, so "Found 2 API version(s)" fires.
    expect(text).toContain("Found 2 API version(s)");
    // duck-version-a's router has no stack -> "unknown" route count.
    expect(text).toContain("Version duck-version-a: unknown route(s)");
    expect(text).toContain("Version duck-version-b: 2 route(s)");
  });
});

// --- Section 4: codegen error handling ---

describe("CLI: runCodegen error handling", () => {
  it("rejects when --app is missing", async () => {
    const res = await runProgram(["node", "tsadwyn", "codegen"]);
    expect(res.error?.code).toBe("commander.missingMandatoryOptionValue");
  });

  it("returns exit code 1 and an error line for a nonexistent module", async () => {
    const result = await runCodegen({ app: "/nonexistent/does-not-exist.ts" });
    expect(result.exitCode).toBe(1);
    const text = result.output.join("\n");
    expect(text).toMatch(/Error during code generation/);
  });

  it("returns exit code 1 when the module exports no app", async () => {
    const result = await runCodegen({ app: NO_APP });
    expect(result.exitCode).toBe(1);
    const text = result.output.join("\n");
    expect(text).toContain("Could not find a Cadwyn app export");
  });

  it("returns exit code 1 when the export is not a Cadwyn instance", async () => {
    const result = await runCodegen({ app: BAD_APP });
    expect(result.exitCode).toBe(1);
    const text = result.output.join("\n");
    expect(text).toContain("does not appear to be a Cadwyn instance");
  });

  it("returns exit code 1 when the module throws at import time", async () => {
    const result = await runCodegen({ app: THROWING_APP });
    expect(result.exitCode).toBe(1);
    const text = result.output.join("\n");
    expect(text).toContain("Error during code generation");
    expect(text).toContain("kaboom from cli-throwing-app");
  });

  it("routes codegen failure through the CLI and writes to stderr", async () => {
    const res = await runProgram([
      "node",
      "tsadwyn",
      "codegen",
      "--app",
      NO_APP,
    ]);
    expect(res.error?.exitCode).toBe(1);
    expect(res.error?.code).toBe("tsadwyn.codegenFailed");
    expect(joined(res.stderr)).toContain("Could not find a Cadwyn app export");
  });
});

// --- Section 5: info happy path ---

describe("CLI: runInfo happy path", () => {
  it("prints a plaintext version summary for a default-export app", async () => {
    const result = await runInfo({ app: HAPPY_APP });
    expect(result.exitCode).toBe(0);
    const text = result.output.join("\n");
    expect(text).toContain("tsadwyn info");
    expect(text).toContain("Versions: 2");
    expect(text).toContain("2001-01-01");
    expect(text).toContain("(latest)");
    expect(text).toContain("2000-01-01");
    expect(text).toContain("(oldest)");
    expect(text).toContain("Schemas:");
    expect(text).toContain("Total version changes:");
  });

  it("emits valid JSON with --json", async () => {
    const result = await runInfo({ app: HAPPY_APP, json: true });
    expect(result.exitCode).toBe(0);
    expect(result.output).toHaveLength(1);
    const parsed = JSON.parse(result.output[0]);
    expect(parsed.totalVersions).toBe(2);
    expect(parsed.versions).toHaveLength(2);
    expect(parsed.versions[0].value).toBe("2001-01-01");
    expect(parsed.versions[0].isLatest).toBe(true);
    expect(parsed.versions[1].isOldest).toBe(true);
    // Route count should be populated now that the app is initialized.
    expect(typeof parsed.versions[0].routeCount).toBe("number");
    expect(parsed.totalSchemas).toBeGreaterThanOrEqual(1);
    expect(parsed.totalChanges).toBeGreaterThanOrEqual(1);
  });

  it("scopes output to a single version with --version", async () => {
    const result = await runInfo({ app: HAPPY_APP, version: "2000-01-01" });
    expect(result.exitCode).toBe(0);
    const text = result.output.join("\n");
    expect(text).toContain("2000-01-01");
    // 2001-01-01 should not appear as a bulleted version row.
    const bulletLines = result.output.filter((l) => l.startsWith("  2001"));
    expect(bulletLines).toHaveLength(0);
  });

  it("scopes JSON output to a single version with --version and --json", async () => {
    const result = await runInfo({
      app: HAPPY_APP,
      version: "2000-01-01",
      json: true,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output[0]);
    expect(parsed.versions).toHaveLength(1);
    expect(parsed.versions[0].value).toBe("2000-01-01");
    expect(parsed.versions[0].isOldest).toBe(true);
  });

  it("handles a named `app` export with a single version", async () => {
    const result = await runInfo({ app: NAMED_APP });
    expect(result.exitCode).toBe(0);
    const text = result.output.join("\n");
    expect(text).toContain("Versions: 1");
    expect(text).toContain("2020-01-01");
    // Single-version apps should still mark the version as latest.
    expect(text).toContain("(latest)");
  });

  it("runs via the CLI program with --app --json and succeeds", async () => {
    const res = await runProgram([
      "node",
      "tsadwyn",
      "info",
      "--app",
      HAPPY_APP,
      "--json",
    ]);
    expect(res.error).toBeUndefined();
    const payload = JSON.parse(joined(res.stdout).trim());
    expect(payload.totalVersions).toBe(2);
  });

  it("runs via the CLI program with --api-version scoping", async () => {
    const res = await runProgram([
      "node",
      "tsadwyn",
      "info",
      "--app",
      HAPPY_APP,
      "--api-version",
      "2000-01-01",
      "--json",
    ]);
    expect(res.error).toBeUndefined();
    const payload = JSON.parse(joined(res.stdout).trim());
    expect(payload.versions).toHaveLength(1);
    expect(payload.versions[0].value).toBe("2000-01-01");
  });

  it("reports all three rows with latest/oldest/middle tags for a 3-version app", async () => {
    const result = await runInfo({ app: THREE_VERSION_APP });
    expect(result.exitCode).toBe(0);
    const text = result.output.join("\n");
    expect(text).toContain("Versions: 3");
    expect(text).toContain("2003-01-01 (latest)");
    expect(text).toContain("2001-01-01 (oldest)");
    // Middle version should have no latest/oldest tag.
    const middleLine = result.output.find((l) =>
      l.includes("2002-01-01"),
    );
    expect(middleLine).toBeDefined();
    expect(middleLine).not.toContain("(latest)");
    expect(middleLine).not.toContain("(oldest)");
  });

  it("initializes a pending app in runInfo", async () => {
    const result = await runInfo({ app: PENDING_INFO_APP, json: true });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.output[0]);
    expect(payload.totalVersions).toBe(1);
    // After init, routeCount is populated.
    expect(payload.versions[0].routeCount).toBe(1);
  });

  it("reports null routeCount for an app without generated routers", async () => {
    const result = await runInfo({ app: EMPTY_APP, json: true });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.output[0]);
    expect(payload.totalVersions).toBe(1);
    // No router generated, so routeCount is null.
    expect(payload.versions[0].routeCount).toBeNull();
  });

  it("renders 'unknown' route count and tolerates missing changes metadata", async () => {
    const result = await runInfo({ app: DUCK_APP });
    expect(result.exitCode).toBe(0);
    const text = result.output.join("\n");
    expect(text).toContain("duck-version-a (latest) - unknown route(s)");
    expect(text).toContain("duck-version-b (oldest) - 2 route(s)");
    // One string schemaName out of the instructions (the numeric one is
    // filtered by the typeof guard).
    expect(text).toContain("Schemas: 1");
  });

  it("runInfo still works when --version error path has no known versions", async () => {
    // The duck-typed app exposes versionValues, but we ask for an unknown
    // one to hit the error formatter with a non-empty known-versions list.
    const result = await runInfo({ app: DUCK_APP, version: "does-not-exist" });
    expect(result.exitCode).toBe(1);
    const text = result.output.join("\n");
    expect(text).toContain("Unknown version");
    expect(text).toContain("duck-version-a");
    expect(text).toContain("duck-version-b");
  });
});

// --- Section 6: info error handling ---

describe("CLI: runInfo error handling", () => {
  it("rejects when --app is missing", async () => {
    const res = await runProgram(["node", "tsadwyn", "info"]);
    expect(res.error?.code).toBe("commander.missingMandatoryOptionValue");
  });

  it("returns exit code 1 for a nonexistent module", async () => {
    const result = await runInfo({ app: "/nonexistent/info-app.ts" });
    expect(result.exitCode).toBe(1);
    expect(result.output.join("\n")).toMatch(/Error during info lookup/);
  });

  it("returns exit code 1 when the module exports no Cadwyn app", async () => {
    const result = await runInfo({ app: NO_APP });
    expect(result.exitCode).toBe(1);
    expect(result.output.join("\n")).toContain("Could not find a Cadwyn app export");
  });

  it("returns exit code 1 when the export is not a Cadwyn instance", async () => {
    const result = await runInfo({ app: BAD_APP });
    expect(result.exitCode).toBe(1);
    expect(result.output.join("\n")).toContain("Could not find a Cadwyn app export");
  });

  it("returns exit code 1 when the version is unknown", async () => {
    const result = await runInfo({ app: HAPPY_APP, version: "1999-12-31" });
    expect(result.exitCode).toBe(1);
    const text = result.output.join("\n");
    expect(text).toContain("Unknown version");
    expect(text).toContain("1999-12-31");
    expect(text).toContain("Available versions");
  });

  it("routes info failure through the CLI and writes to stderr", async () => {
    const res = await runProgram([
      "node",
      "tsadwyn",
      "info",
      "--app",
      HAPPY_APP,
      "--api-version",
      "1999-12-31",
    ]);
    expect(res.error?.exitCode).toBe(1);
    expect(res.error?.code).toBe("tsadwyn.infoFailed");
    expect(joined(res.stderr)).toContain("Unknown version");
  });
});

// --- Section 7: temp-file parity & isMainModule guard ---

describe("CLI: temp-file fixtures", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tsadwyn-cli-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("accepts a temp-written .ts module that throws SyntaxError", async () => {
    const file = join(tempDir, "broken.ts");
    writeFileSync(file, "this is not valid typescript!!! <<<>>>\n");
    const result = await runCodegen({ app: file });
    expect(result.exitCode).toBe(1);
    expect(result.output.join("\n")).toContain("Error during code generation");
  });

  it("accepts a temp-written .mjs module with no default export", async () => {
    const file = join(tempDir, "noapp.mjs");
    writeFileSync(file, "export const foo = 1;\n");
    const result = await runInfo({ app: file });
    expect(result.exitCode).toBe(1);
    expect(result.output.join("\n")).toContain("Could not find a Cadwyn app export");
  });
});

describe("CLI: isMainModule guard", () => {
  it("returns false when the module is imported by the test runner", () => {
    // Under vitest, cli.ts is imported — not executed as argv[1]. The guard
    // must report false so that parseAsync() is not auto-invoked at import.
    expect(isMainModule()).toBe(false);
  });
});
