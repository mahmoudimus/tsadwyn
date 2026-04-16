/**
 * FAILING TEST — statusCode: 204 with a non-null responseSchema is a
 * common footgun. The in-memory migration pipeline runs, but Node's
 * HTTP writer strips the body at the wire level per RFC 9110 §15.3.5
 * (verified empirically against api.stripe.com).
 *
 * tsadwyn should warn at generation time so consumers discover this
 * during development, not in production when a client reports "I'm
 * getting 204 but no body". The warning should recommend the fix
 * (use 200 or deletedResponseSchema).
 *
 * Run: npx vitest run tests/issue-204-body-lint.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";

import {
  Tsadwyn,
  Version,
  VersionBundle,
  VersionedRouter,
} from "../src/index.js";

describe("Issue: 204+body lint at generation time", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns when a route has statusCode: 204 AND a non-null responseSchema", () => {
    const DeleteResp = z
      .object({ id: z.string(), deleted: z.boolean() })
      .named("Issue204Lint_DeleteResp");

    const router = new VersionedRouter();
    router.delete(
      "/users/:id",
      null,
      DeleteResp,
      async () => ({ id: "x", deleted: true }),
      { statusCode: 204 },
    );

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const warned = warnSpy.mock.calls.some((args) =>
      args.some(
        (a) =>
          typeof a === "string" &&
          /204/.test(a) &&
          /users\/:id/.test(a) &&
          /(wire|strip|RFC|body.*not.*arrive|body won't arrive|deletedResponseSchema|statusCode.*200)/i.test(
            a,
          ),
      ),
    );
    expect(
      warned,
      `Expected a generation-time warn pointing out the 204+body wire-strip footgun. ` +
        `Got: ${JSON.stringify(warnSpy.mock.calls)}`,
    ).toBe(true);
  });

  it("does NOT warn when statusCode: 204 has a null responseSchema", () => {
    const router = new VersionedRouter();
    router.delete(
      "/users/:id",
      null,
      null,
      async () => undefined,
      { statusCode: 204 },
    );

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const warned = warnSpy.mock.calls.some((args) =>
      args.some(
        (a) => typeof a === "string" && /204/.test(a) && /wire|strip/i.test(a),
      ),
    );
    expect(warned).toBe(false);
  });

  it("does NOT warn for statusCode: 200 + non-null responseSchema (the recommended pattern)", () => {
    const DeleteResp = z
      .object({ id: z.string(), deleted: z.boolean() })
      .named("Issue204Lint_200DeleteResp");

    const router = new VersionedRouter();
    router.delete(
      "/users/:id",
      null,
      DeleteResp,
      async () => ({ id: "x", deleted: true }),
      // no statusCode override = defaults to 200
    );

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const warned = warnSpy.mock.calls.some((args) =>
      args.some(
        (a) => typeof a === "string" && /204/.test(a) && /wire|strip/i.test(a),
      ),
    );
    expect(warned).toBe(false);
  });

  it("warn message recommends the fix (200 or deletedResponseSchema)", () => {
    const DeleteResp = z
      .object({ id: z.string() })
      .named("Issue204Lint_RecommendResp");

    const router = new VersionedRouter();
    router.delete(
      "/items/:id",
      null,
      DeleteResp,
      async () => ({ id: "x" }),
      { statusCode: 204 },
    );

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2024-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const foundRecommendation = warnSpy.mock.calls.some((args) =>
      args.some(
        (a) =>
          typeof a === "string" &&
          /(deletedResponseSchema|statusCode.*200|use 200)/i.test(a),
      ),
    );
    expect(foundRecommendation).toBe(true);
  });
});
