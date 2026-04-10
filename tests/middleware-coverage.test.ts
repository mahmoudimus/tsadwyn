import { describe, it, expect, vi } from "vitest";
import express from "express";
import type { Request } from "express";
import request from "supertest";

import {
  versionPickingMiddleware,
  apiVersionStorage,
} from "../src/index.js";

/**
 * Build a minimal Express app that mounts the provided middleware and
 * exposes an /echo route whose body reveals the version that was stored
 * in apiVersionStorage by the middleware.
 */
function makeApp(mw: ReturnType<typeof versionPickingMiddleware>) {
  const app = express();
  app.use(mw);
  app.get("/echo", (_req, res) => {
    const version = apiVersionStorage.getStore();
    res.json({ version: version ?? null });
  });
  // Route used by path-based tests for requests such as /2024-01-01/users
  app.get("/:anything/users", (_req, res) => {
    const version = apiVersionStorage.getStore();
    res.json({ version: version ?? null });
  });
  app.get("/2024-01-01", (_req, res) => {
    const version = apiVersionStorage.getStore();
    res.json({ version: version ?? null });
  });
  return app;
}

describe("versionPickingMiddleware — legacy string header argument", () => {
  it("extracts the version from a header when supplied as a plain string", async () => {
    const app = makeApp(versionPickingMiddleware("x-api-version"));

    const res = await request(app)
      .get("/echo")
      .set("x-api-version", "2024-01-01");

    expect(res.status).toBe(200);
    expect(res.body.version).toBe("2024-01-01");
    // Middleware echoes the version back in the response header.
    expect(res.headers["x-api-version"]).toBe("2024-01-01");
  });

  it("stores null when the header is missing (legacy string mode)", async () => {
    const app = makeApp(versionPickingMiddleware("x-api-version"));

    const res = await request(app).get("/echo");

    expect(res.status).toBe(200);
    expect(res.body.version).toBeNull();
    expect(res.headers["x-api-version"]).toBeUndefined();
  });

  it("supports a fully custom header name in legacy mode", async () => {
    const app = makeApp(versionPickingMiddleware("my-api-version"));

    const res = await request(app)
      .get("/echo")
      .set("my-api-version", "2023-05-05");

    expect(res.body.version).toBe("2023-05-05");
    expect(res.headers["my-api-version"]).toBe("2023-05-05");
  });

  it("reads the header case-insensitively in legacy mode", async () => {
    const app = makeApp(versionPickingMiddleware("X-API-Version"));

    const res = await request(app)
      .get("/echo")
      .set("x-api-version", "2022-12-31");

    expect(res.body.version).toBe("2022-12-31");
  });
});

describe("versionPickingMiddleware — VersionPickingOptions (custom header)", () => {
  it("extracts the version from the configured header", async () => {
    const app = makeApp(
      versionPickingMiddleware({
        headerName: "x-api-version",
        apiVersionLocation: "custom_header",
        apiVersionDefaultValue: null,
        versionValues: ["2024-01-01", "2023-01-01"],
      }),
    );

    const res = await request(app)
      .get("/echo")
      .set("x-api-version", "2024-01-01");

    expect(res.body.version).toBe("2024-01-01");
    expect(res.headers["x-api-version"]).toBe("2024-01-01");
  });

  it("falls back to the string default when no header is supplied", async () => {
    const app = makeApp(
      versionPickingMiddleware({
        headerName: "x-api-version",
        apiVersionLocation: "custom_header",
        apiVersionDefaultValue: "2024-01-01",
        versionValues: ["2024-01-01", "2023-01-01"],
      }),
    );

    const res = await request(app).get("/echo");

    expect(res.body.version).toBe("2024-01-01");
    expect(res.headers["x-api-version"]).toBe("2024-01-01");
  });

  it("stores null when no header is supplied and the default is null", async () => {
    const app = makeApp(
      versionPickingMiddleware({
        headerName: "x-api-version",
        apiVersionLocation: "custom_header",
        apiVersionDefaultValue: null,
        versionValues: ["2024-01-01"],
      }),
    );

    const res = await request(app).get("/echo");

    expect(res.body.version).toBeNull();
    expect(res.headers["x-api-version"]).toBeUndefined();
  });

  it("calls a synchronous default-value function with the request", async () => {
    const defaultFn = vi.fn((req: Request) => {
      // Confirm the request object is propagated.
      expect(req).toBeDefined();
      expect(typeof req.path).toBe("string");
      return "2023-01-01";
    });

    const app = makeApp(
      versionPickingMiddleware({
        headerName: "x-api-version",
        apiVersionLocation: "custom_header",
        apiVersionDefaultValue: defaultFn,
        versionValues: ["2024-01-01", "2023-01-01"],
      }),
    );

    const res = await request(app).get("/echo");

    expect(res.body.version).toBe("2023-01-01");
    expect(defaultFn).toHaveBeenCalledTimes(1);
  });

  it("awaits an async default-value function", async () => {
    const defaultFn = vi.fn(async (_req: Request) => {
      await Promise.resolve();
      return "2022-06-06";
    });

    const app = makeApp(
      versionPickingMiddleware({
        headerName: "x-api-version",
        apiVersionLocation: "custom_header",
        apiVersionDefaultValue: defaultFn,
        versionValues: ["2022-06-06"],
      }),
    );

    const res = await request(app).get("/echo");

    expect(res.body.version).toBe("2022-06-06");
    expect(defaultFn).toHaveBeenCalledTimes(1);
  });

  it("does NOT call the default-value function when a header is present", async () => {
    const defaultFn = vi.fn(() => "fallback-version");

    const app = makeApp(
      versionPickingMiddleware({
        headerName: "x-api-version",
        apiVersionLocation: "custom_header",
        apiVersionDefaultValue: defaultFn,
        versionValues: ["2024-01-01"],
      }),
    );

    const res = await request(app)
      .get("/echo")
      .set("x-api-version", "2024-01-01");

    expect(res.body.version).toBe("2024-01-01");
    expect(defaultFn).not.toHaveBeenCalled();
  });

  it("reads the custom header case-insensitively", async () => {
    const app = makeApp(
      versionPickingMiddleware({
        headerName: "My-Custom-API-Version",
        apiVersionLocation: "custom_header",
        apiVersionDefaultValue: null,
        versionValues: ["2024-01-01"],
      }),
    );

    const res = await request(app)
      .get("/echo")
      .set("my-custom-api-version", "2024-01-01");

    expect(res.body.version).toBe("2024-01-01");
    expect(res.headers["my-custom-api-version"]).toBe("2024-01-01");
  });

  it("supports a fully custom header name like 'api-version'", async () => {
    const app = makeApp(
      versionPickingMiddleware({
        headerName: "api-version",
        apiVersionLocation: "custom_header",
        apiVersionDefaultValue: null,
        versionValues: ["2024-01-01"],
      }),
    );

    const res = await request(app)
      .get("/echo")
      .set("api-version", "2024-01-01");

    expect(res.body.version).toBe("2024-01-01");
  });
});

