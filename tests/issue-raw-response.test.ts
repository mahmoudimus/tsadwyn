/**
 * FAILING TEST — `raw()` binary / streaming response marker.
 *
 * Consumers that return Buffer or Readable today work (route-generation
 * detects and sends them with application/octet-stream), but the pattern
 * is undeclared — `responseSchema: null` is a lie (there IS a schema,
 * it's just not JSON). The `raw()` marker makes the contract explicit:
 *   - The mime type is set automatically from the marker.
 *   - Response migrations targeting the route are flagged as dead code
 *     at generation time (body is opaque bytes).
 *   - OpenAPI output can eventually describe the binary response shape.
 *
 * Run: npx vitest run tests/issue-raw-response.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

import {
  Tsadwyn,
  Version,
  VersionBundle,
  VersionChange,
  VersionedRouter,
  ResponseInfo,
  convertResponseToPreviousVersionFor,
} from "../src/index.js";

// GAP: not exported
// @ts-expect-error — intentional
import { raw } from "../src/index.js";

describe("Issue: raw() binary/streaming response marker", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("raw() returns a marker with mimeType", () => {
    const marker = raw({ mimeType: "application/pdf" });
    expect(marker).toBeDefined();
    expect(marker.mimeType).toBe("application/pdf");
  });

  it("delivers a Buffer response with the declared mime type", async () => {
    const router = new VersionedRouter();
    router.get(
      "/reports/:id/export.pdf",
      null,
      raw({ mimeType: "application/pdf" }),
      async () => Buffer.from("%PDF-1.4 fake pdf content"),
    );

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .get("/reports/123/export.pdf")
      .set("x-api-version", "2024-01-01");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect(res.body.toString()).toContain("%PDF-1.4");
  });

  it("emits a warn at generation time when a response migration targets a raw() route", () => {
    class DeadMigration extends VersionChange {
      description =
        "response migration on a raw() route — transformer won't fire";
      instructions = [];

      r1 = convertResponseToPreviousVersionFor("/reports/:id/export.pdf", [
        "GET",
      ])((_res: ResponseInfo) => {
        // Body is a Buffer — this transformer is dead code.
      });
    }

    const router = new VersionedRouter();
    router.get(
      "/reports/:id/export.pdf",
      null,
      raw({ mimeType: "application/pdf" }),
      async () => Buffer.from("x"),
    );

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2025-01-01", DeadMigration),
        new Version("2024-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const warned = warnSpy.mock.calls.some((args) =>
      args.some(
        (a) =>
          typeof a === "string" &&
          /export\.pdf/.test(a) &&
          /(raw|binary|opaque)/i.test(a),
      ),
    );
    expect(
      warned,
      `Expected a warn that a response migration targets a raw() route. ` +
        `Got: ${JSON.stringify(warnSpy.mock.calls)}`,
    ).toBe(true);
  });

  it("error responses from a raw() route still produce JSON via the error pipeline", async () => {
    const { HttpError } = await import("../src/index.js");
    const router = new VersionedRouter();
    router.get(
      "/reports/:id/export.pdf",
      null,
      raw({ mimeType: "application/pdf" }),
      async (req: any) => {
        if (req.params.id === "missing") {
          throw new HttpError(404, { code: "report_not_found" });
        }
        return Buffer.from("x");
      },
    );

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const ok = await request(app.expressApp)
      .get("/reports/123/export.pdf")
      .set("x-api-version", "2024-01-01");
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toMatch(/application\/pdf/);

    const notFound = await request(app.expressApp)
      .get("/reports/missing/export.pdf")
      .set("x-api-version", "2024-01-01");
    expect(notFound.status).toBe(404);
    expect(notFound.headers["content-type"]).toMatch(/application\/json/);
    expect(notFound.body.code).toBe("report_not_found");
  });
});
