/**
 * FAILING TEST — verifies the CLI shells for the introspection triad.
 *
 * The programmatic APIs (`dumpRouteTable`, `inspectMigrationChain`,
 * `simulateRoute`) already exist and have their own test coverage. This
 * file proves the CLI subcommands — `tsadwyn routes`, `tsadwyn migrations`,
 * `tsadwyn simulate` — are wired up in `cli.ts` and work against a real
 * fixture app.
 *
 * Run: npx vitest run tests/issue-cli-introspection-subcommands.test.ts
 */
import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// GAP: these three runners are not exported from cli.ts yet
// @ts-expect-error — intentional
import { runRoutes, runMigrations, runSimulate } from "../src/cli.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "fixtures");
const CLI_APP = resolve(FIXTURES, "cli-happy-app.ts");
const MIGRATIONS_APP = resolve(FIXTURES, "cli-migrations-app.ts");

describe("CLI: tsadwyn routes", () => {
  it("runRoutes() with --format json returns a parseable route table", async () => {
    const result = await runRoutes({ app: CLI_APP, format: "json" });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    // Each entry has the expected RouteTableEntry shape
    for (const entry of parsed) {
      expect(entry).toHaveProperty("method");
      expect(entry).toHaveProperty("path");
      expect(entry).toHaveProperty("version");
      expect(entry).toHaveProperty("statusCode");
    }
  });

  it("runRoutes() --version filters to one version", async () => {
    const result = await runRoutes({
      app: CLI_APP,
      version: "2001-01-01",
      format: "json",
    });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.every((e: any) => e.version === "2001-01-01")).toBe(true);
  });

  it("runRoutes() --method filters case-insensitively", async () => {
    const result = await runRoutes({
      app: CLI_APP,
      method: "post",
      format: "json",
    });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.every((e: any) => e.method === "POST")).toBe(true);
  });

  it("runRoutes() --format table renders a readable header row", async () => {
    const result = await runRoutes({ app: CLI_APP, format: "table" });
    expect(result.stdout).toMatch(/Method/);
    expect(result.stdout).toMatch(/Path/);
  });

  it("runRoutes() exits non-zero when --app path doesn't export a Tsadwyn", async () => {
    const result = await runRoutes({
      app: resolve(FIXTURES, "cli-no-app.ts"),
      format: "json",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBeTruthy();
  });
});

describe("CLI: tsadwyn migrations", () => {
  it("runMigrations() returns JSON list of migrations for a schema+version", async () => {
    const result = await runMigrations({
      app: MIGRATIONS_APP,
      schema: "CliMigrationsFixture_Thing",
      version: "2000-01-01",
      direction: "response",
      format: "json",
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0]).toHaveProperty("version");
    expect(parsed[0]).toHaveProperty("changeClassName");
    expect(parsed[0]).toHaveProperty("kind");
  });

  it("runMigrations() exits non-zero when schema is unknown", async () => {
    const result = await runMigrations({
      app: MIGRATIONS_APP,
      schema: "NoSuchSchema",
      version: "2000-01-01",
      direction: "response",
      format: "json",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/NoSuchSchema|not registered/i);
  });

  it("runMigrations() direction defaults to 'response'", async () => {
    const withDefault = await runMigrations({
      app: MIGRATIONS_APP,
      schema: "CliMigrationsFixture_Thing",
      version: "2000-01-01",
      format: "json",
    });
    expect(withDefault.exitCode).toBe(0);
  });
});

describe("CLI: tsadwyn simulate", () => {
  it("runSimulate() returns the simulation result as JSON", async () => {
    const result = await runSimulate({
      app: CLI_APP,
      method: "GET",
      path: "/things/abc",
      version: "2001-01-01",
      format: "json",
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty("resolvedVersion");
    expect(parsed).toHaveProperty("matchedRoute");
    expect(parsed).toHaveProperty("candidates");
    expect(parsed).toHaveProperty("fallthrough");
    expect(parsed.resolvedVersion).toBe("2001-01-01");
    expect(parsed.matchedRoute).not.toBeNull();
  });

  it("runSimulate() renders a candidates list in table format", async () => {
    const result = await runSimulate({
      app: CLI_APP,
      method: "GET",
      path: "/things/abc",
      version: "2001-01-01",
      format: "table",
    });
    expect(result.exitCode).toBe(0);
    // The table should mention the matched path somewhere
    expect(result.stdout).toMatch(/\/things/);
  });

  it("runSimulate() accepts a JSON body via --body and echoes upMigratedBody in JSON output", async () => {
    const result = await runSimulate({
      app: CLI_APP,
      method: "POST",
      path: "/things",
      version: "2001-01-01",
      body: JSON.stringify({ id: "x", name: "y" }),
      format: "json",
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    // No migrations should run at head, but the field should exist in output.
    expect(parsed).toHaveProperty("upMigratedBody");
  });

  it("runSimulate() exits non-zero when --method or --path is missing", async () => {
    const missingMethod = await runSimulate({
      app: CLI_APP,
      method: "",
      path: "/things/abc",
      format: "json",
    } as any);
    expect(missingMethod.exitCode).not.toBe(0);
  });
});
