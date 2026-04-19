/**
 * Tests for the route-shadowing diagnostic.
 *
 * Covers:
 *   - :id registered before literal → warn/throw (depending on policy).
 *   - literal registered before :id → no shadow (correct order).
 *   - Different methods: GET :id + POST literal → no shadow.
 *   - Constrained param :id(\\d+) → still flagged (conservative heuristic).
 *   - Wildcard * → flagged.
 *   - Policy: 'silent' emits nothing; 'throw' raises; 'warn' logs once per shadow.
 *   - detectRouteShadows returns the pair list without side effects.
 */
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

import {
  Tsadwyn,
  Version,
  VersionBundle,
  VersionedRouter,
  detectRouteShadows,
  TsadwynStructureError,
} from "../src/index.js";

const Body = z.object({ ok: z.boolean() }).named("Shadowing_Body");

function makeRouter(routes: Array<[method: "get" | "post", path: string]>): VersionedRouter {
  const r = new VersionedRouter();
  for (const [method, path] of routes) {
    if (method === "get") r.get(path, null, Body, async () => ({ ok: true }));
    else r.post(path, null, Body, async () => ({ ok: true }));
  }
  return r;
}

describe("detectRouteShadows (pure)", () => {
  it("flags :id before literal (same method)", () => {
    const r = makeRouter([
      ["get", "/users/:id"],
      ["get", "/users/search"],
    ]);
    const shadows = detectRouteShadows(r.routes);
    expect(shadows).toHaveLength(1);
    expect(shadows[0]).toEqual({
      shadower: { method: "GET", path: "/users/:id" },
      shadowed: { method: "GET", path: "/users/search" },
    });
  });

  it("does NOT flag literal before :id (correct registration order)", () => {
    const r = makeRouter([
      ["get", "/users/search"],
      ["get", "/users/:id"],
    ]);
    expect(detectRouteShadows(r.routes)).toEqual([]);
  });

  it("does NOT flag across different methods", () => {
    const r = makeRouter([
      ["get", "/users/:id"],
      ["post", "/users/search"],
    ]);
    expect(detectRouteShadows(r.routes)).toEqual([]);
  });

  it("flags wildcard routes (* segment)", () => {
    const r = makeRouter([
      ["get", "/files/*"],
      ["get", "/files/index"],
    ]);
    const shadows = detectRouteShadows(r.routes);
    expect(shadows).toHaveLength(1);
    expect(shadows[0].shadower.path).toBe("/files/*");
    expect(shadows[0].shadowed.path).toBe("/files/index");
  });

  it("flags constrained params (:id(\\d+)) conservatively", () => {
    const r = makeRouter([
      ["get", "/users/:id(\\d+)"],
      ["get", "/users/search"],
    ]);
    const shadows = detectRouteShadows(r.routes);
    // Even though \d+ wouldn't actually match 'search' at runtime, our
    // heuristic treats the param segment as a catch-all for safety.
    expect(shadows).toHaveLength(1);
  });

  it("catches transitive shadows (multiple earlier catchers)", () => {
    const r = makeRouter([
      ["get", "/a/:x"],
      ["get", "/a/:y"],       // duplicate wildcard — ignored for shadow purposes
      ["get", "/a/literal"],  // both earlier :x and :y shadow this
    ]);
    const shadows = detectRouteShadows(r.routes);
    const shadowerPaths = shadows.map((s) => s.shadower.path);
    expect(shadowerPaths).toContain("/a/:x");
    expect(shadowerPaths).toContain("/a/:y");
  });

  it("two fully-literal routes are never flagged", () => {
    const r = makeRouter([
      ["get", "/a"],
      ["get", "/b"],
    ]);
    expect(detectRouteShadows(r.routes)).toEqual([]);
  });
});

describe("Tsadwyn application integration", () => {
  it("default policy 'warn' logs via supplied logger", () => {
    const warn = vi.fn();
    const router = makeRouter([
      ["get", "/users/:id"],
      ["get", "/users/search"],
    ]);
    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
      routeShadowingLogger: { warn },
    });
    app.generateAndIncludeVersionedRouters(router);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        shadower: { method: "GET", path: "/users/:id" },
        shadowed: { method: "GET", path: "/users/search" },
      }),
      expect.stringMatching(/shadows/),
    );
  });

  it("policy 'throw' surfaces TsadwynStructureError", () => {
    const router = makeRouter([
      ["get", "/users/:id"],
      ["get", "/users/search"],
    ]);
    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
      onRouteShadowing: "throw",
    });
    expect(() => app.generateAndIncludeVersionedRouters(router)).toThrow(
      TsadwynStructureError,
    );
  });

  it("policy 'silent' emits nothing", () => {
    const warn = vi.fn();
    const router = makeRouter([
      ["get", "/users/:id"],
      ["get", "/users/search"],
    ]);
    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
      onRouteShadowing: "silent",
      routeShadowingLogger: { warn },
    });
    app.generateAndIncludeVersionedRouters(router);

    expect(warn).not.toHaveBeenCalled();
  });

  it("clean registration order does not fire diagnostic", () => {
    const warn = vi.fn();
    const router = makeRouter([
      ["get", "/users/search"],
      ["get", "/users/:id"],
    ]);
    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
      routeShadowingLogger: { warn },
    });
    app.generateAndIncludeVersionedRouters(router);

    expect(warn).not.toHaveBeenCalled();
  });
});