describe("versionPickingMiddleware — path-based version extraction", () => {
  it("extracts the version from the URL path when it starts with a known version", async () => {
    const app = makeApp(
      versionPickingMiddleware({
        headerName: "x-api-version",
        apiVersionLocation: "path",
        apiVersionDefaultValue: null,
        versionValues: ["2024-01-01", "2023-01-01"],
      }),
    );

    const res = await request(app).get("/2024-01-01/users");

    expect(res.status).toBe(200);
    expect(res.body.version).toBe("2024-01-01");
    expect(res.headers["x-api-version"]).toBe("2024-01-01");
  });

  it("picks the other configured version from the path", async () => {
    const app = makeApp(
      versionPickingMiddleware({
        headerName: "x-api-version",
        apiVersionLocation: "path",
        apiVersionDefaultValue: null,
        versionValues: ["2024-01-01", "2023-01-01"],
      }),
    );

    const res = await request(app).get("/2023-01-01/users");

    expect(res.body.version).toBe("2023-01-01");
  });

  it("falls back to the default value when the path does not start with a version", async () => {
    const app = makeApp(
      versionPickingMiddleware({
        headerName: "x-api-version",
        apiVersionLocation: "path",
        apiVersionDefaultValue: "2024-01-01",
        versionValues: ["2024-01-01", "2023-01-01"],
      }),
    );

    const res = await request(app).get("/echo");

    expect(res.body.version).toBe("2024-01-01");
  });

  it("stores null when the path has no version and no default is configured", async () => {
    const app = makeApp(
      versionPickingMiddleware({
        headerName: "x-api-version",
        apiVersionLocation: "path",
        apiVersionDefaultValue: null,
        versionValues: ["2024-01-01", "2023-01-01"],
      }),
    );

    const res = await request(app).get("/echo");

    expect(res.body.version).toBeNull();
  });

  it("uses the default-value function when the path has no version", async () => {
    const defaultFn = vi.fn((req: Request) => {
      expect(req.path).toBe("/echo");
      return "2023-01-01";
    });

    const app = makeApp(
      versionPickingMiddleware({
        headerName: "x-api-version",
        apiVersionLocation: "path",
        apiVersionDefaultValue: defaultFn,
        versionValues: ["2024-01-01", "2023-01-01"],
      }),
    );

    const res = await request(app).get("/echo");

    expect(res.body.version).toBe("2023-01-01");
    expect(defaultFn).toHaveBeenCalledTimes(1);
  });

  it("awaits an async default-value function in path mode", async () => {
    const defaultFn = vi.fn(async () => {
      await Promise.resolve();
      return "2022-12-31";
    });

    const app = makeApp(
      versionPickingMiddleware({
        headerName: "x-api-version",
        apiVersionLocation: "path",
        apiVersionDefaultValue: defaultFn,
        versionValues: ["2022-12-31"],
      }),
    );

    const res = await request(app).get("/echo");

    expect(res.body.version).toBe("2022-12-31");
    expect(defaultFn).toHaveBeenCalledTimes(1);
  });

  it("stores null in path mode when versionValues is empty", async () => {
    const app = makeApp(
      versionPickingMiddleware({
        headerName: "x-api-version",
        apiVersionLocation: "path",
        apiVersionDefaultValue: null,
        versionValues: [],
      }),
    );

    const res = await request(app).get("/2024-01-01/users");

    // No regex built when versionValues is empty -> version is undefined -> null stored.
    expect(res.body.version).toBeNull();
  });

  it("does NOT invoke the default-value function when a path version is present", async () => {
    const defaultFn = vi.fn(() => "fallback-version");

    const app = makeApp(
      versionPickingMiddleware({
        headerName: "x-api-version",
        apiVersionLocation: "path",
        apiVersionDefaultValue: defaultFn,
        versionValues: ["2024-01-01"],
      }),
    );

    const res = await request(app).get("/2024-01-01/users");

    expect(res.body.version).toBe("2024-01-01");
    expect(defaultFn).not.toHaveBeenCalled();
  });
});
