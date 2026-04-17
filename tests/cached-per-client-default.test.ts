/**
 * Tests for `cachedPerClientDefaultVersion` — TTL-cached per-client pin
 * resolver with explicit invalidation handles.
 *
 * Covers:
 *   - Cache hit: resolvePin is called once for repeated requests within TTL.
 *   - Cache miss after TTL expires: resolvePin fires again.
 *   - `invalidate(clientId)` drops one entry, `invalidateAll()` drops all.
 *   - Single-flight: concurrent first-misses share one resolvePin call.
 *   - Unknown client (identify returns null): fallback returned, no cache.
 *   - pinOnFirstResolve populates the cache with the fallback.
 *   - resolvePin rejection is NOT cached; next call retries.
 *   - Stale pin policy (fallback / passthrough / reject).
 *   - ttlMs = 0 disables caching entirely.
 *   - Negative ttlMs throws.
 */
import { describe, it, expect, vi } from "vitest";
import type { Request } from "express";

import { cachedPerClientDefaultVersion } from "../src/index.js";

function fakeReq(clientId: string | null = "c1"): Request {
  return { headers: {}, ["__clientId"]: clientId } as unknown as Request;
}

describe("cachedPerClientDefaultVersion — hit/miss", () => {
  it("calls resolvePin once per TTL window per client", async () => {
    const resolvePin = vi.fn(async (id: string) => `pin-${id}`);
    const { resolver } = cachedPerClientDefaultVersion({
      identify: (req: any) => req.__clientId,
      resolvePin,
      fallback: "FALLBACK",
      ttlMs: 5_000,
    });

    expect(await resolver(fakeReq("c1"))).toBe("pin-c1");
    expect(await resolver(fakeReq("c1"))).toBe("pin-c1");
    expect(await resolver(fakeReq("c1"))).toBe("pin-c1");
    expect(resolvePin).toHaveBeenCalledTimes(1);
  });

  it("re-resolves a different client even when one is cached", async () => {
    const resolvePin = vi.fn(async (id: string) => `pin-${id}`);
    const { resolver } = cachedPerClientDefaultVersion({
      identify: (req: any) => req.__clientId,
      resolvePin,
      fallback: "FALLBACK",
    });

    await resolver(fakeReq("c1"));
    await resolver(fakeReq("c2"));
    await resolver(fakeReq("c1"));
    expect(resolvePin).toHaveBeenCalledTimes(2);
    expect(resolvePin).toHaveBeenNthCalledWith(1, "c1");
    expect(resolvePin).toHaveBeenNthCalledWith(2, "c2");
  });

  it("re-resolves after TTL expires (fake timers)", async () => {
    vi.useFakeTimers();
    try {
      const resolvePin = vi.fn(async (id: string) => `pin-${id}`);
      const { resolver } = cachedPerClientDefaultVersion({
        identify: (req: any) => req.__clientId,
        resolvePin,
        fallback: "FALLBACK",
        ttlMs: 1000,
      });

      await resolver(fakeReq("c1"));
      vi.advanceTimersByTime(500);
      await resolver(fakeReq("c1"));
      expect(resolvePin).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(600); // now age > 1000
      await resolver(fakeReq("c1"));
      expect(resolvePin).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("cachedPerClientDefaultVersion — invalidation", () => {
  it("invalidate(clientId) drops that entry only", async () => {
    const resolvePin = vi.fn(async (id: string) => `pin-${id}`);
    const { resolver, invalidate } = cachedPerClientDefaultVersion({
      identify: (req: any) => req.__clientId,
      resolvePin,
      fallback: "FALLBACK",
    });

    await resolver(fakeReq("c1"));
    await resolver(fakeReq("c2"));
    invalidate("c1");
    await resolver(fakeReq("c1")); // re-resolves
    await resolver(fakeReq("c2")); // still cached
    expect(resolvePin).toHaveBeenCalledTimes(3);
    expect(resolvePin.mock.calls.map((c) => c[0])).toEqual(["c1", "c2", "c1"]);
  });

  it("invalidateAll() drops every entry", async () => {
    const resolvePin = vi.fn(async (id: string) => `pin-${id}`);
    const { resolver, invalidateAll } = cachedPerClientDefaultVersion({
      identify: (req: any) => req.__clientId,
      resolvePin,
      fallback: "FALLBACK",
    });

    await resolver(fakeReq("c1"));
    await resolver(fakeReq("c2"));
    invalidateAll();
    await resolver(fakeReq("c1"));
    await resolver(fakeReq("c2"));
    expect(resolvePin).toHaveBeenCalledTimes(4);
  });
});

describe("cachedPerClientDefaultVersion — single-flight", () => {
  it("concurrent first-misses share one resolvePin call", async () => {
    let resolveGate: ((v: string) => void) | undefined;
    const gate = new Promise<string>((r) => {
      resolveGate = r;
    });
    const resolvePin = vi.fn(() => gate);
    const { resolver } = cachedPerClientDefaultVersion({
      identify: (req: any) => req.__clientId,
      resolvePin,
      fallback: "FALLBACK",
    });

    const p1 = resolver(fakeReq("c1"));
    const p2 = resolver(fakeReq("c1"));
    const p3 = resolver(fakeReq("c1"));

    // Drain the microtask queue so each resolver's `await identify` resolves
    // and it reaches getOrCreate. Single-flight is enforced there.
    await new Promise((r) => setImmediate(r));

    // All three should be waiting on the same underlying resolvePin.
    expect(resolvePin).toHaveBeenCalledTimes(1);

    resolveGate!("shared-pin");
    const [a, b, c] = await Promise.all([p1, p2, p3]);
    expect([a, b, c]).toEqual(["shared-pin", "shared-pin", "shared-pin"]);
  });
});

describe("cachedPerClientDefaultVersion — identity + fallback", () => {
  it("returns fallback and does NOT cache when identify returns null", async () => {
    const resolvePin = vi.fn();
    const { resolver } = cachedPerClientDefaultVersion({
      identify: () => null,
      resolvePin,
      fallback: "FALLBACK",
    });

    expect(await resolver(fakeReq())).toBe("FALLBACK");
    expect(await resolver(fakeReq())).toBe("FALLBACK");
    expect(resolvePin).not.toHaveBeenCalled();
  });

  it("returns fallback when resolvePin returns null (no stored pin)", async () => {
    const resolvePin = vi.fn(async () => null);
    const { resolver } = cachedPerClientDefaultVersion({
      identify: (req: any) => req.__clientId,
      resolvePin,
      fallback: "FALLBACK",
    });

    expect(await resolver(fakeReq("c1"))).toBe("FALLBACK");
  });
});

describe("cachedPerClientDefaultVersion — pinOnFirstResolve", () => {
  it("persists the fallback as the pin on first call, and caches it", async () => {
    const resolvePin = vi.fn(async () => null);
    const saveVersion = vi.fn(async () => {});
    const { resolver } = cachedPerClientDefaultVersion({
      identify: (req: any) => req.__clientId,
      resolvePin,
      saveVersion,
      pinOnFirstResolve: true,
      fallback: "2025-01-01",
    });

    expect(await resolver(fakeReq("c1"))).toBe("2025-01-01");
    expect(saveVersion).toHaveBeenCalledWith("c1", "2025-01-01");

    // Subsequent call: cache hit, no resolvePin or saveVersion.
    expect(await resolver(fakeReq("c1"))).toBe("2025-01-01");
    expect(resolvePin).toHaveBeenCalledTimes(1);
    expect(saveVersion).toHaveBeenCalledTimes(1);
  });

  it("throws at construction when pinOnFirstResolve is set without saveVersion", () => {
    expect(() =>
      cachedPerClientDefaultVersion({
        identify: () => "c1",
        resolvePin: async () => null,
        fallback: "F",
        pinOnFirstResolve: true,
      }),
    ).toThrow(/requires a saveVersion/i);
  });
});

describe("cachedPerClientDefaultVersion — error semantics", () => {
  it("does NOT cache a rejection; next call retries", async () => {
    let shouldFail = true;
    const resolvePin = vi.fn(async () => {
      if (shouldFail) throw new Error("db down");
      return "pin-c1";
    });
    const { resolver } = cachedPerClientDefaultVersion({
      identify: (req: any) => req.__clientId,
      resolvePin,
      fallback: "FALLBACK",
    });

    await expect(resolver(fakeReq("c1"))).rejects.toThrow("db down");
    shouldFail = false;
    expect(await resolver(fakeReq("c1"))).toBe("pin-c1");
    expect(resolvePin).toHaveBeenCalledTimes(2);
  });
});

describe("cachedPerClientDefaultVersion — stale pin policy", () => {
  it("fallback: logs and returns fallback; does NOT cache the stored stale value", async () => {
    const warn = vi.fn();
    const resolvePin = vi.fn(async () => "ancient");
    const { resolver } = cachedPerClientDefaultVersion({
      identify: (req: any) => req.__clientId,
      resolvePin,
      fallback: "CURRENT",
      supportedVersions: ["CURRENT", "PREV"],
      onStalePin: "fallback",
      logger: { warn },
    });

    expect(await resolver(fakeReq("c1"))).toBe("CURRENT");
    expect(warn).toHaveBeenCalled();
    // Second call is cached but returns fallback (since that's what was resolved)
    expect(await resolver(fakeReq("c1"))).toBe("CURRENT");
    expect(resolvePin).toHaveBeenCalledTimes(1);
  });

  it("reject: throws instead of returning", async () => {
    const { resolver } = cachedPerClientDefaultVersion({
      identify: (req: any) => req.__clientId,
      resolvePin: async () => "ancient",
      fallback: "CURRENT",
      supportedVersions: ["CURRENT"],
      onStalePin: "reject",
    });

    await expect(resolver(fakeReq("c1"))).rejects.toThrow(/not in the current VersionBundle/i);
  });

  it("passthrough: returns the stale string verbatim", async () => {
    const { resolver } = cachedPerClientDefaultVersion({
      identify: (req: any) => req.__clientId,
      resolvePin: async () => "ancient",
      fallback: "CURRENT",
      supportedVersions: ["CURRENT"],
      onStalePin: "passthrough",
    });

    expect(await resolver(fakeReq("c1"))).toBe("ancient");
  });
});

describe("cachedPerClientDefaultVersion — ttlMs edges", () => {
  it("ttlMs: 0 disables caching (resolvePin fires every call)", async () => {
    const resolvePin = vi.fn(async (id: string) => `pin-${id}`);
    const { resolver } = cachedPerClientDefaultVersion({
      identify: (req: any) => req.__clientId,
      resolvePin,
      fallback: "F",
      ttlMs: 0,
    });

    await resolver(fakeReq("c1"));
    await resolver(fakeReq("c1"));
    await resolver(fakeReq("c1"));
    expect(resolvePin).toHaveBeenCalledTimes(3);
  });

  it("throws at construction on negative ttlMs", () => {
    expect(() =>
      cachedPerClientDefaultVersion({
        identify: () => "c",
        resolvePin: async () => null,
        fallback: "F",
        ttlMs: -1,
      }),
    ).toThrow(/ttlMs must be >= 0/i);
  });
});
