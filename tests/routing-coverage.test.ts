import { describe, it, expect } from "vitest";
import { Router } from "express";
import { z } from "zod";

import {
  Cadwyn,
  Version,
  VersionBundle,
  VersionedRouter,
  RootCadwynRouter,
  ZodSchemaRegistry,
} from "../src/index.js";
import type { RouteDefinition } from "../src/index.js";

/**
 * Build a minimal valid RouteDefinition with optional overrides.
 */
function makeRoute(overrides: Partial<RouteDefinition> = {}): RouteDefinition {
  return {
    method: "GET",
    path: "/ping",
    requestSchema: null,
    responseSchema: null,
    handler: async () => ({ ok: true }),
    funcName: null,
    tags: [],
    statusCode: 200,
    deprecated: false,
    summary: "",
    description: "",
    operationId: "",
    paramsSchema: null,
    querySchema: null,
    middleware: [],
    includeInSchema: true,
    responses: null,
    callbacks: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Section 1: Construction + versionValues getter
// ---------------------------------------------------------------------------
describe("RootCadwynRouter: construction and versionValues getter", () => {
  it("returns the versionValues passed to the constructor", () => {
    const values = ["2024-01-01", "2023-01-01"];
    const router = new RootCadwynRouter({
      apiVersionParameterName: "x-api-version",
      versionValues: values,
    });

    expect(router.versionValues).toEqual(values);
    // Same reference should be returned by the getter
    expect(router.versionValues).toBe(values);
  });

  it("lowercases the apiVersionParameterName", () => {
    const router = new RootCadwynRouter({
      apiVersionParameterName: "X-API-Version",
      versionValues: ["2024-01-01"],
    });
    expect(router.apiVersionParameterName).toBe("x-api-version");
  });

  it("exposes an empty versionedRouters map on construction", () => {
    const router = new RootCadwynRouter({
      apiVersionParameterName: "x-api-version",
      versionValues: ["2024-01-01"],
    });
    expect(router.versionedRouters).toBeInstanceOf(Map);
    expect(router.versionedRouters.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Section 2: sortedVersions getter
// ---------------------------------------------------------------------------
describe("RootCadwynRouter: sortedVersions getter", () => {
  it("sorts versions ascending (oldest first) based on versionedRouters keys", () => {
    const router = new RootCadwynRouter({
      apiVersionParameterName: "x-api-version",
      versionValues: ["2024-01-01", "2023-06-01", "2023-01-01"],
    });

    const map = new Map<string, Router>();
    map.set("2023-06-01", Router());
    map.set("2024-01-01", Router());
    map.set("2023-01-01", Router());
    router.setVersionedRouters(map);

    expect(router.sortedVersions).toEqual([
      "2023-01-01",
      "2023-06-01",
      "2024-01-01",
    ]);
  });

  it("returns unchanged order for already-sorted keys", () => {
    const router = new RootCadwynRouter({
      apiVersionParameterName: "x-api-version",
      versionValues: ["2024-01-01", "2023-01-01"],
    });

    const map = new Map<string, Router>();
    map.set("2023-01-01", Router());
    map.set("2024-01-01", Router());
    router.setVersionedRouters(map);

    expect(router.sortedVersions).toEqual(["2023-01-01", "2024-01-01"]);
  });

  it("returns a single-version array when only one version is registered", () => {
    const router = new RootCadwynRouter({
      apiVersionParameterName: "x-api-version",
      versionValues: ["2024-01-01"],
    });

    const map = new Map<string, Router>();
    map.set("2024-01-01", Router());
    router.setVersionedRouters(map);

    expect(router.sortedVersions).toEqual(["2024-01-01"]);
  });

  it("returns an empty array when versionValues and versionedRouters are empty", () => {
    const router = new RootCadwynRouter({
      apiVersionParameterName: "x-api-version",
      versionValues: [],
    });
    expect(router.versionValues).toEqual([]);
    expect(router.sortedVersions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Section 3: setVersionedRouters + getRouter + hasVersion
// ---------------------------------------------------------------------------
describe("RootCadwynRouter: setVersionedRouters / getRouter / hasVersion", () => {
  it("stores routers set via setVersionedRouters and returns them via getRouter", () => {
    const router = new RootCadwynRouter({
      apiVersionParameterName: "x-api-version",
      versionValues: ["2024-01-01", "2023-01-01"],
    });

    const r2024 = Router();
    const r2023 = Router();
    const map = new Map<string, Router>();
    map.set("2024-01-01", r2024);
    map.set("2023-01-01", r2023);
    router.setVersionedRouters(map);

    expect(router.getRouter("2024-01-01")).toBe(r2024);
    expect(router.getRouter("2023-01-01")).toBe(r2023);
  });

  it("getRouter returns undefined for unknown versions", () => {
    const router = new RootCadwynRouter({
      apiVersionParameterName: "x-api-version",
      versionValues: ["2024-01-01"],
    });
    const map = new Map<string, Router>();
    map.set("2024-01-01", Router());
    router.setVersionedRouters(map);

    expect(router.getRouter("2099-01-01")).toBeUndefined();
  });

  it("hasVersion reflects registered versions", () => {
    const router = new RootCadwynRouter({
      apiVersionParameterName: "x-api-version",
      versionValues: ["2024-01-01"],
    });
    const map = new Map<string, Router>();
    map.set("2024-01-01", Router());
    router.setVersionedRouters(map);

    expect(router.hasVersion("2024-01-01")).toBe(true);
    expect(router.hasVersion("2099-01-01")).toBe(false);
  });

  it("setVersionedRouters clears previous entries before writing the new map", () => {
    const router = new RootCadwynRouter({
      apiVersionParameterName: "x-api-version",
      versionValues: ["2024-01-01", "2023-01-01"],
    });

    const first = new Map<string, Router>();
    first.set("2023-01-01", Router());
    router.setVersionedRouters(first);
    expect(router.hasVersion("2023-01-01")).toBe(true);

    const second = new Map<string, Router>();
    second.set("2024-01-01", Router());
    router.setVersionedRouters(second);

    expect(router.hasVersion("2024-01-01")).toBe(true);
    expect(router.hasVersion("2023-01-01")).toBe(false);
    expect(router.versionedRouters.size).toBe(1);
  });

  it("exposes the underlying versionedRouters map", () => {
    const router = new RootCadwynRouter({
      apiVersionParameterName: "x-api-version",
      versionValues: ["2024-01-01"],
    });
    const map = new Map<string, Router>();
    const r = Router();
    map.set("2024-01-01", r);
    router.setVersionedRouters(map);

    expect(router.versionedRouters.get("2024-01-01")).toBe(r);
    expect(router.versionedRouters.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Section 4: setOpenAPIData + buildOpenAPI
// ---------------------------------------------------------------------------
describe("RootCadwynRouter: setOpenAPIData and buildOpenAPI", () => {
  it("buildOpenAPI returns a document with info/title/version/paths for a known version", () => {
    const router = new RootCadwynRouter({
      apiVersionParameterName: "x-api-version",
      versionValues: ["2024-01-01"],
    });

    const route = makeRoute({ method: "GET", path: "/items" });
    const schemas = new Map<string, ZodSchemaRegistry>();
    schemas.set("2024-01-01", new ZodSchemaRegistry());

    router.setOpenAPIData([route], schemas);

    const doc = router.buildOpenAPI("2024-01-01", {
      title: "Test API",
      appVersion: "1.2.3",
      description: "A description",
    });

    expect(doc).toBeDefined();
    expect(doc.info).toBeDefined();
    expect(doc.info.title).toBe("Test API");
    // info.version is the API version (not the app version) per buildOpenAPIDocument
    expect(doc.info.version).toBe("2024-01-01");
    expect(doc.info.description).toBe("A description");
    expect(doc.paths).toBeDefined();
    // The GET /items route should have been rendered into the paths
    expect(doc.paths["/items"]).toBeDefined();
    expect(doc.paths["/items"].get).toBeDefined();
  });

  it("buildOpenAPI works when the registry for a version is missing", () => {
    const router = new RootCadwynRouter({
      apiVersionParameterName: "x-api-version",
      versionValues: ["2024-01-01"],
    });

    router.setOpenAPIData([makeRoute()], new Map());

    const doc = router.buildOpenAPI("2024-01-01", {
      title: "No Registry API",
      appVersion: "0.0.1",
    });

    expect(doc.info.title).toBe("No Registry API");
    // info.version reflects the apiVersion
    expect(doc.info.version).toBe("2024-01-01");
    expect(doc.paths).toBeDefined();
  });

  it("buildOpenAPI honors includeChangelogUrlInSchema=false and a null changelogUrl", () => {
    const router = new RootCadwynRouter({
      apiVersionParameterName: "x-api-version",
      versionValues: ["2024-01-01"],
    });
    router.setOpenAPIData([makeRoute()], new Map());

    const doc = router.buildOpenAPI("2024-01-01", {
      title: "Test",
      appVersion: "0.0.1",
      description: undefined,
      changelogUrl: null,
      includeChangelogUrlInSchema: false,
    });
    expect(doc.info.title).toBe("Test");
    expect(doc.paths).toBeDefined();
  });

  it("buildOpenAPI still returns a document for a version not present in versionedSchemas", () => {
    const router = new RootCadwynRouter({
      apiVersionParameterName: "x-api-version",
      versionValues: ["2024-01-01"],
    });
    // Set schemas for a different version only
    const schemas = new Map<string, ZodSchemaRegistry>();
    schemas.set("2023-01-01", new ZodSchemaRegistry());
    router.setOpenAPIData([makeRoute()], schemas);

    // Unknown version: registry will be undefined internally, buildOpenAPIDocument
    // should still produce a valid document rather than throwing.
    const doc = router.buildOpenAPI("2099-01-01", {
      title: "Unknown Version",
      appVersion: "9.9.9",
    });
    expect(doc).toBeDefined();
    expect(doc.info.title).toBe("Unknown Version");
    // info.version echoes the requested apiVersion
    expect(doc.info.version).toBe("2099-01-01");
    expect(doc.paths).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Section 5: dispatch() edge cases
// ---------------------------------------------------------------------------
describe("RootCadwynRouter: dispatch()", () => {
  it("dispatch returns true and invokes the matching versioned router", () => {
    const router = new RootCadwynRouter({
      apiVersionParameterName: "x-api-version",
      versionValues: ["2024-01-01"],
    });

    let called = false;
    // Build a router with a catch-all middleware so we can verify dispatch
    // actually invokes the inner Express router.
    const innerRouter = Router();
    innerRouter.use((_req, _res, next) => {
      called = true;
      next();
    });

    const map = new Map<string, Router>();
    map.set("2024-01-01", innerRouter);
    router.setVersionedRouters(map);

    // A minimally-viable Express-like Request/Response. Express's Router will
    // invoke our middleware synchronously when dispatch is called.
    const fakeReq: any = {
      url: "/",
      originalUrl: "/",
      method: "GET",
      headers: {},
      baseUrl: "",
      path: "/",
      query: {},
      params: {},
      app: {},
    };
    const fakeRes: any = {
      setHeader: () => {},
      getHeader: () => undefined,
      end: () => {},
      on: () => {},
      once: () => {},
      emit: () => {},
    };
    const next = () => {};

    const result = router.dispatch("2024-01-01", fakeReq, fakeRes, next);
    expect(result).toBe(true);
    expect(called).toBe(true);
  });

  it("dispatch returns false for an unknown version without invoking next", () => {
    const router = new RootCadwynRouter({
      apiVersionParameterName: "x-api-version",
      versionValues: ["2024-01-01"],
    });
    router.setVersionedRouters(new Map());

    let nextCalled = false;
    const fakeReq: any = {};
    const fakeRes: any = {};
    const next = () => {
      nextCalled = true;
    };

    const result = router.dispatch("2099-01-01", fakeReq, fakeRes, next);
    expect(result).toBe(false);
    expect(nextCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Section 6: Integration via full Cadwyn app
// ---------------------------------------------------------------------------
describe("RootCadwynRouter: integration with Cadwyn application", () => {
  it("Cadwyn app creates and populates an internal RootCadwynRouter", () => {
    const router = new VersionedRouter();
    const PingResponse = z.object({ ok: z.boolean() }).named("PingResponse");
    router.get("/ping", null, PingResponse, async () => ({ ok: true }));

    const app = new Cadwyn({
      versions: new VersionBundle(
        new Version("2024-01-01"),
        new Version("2023-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    // The private _rootRouter is accessible via the _versionedRouters getter,
    // which proxies through it. Verify that both known versions are registered.
    const versionedRouters = app._versionedRouters;
    expect(versionedRouters).toBeInstanceOf(Map);
    expect(versionedRouters.has("2024-01-01")).toBe(true);
    expect(versionedRouters.has("2023-01-01")).toBe(true);

    // Reach through to exercise the RootCadwynRouter getters used by the
    // integration path between application.ts and routing.ts.
    const rootRouter = (app as any)._rootRouter as RootCadwynRouter;
    expect(rootRouter).toBeInstanceOf(RootCadwynRouter);
    expect(rootRouter.apiVersionParameterName).toBe("x-api-version");
    expect(rootRouter.versionValues).toEqual(["2024-01-01", "2023-01-01"]);
    expect(rootRouter.sortedVersions).toEqual(["2023-01-01", "2024-01-01"]);
    expect(rootRouter.hasVersion("2024-01-01")).toBe(true);
    expect(rootRouter.hasVersion("2023-01-01")).toBe(true);
    expect(rootRouter.hasVersion("2099-01-01")).toBe(false);
    expect(rootRouter.getRouter("2024-01-01")).toBeDefined();
    expect(rootRouter.getRouter("2099-01-01")).toBeUndefined();

    // buildOpenAPI through the root router should produce a valid document
    // for a known version.
    const doc = rootRouter.buildOpenAPI("2024-01-01", {
      title: "Integration API",
      appVersion: "1.0.0",
    });
    expect(doc.info.title).toBe("Integration API");
    // info.version mirrors the apiVersion
    expect(doc.info.version).toBe("2024-01-01");
    expect(doc.paths).toBeDefined();
    expect(doc.paths["/ping"]).toBeDefined();
  });
});
