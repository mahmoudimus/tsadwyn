/**
 * Covers `onUnsupportedVersion: 'reject' | 'fallback' | 'passthrough'` on
 * `versionPickingMiddleware`. Controls how an unknown `X-Api-Version`
 * header is handled:
 *   - `'reject'` — 400 with `{error, sent, supported}` (Stripe-style).
 *   - `'fallback'` — silently substitute `apiVersionDefaultValue` + warn.
 *   - `'passthrough'` (default) — store the verbatim string and let the
 *     downstream dispatcher decide. Preserves historical behavior.
 *
 * Run: npx vitest run tests/issue-on-unsupported-version.test.ts
 */
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

import { versionPickingMiddleware, apiVersionStorage } from "../src/index.js";

describe("Issue: onUnsupportedVersion policy on versionPickingMiddleware", () => {
  it("'reject' mode returns 400 with structured body listing supported versions", async () => {
    const app = express();
    app.use(express.json());
    app.use(
      versionPickingMiddleware({
        headerName: "x-api-version",
        apiVersionLocation: "custom_header",
        apiVersionDefaultValue: "2024-01-01",
        versionValues: ["2025-01-01", "2024-01-01"],
        // GAP: option not recognized today — middleware lets the request through.
        onUnsupportedVersion: "reject",
      } as any),
    );
    app.get("/anything", (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app)
      .get("/anything")
      .set("x-api-version", "2026-04-15"); // off-by-one typo

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "unsupported_api_version",
      sent: "2026-04-15",
      supported: ["2025-01-01", "2024-01-01"],
    });
  });

  it("'fallback' mode substitutes apiVersionDefaultValue and emits a warning", async () => {
    const warn = vi.fn();
    const app = express();
    app.use(express.json());
    app.use(
      versionPickingMiddleware({
        headerName: "x-api-version",
        apiVersionLocation: "custom_header",
        apiVersionDefaultValue: "2024-01-01",
        versionValues: ["2025-01-01", "2024-01-01"],
        onUnsupportedVersion: "fallback",
        logger: { warn },
      } as any),
    );
    app.get("/anything", (_req, res) => {
      const stored = apiVersionStorage.getStore();
      res.json({ stored });
    });

    const res = await request(app)
      .get("/anything")
      .set("x-api-version", "2026-04-15");

    expect(res.status).toBe(200);
    expect(res.body.stored).toBe("2024-01-01");
    expect(warn).toHaveBeenCalled();
    const args = warn.mock.calls[0];
    // First argument should be a structured context with the bad version.
    const ctx = args[0];
    expect(ctx).toMatchObject({ sent: "2026-04-15" });
  });

  it("'passthrough' mode (current default behavior) stores the verbatim string", async () => {
    const app = express();
    app.use(express.json());
    app.use(
      versionPickingMiddleware({
        headerName: "x-api-version",
        apiVersionLocation: "custom_header",
        apiVersionDefaultValue: null,
        versionValues: ["2025-01-01", "2024-01-01"],
        onUnsupportedVersion: "passthrough",
      } as any),
    );
    app.get("/anything", (_req, res) => {
      res.json({ stored: apiVersionStorage.getStore() });
    });

    const res = await request(app)
      .get("/anything")
      .set("x-api-version", "2026-04-15");

    expect(res.status).toBe(200);
    expect(res.body.stored).toBe("2026-04-15");
  });

  it("default behavior (no option) is 'passthrough' for backwards compatibility", async () => {
    const app = express();
    app.use(express.json());
    app.use(
      versionPickingMiddleware({
        headerName: "x-api-version",
        apiVersionLocation: "custom_header",
        apiVersionDefaultValue: null,
        versionValues: ["2025-01-01", "2024-01-01"],
        // no onUnsupportedVersion — must behave as today
      }),
    );
    app.get("/anything", (_req, res) => {
      res.json({ stored: apiVersionStorage.getStore() });
    });

    const res = await request(app)
      .get("/anything")
      .set("x-api-version", "2026-04-15");

    expect(res.status).toBe(200);
    expect(res.body.stored).toBe("2026-04-15");
  });
});
