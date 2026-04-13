/**
 * route-generation-extra-coverage.test.ts
 *
 * Extra tests targeting uncovered branches in `src/route-generation.ts`:
 *   - Path-based converter validation (validatePathConverterUsage)
 *   - extractPathParams (via endpoint().had({ path })) and path-param validation
 *   - endpoint_didntExist error branches
 *   - endpoint_existed error branches
 *   - applyEndpointHadInstruction no-op detection for every attribute
 *   - Multipart/form-data parsing path (multer integration)
 *   - String response migration path (JSON string parsed for migration)
 *   - HttpError migration edge cases (custom headers, setCookie, plain errors)
 *
 * All tests are self-contained and use function-wrapper migrations so the
 * file works cleanly without decorator metadata.
 *
 * Run: npx vitest run tests/route-generation-extra-coverage.test.ts
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { z } from "zod";

import {
  Tsadwyn,
  Version,
  VersionBundle,
  VersionChange,
  VersionedRouter,
  schema,
  endpoint,
  convertRequestToNextVersionFor,
  convertResponseToPreviousVersionFor,
  RequestInfo,
  ResponseInfo,
  HttpError,
  RouterGenerationError,
  RouteAlreadyExistsError,
  RouterPathParamsModifiedError,
  RouteByPathConverterDoesNotApplyToAnythingError,
} from "../src/index.js";

// Unique-name helper to avoid collisions across tests and with other files.
let __uniq = 0;
const uniq = (prefix: string) => `RGE_${prefix}_${++__uniq}`;

// ═══════════════════════════════════════════════════════════════════════════
// Section 1: validatePathConverterUsage — path-based converter validation
// ═══════════════════════════════════════════════════════════════════════════

describe("Section 1: path-based converter validation", () => {
  it("throws when a request path converter targets a path that does not exist", () => {
    const Res = z.object({ ok: z.boolean() }).named(uniq("S1a_Res"));

    class Change extends VersionChange {
      description = "request path converter for a nonexistent path";
      instructions: any[] = [];
      migrateReq = convertRequestToNextVersionFor("/nonexistent", ["GET"])(
        (_req: RequestInfo) => {
          // no-op
        },
      );
    }

    const router = new VersionedRouter();
    router.get("/users", null, Res, async () => ({ ok: true }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", Change),
        new Version("2000-01-01"),
      ),
    });

    expect(() => app.generateAndIncludeVersionedRouters(router)).toThrow(
      RouteByPathConverterDoesNotApplyToAnythingError,
    );
  });

  it("throws when a response path converter targets a path that does not exist", () => {
    const Res = z.object({ ok: z.boolean() }).named(uniq("S1b_Res"));

    class Change extends VersionChange {
      description = "response path converter for a nonexistent path";
      instructions: any[] = [];
      migrateRes = convertResponseToPreviousVersionFor("/nope", ["GET"])(
        (_res: ResponseInfo) => {
          // no-op
        },
      );
    }

    const router = new VersionedRouter();
    router.get("/users", null, Res, async () => ({ ok: true }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", Change),
        new Version("2000-01-01"),
      ),
    });

    expect(() => app.generateAndIncludeVersionedRouters(router)).toThrow(
      RouteByPathConverterDoesNotApplyToAnythingError,
    );
  });

  it("throws when a request path converter targets an existing path but wrong method", () => {
    const Res = z.object({ ok: z.boolean() }).named(uniq("S1c_Res"));

    class Change extends VersionChange {
      description = "request path converter where path is right, method is wrong";
      instructions: any[] = [];
      migrateReq = convertRequestToNextVersionFor("/users", ["PATCH"])(
        (_req: RequestInfo) => {
          // no-op
        },
      );
    }

    const router = new VersionedRouter();
    router.get("/users", null, Res, async () => ({ ok: true }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", Change),
        new Version("2000-01-01"),
      ),
    });

    expect(() => app.generateAndIncludeVersionedRouters(router)).toThrow(
      RouteByPathConverterDoesNotApplyToAnythingError,
    );
  });

  it("throws when a response path converter targets an existing path but wrong method", () => {
    const Res = z.object({ ok: z.boolean() }).named(uniq("S1d_Res"));

    class Change extends VersionChange {
      description = "response path converter where path is right, method is wrong";
      instructions: any[] = [];
      migrateRes = convertResponseToPreviousVersionFor("/users", ["DELETE"])(
        (_res: ResponseInfo) => {
          // no-op
        },
      );
    }

    const router = new VersionedRouter();
    router.get("/users", null, Res, async () => ({ ok: true }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", Change),
        new Version("2000-01-01"),
      ),
    });

    expect(() => app.generateAndIncludeVersionedRouters(router)).toThrow(
      RouteByPathConverterDoesNotApplyToAnythingError,
    );
  });

  it("does NOT throw when a path converter has mixed methods (at least one match)", () => {
    // The route exists as GET; converter methods are [GET, PATCH].
    // PATCH is missing but GET matches, so it should pass validation.
    const Res = z.object({ ok: z.boolean() }).named(uniq("S1e_Res"));

    class Change extends VersionChange {
      description = "mixed methods: one valid, one invalid -> no throw";
      instructions: any[] = [];
      migrateReq = convertRequestToNextVersionFor("/widgets", ["GET", "PATCH"])(
        (_req: RequestInfo) => {
          // no-op
        },
      );
      migrateRes = convertResponseToPreviousVersionFor("/widgets", ["GET", "PATCH"])(
        (_res: ResponseInfo) => {
          // no-op
        },
      );
    }

    const router = new VersionedRouter();
    router.get("/widgets", null, Res, async () => ({ ok: true }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", Change),
        new Version("2000-01-01"),
      ),
    });

    expect(() => app.generateAndIncludeVersionedRouters(router)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 2: endpoint_didntExist error paths
// ═══════════════════════════════════════════════════════════════════════════

describe("Section 2: endpoint_didntExist error paths", () => {
  it("throws when .didntExist targets an endpoint that does not exist", () => {
    const Res = z.object({ ok: z.boolean() }).named(uniq("S2a_Res"));

    class Change extends VersionChange {
      description = "delete an endpoint that was never registered";
      instructions = [endpoint("/ghost", ["GET"]).didntExist];
    }

    const router = new VersionedRouter();
    router.get("/real", null, Res, async () => ({ ok: true }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", Change),
        new Version("2000-01-01"),
      ),
    });

    expect(() => app.generateAndIncludeVersionedRouters(router)).toThrow(
      RouterGenerationError,
    );
    expect(() => app.generateAndIncludeVersionedRouters(router)).toThrow(
      /doesn't exist in a newer version/,
    );
  });

  it("throws when .didntExist is applied twice across two VersionChanges (already deleted)", () => {
    const Res = z.object({ ok: z.boolean() }).named(uniq("S2b_Res"));

    class DeleteFirst extends VersionChange {
      description = "delete the endpoint (first pass, newer version)";
      instructions = [endpoint("/gone", ["GET"]).didntExist];
    }
    class DeleteAgain extends VersionChange {
      description = "delete the endpoint (second pass, older version)";
      instructions = [endpoint("/gone", ["GET"]).didntExist];
    }

    const router = new VersionedRouter();
    router.get("/gone", null, Res, async () => ({ ok: true }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2002-01-01", DeleteFirst),
        new Version("2001-01-01", DeleteAgain),
        new Version("2000-01-01"),
      ),
    });

    expect(() => app.generateAndIncludeVersionedRouters(router)).toThrow(
      RouterGenerationError,
    );
    expect(() => app.generateAndIncludeVersionedRouters(router)).toThrow(
      /was already deleted in a newer version/,
    );
  });

  it("removes the endpoint from the older version's Express router when .didntExist is applied", async () => {
    const Res = z.object({ ok: z.boolean() }).named(uniq("S2c_Res"));

    class Change extends VersionChange {
      description = "delete /temp in the newer version";
      instructions = [endpoint("/temp", ["GET"]).didntExist];
    }

    const router = new VersionedRouter();
    router.get("/temp", null, Res, async () => ({ ok: true }));
    router.get("/kept", null, Res, async () => ({ ok: true }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", Change),
        new Version("2000-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    // /temp didntExist in the new version means it doesn't exist at 2000-01-01 either
    // (the instruction deletes it going backwards).
    const res2000 = await request(app.expressApp)
      .get("/temp")
      .set("x-api-version", "2000-01-01");
    expect(res2000.status).toBe(404);

    // The other route is still reachable on both versions.
    const kept2000 = await request(app.expressApp)
      .get("/kept")
      .set("x-api-version", "2000-01-01");
    expect(kept2000.status).toBe(200);

    // Newer version: /temp should still exist.
    const res2001 = await request(app.expressApp)
      .get("/temp")
      .set("x-api-version", "2001-01-01");
    expect(res2001.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 3: endpoint_existed error paths
// ═══════════════════════════════════════════════════════════════════════════

describe("Section 3: endpoint_existed error paths", () => {
  it("throws when onlyExistsInOlderVersions targets a non-registered route", () => {
    const router = new VersionedRouter();
    const Res = z.object({ ok: z.boolean() }).named(uniq("S3a_Res"));
    router.get("/real", null, Res, async () => ({ ok: true }));

    expect(() => router.onlyExistsInOlderVersions("/ghost", ["GET"])).toThrow();
  });

  it("throws when endpoint().existed targets an endpoint that already exists in the newer version", () => {
    const Res = z.object({ ok: z.boolean() }).named(uniq("S3b_Res"));

    class Change extends VersionChange {
      description = "try to 'restore' a route that is still alive";
      instructions = [endpoint("/alive", ["GET"]).existed];
    }

    const router = new VersionedRouter();
    router.get("/alive", null, Res, async () => ({ ok: true }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", Change),
        new Version("2000-01-01"),
      ),
    });

    expect(() => app.generateAndIncludeVersionedRouters(router)).toThrow(
      RouterGenerationError,
    );
    expect(() => app.generateAndIncludeVersionedRouters(router)).toThrow(
      /already existed in a newer version/,
    );
  });

  it("throws when endpoint().existed targets a non-deleted endpoint", () => {
    // When the endpoint is not present at all (neither alive nor deleted),
    // originalRoutes is empty (so we pass the first check) but deletedRoutes
    // is also empty -> "wasn't among the deleted routes".
    class Change extends VersionChange {
      description = "restore a route that was never deleted nor registered";
      instructions = [endpoint("/never-here", ["GET"]).existed];
    }

    const router = new VersionedRouter();
    const Res = z.object({ ok: z.boolean() }).named(uniq("S3c_Res"));
    router.get("/other", null, Res, async () => ({ ok: true }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", Change),
        new Version("2000-01-01"),
      ),
    });

    expect(() => app.generateAndIncludeVersionedRouters(router)).toThrow(
      RouterGenerationError,
    );
    expect(() => app.generateAndIncludeVersionedRouters(router)).toThrow(
      /wasn't among the deleted routes/,
    );
  });

  it("throws RouteAlreadyExistsError when two deleted routes match and no funcName is given", () => {
    const Res = z.object({ ok: z.boolean() }).named(uniq("S3d_Res"));

    const router = new VersionedRouter();
    async function alpha() { return { ok: true }; }
    async function beta() { return { ok: false }; }
    router.get("/dup", null, Res, alpha);
    router.get("/dup", null, Res, beta);
    router.onlyExistsInOlderVersions("/dup", ["GET"]);

    class RestoreAmbiguous extends VersionChange {
      description = "restore /dup without funcName";
      instructions = [endpoint("/dup", ["GET"]).existed];
    }

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", RestoreAmbiguous),
        new Version("2000-01-01"),
      ),
    });

    expect(() => app.generateAndIncludeVersionedRouters(router)).toThrow(
      RouteAlreadyExistsError,
    );
  });

  it("succeeds when using funcName to disambiguate .existed", async () => {
    const Res = z.object({ which: z.string() }).named(uniq("S3e_Res"));

    const router = new VersionedRouter();
    async function alpha() { return { which: "alpha" }; }
    async function beta() { return { which: "beta" }; }
    router.get("/dup2", null, Res, alpha);
    router.get("/dup2", null, Res, beta);
    router.onlyExistsInOlderVersions("/dup2", ["GET"]);

    class RestoreAlpha extends VersionChange {
      description = "restore /dup2 specifically targeting alpha";
      instructions = [endpoint("/dup2", ["GET"], "alpha").existed];
    }
    class RestoreBeta extends VersionChange {
      description = "restore /dup2 specifically targeting beta";
      instructions = [endpoint("/dup2", ["GET"], "beta").existed];
    }

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", RestoreAlpha, RestoreBeta),
        new Version("2000-01-01"),
      ),
    });

    expect(() => app.generateAndIncludeVersionedRouters(router)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 4: applyEndpointHadInstruction no-op detection
// ═══════════════════════════════════════════════════════════════════════════

describe("Section 4: endpoint().had() no-op detection per attribute", () => {
  function expectNoOp(routerSetup: (r: VersionedRouter) => void, instruction: any) {
    const router = new VersionedRouter();
    routerSetup(router);

    class NoOp extends VersionChange {
      description = "no-op endpoint change";
      instructions = [instruction];
    }

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", NoOp),
        new Version("2000-01-01"),
      ),
    });

    expect(() => app.generateAndIncludeVersionedRouters(router)).toThrow(
      RouterGenerationError,
    );
    expect(() => app.generateAndIncludeVersionedRouters(router)).toThrow(
      /no effect|no-op/i,
    );
  }

  it("throws on had({ statusCode: 200 }) when route already has statusCode 200", () => {
    const Res = z.object({ ok: z.boolean() }).named(uniq("S4a_Res"));
    expectNoOp(
      (r) => r.get("/n4a", null, Res, async () => ({ ok: true })),
      endpoint("/n4a", ["GET"]).had({ statusCode: 200 }),
    );
  });

  it("throws on had({ deprecated: false }) when route is already non-deprecated", () => {
    const Res = z.object({ ok: z.boolean() }).named(uniq("S4b_Res"));
    expectNoOp(
      (r) => r.get("/n4b", null, Res, async () => ({ ok: true })),
      endpoint("/n4b", ["GET"]).had({ deprecated: false }),
    );
  });

  it("throws on had({ summary: 'same' }) when summary already equals 'same'", () => {
    // Freshly-registered routes have summary = "". Match that.
    const Res = z.object({ ok: z.boolean() }).named(uniq("S4c_Res"));
    expectNoOp(
      (r) => r.get("/n4c", null, Res, async () => ({ ok: true })),
      endpoint("/n4c", ["GET"]).had({ summary: "" }),
    );
  });

  it("throws on had({ description: 'same' }) when description already equals 'same'", () => {
    const Res = z.object({ ok: z.boolean() }).named(uniq("S4d_Res"));
    expectNoOp(
      (r) => r.get("/n4d", null, Res, async () => ({ ok: true })),
      endpoint("/n4d", ["GET"]).had({ description: "" }),
    );
  });

  it("throws on had({ tags: [] }) when route has no user tags", () => {
    const Res = z.object({ ok: z.boolean() }).named(uniq("S4e_Res"));
    expectNoOp(
      (r) => r.get("/n4e", null, Res, async () => ({ ok: true })),
      endpoint("/n4e", ["GET"]).had({ tags: [] }),
    );
  });

  it("throws on had({ operationId: '' }) when operationId already matches", () => {
    const Res = z.object({ ok: z.boolean() }).named(uniq("S4f_Res"));
    expectNoOp(
      (r) => r.get("/n4f", null, Res, async () => ({ ok: true })),
      endpoint("/n4f", ["GET"]).had({ operationId: "" }),
    );
  });

  it("throws on had({ includeInSchema: true }) when it's already true (default)", () => {
    const Res = z.object({ ok: z.boolean() }).named(uniq("S4g_Res"));
    expectNoOp(
      (r) => r.get("/n4g", null, Res, async () => ({ ok: true })),
      endpoint("/n4g", ["GET"]).had({ includeInSchema: true }),
    );
  });

  it("throws on had({ responses: null }) when route.responses is null", () => {
    // The no-op check uses JSON.stringify, so passing the same value should match.
    const Res = z.object({ ok: z.boolean() }).named(uniq("S4h_Res"));
    expectNoOp(
      (r) => r.get("/n4h", null, Res, async () => ({ ok: true })),
      endpoint("/n4h", ["GET"]).had({ responses: null as any }),
    );
  });

  it("throws on had({ callbacks: null }) when route.callbacks is null", () => {
    const Res = z.object({ ok: z.boolean() }).named(uniq("S4i_Res"));
    expectNoOp(
      (r) => r.get("/n4i", null, Res, async () => ({ ok: true })),
      endpoint("/n4i", ["GET"]).had({ callbacks: null as any }),
    );
  });

  it("does NOT throw when mixing a no-op attr with a changing attr", () => {
    // statusCode 200 is a no-op but deprecated changes from false -> true.
    const Res = z.object({ ok: z.boolean() }).named(uniq("S4j_Res"));

    const router = new VersionedRouter();
    router.get("/mix", null, Res, async () => ({ ok: true }));

    class MixedChange extends VersionChange {
      description = "mixed no-op + real change";
      instructions = [
        endpoint("/mix", ["GET"]).had({ statusCode: 200, deprecated: true }),
      ];
    }

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", MixedChange),
        new Version("2000-01-01"),
      ),
    });

    expect(() => app.generateAndIncludeVersionedRouters(router)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 4b: applyEndpointHadInstruction — exercising "apply" branches
//   Each test passes a non-no-op version of one attribute so the
//   `if (attrs.X !== undefined)` apply branches are all exercised.
// ═══════════════════════════════════════════════════════════════════════════

describe("Section 4b: endpoint().had() successful apply per attribute", () => {
  function makeApplyApp(
    routerSetup: (r: VersionedRouter) => void,
    instruction: any,
  ) {
    const router = new VersionedRouter();
    routerSetup(router);

    class ApplyChange extends VersionChange {
      description = "real attribute change";
      instructions = [instruction];
    }

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", ApplyChange),
        new Version("2000-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);
    return app;
  }

  it("applies had({ methods }) — changes the HTTP method on the older version", () => {
    const Res = z.object({ ok: z.boolean() }).named(uniq("S4b_M_Res"));
    expect(() =>
      makeApplyApp(
        (r) => r.get("/m-change", null, Res, async () => ({ ok: true })),
        endpoint("/m-change", ["GET"]).had({ methods: ["POST"] }),
      ),
    ).not.toThrow();
  });

  it("applies had({ statusCode }) — changes statusCode", () => {
    const Res = z.object({ ok: z.boolean() }).named(uniq("S4b_SC_Res"));
    expect(() =>
      makeApplyApp(
        (r) => r.get("/sc-change", null, Res, async () => ({ ok: true })),
        endpoint("/sc-change", ["GET"]).had({ statusCode: 201 }),
      ),
    ).not.toThrow();
  });

  it("applies had({ deprecated: true }) — marks as deprecated", () => {
    const Res = z.object({ ok: z.boolean() }).named(uniq("S4b_Dep_Res"));
    expect(() =>
      makeApplyApp(
        (r) => r.get("/dep-change", null, Res, async () => ({ ok: true })),
        endpoint("/dep-change", ["GET"]).had({ deprecated: true }),
      ),
    ).not.toThrow();
  });

  it("applies had({ summary }) — sets summary", () => {
    const Res = z.object({ ok: z.boolean() }).named(uniq("S4b_Sum_Res"));
    expect(() =>
      makeApplyApp(
        (r) => r.get("/sum-change", null, Res, async () => ({ ok: true })),
        endpoint("/sum-change", ["GET"]).had({ summary: "new summary text" }),
      ),
    ).not.toThrow();
  });

  it("applies had({ description }) — sets description", () => {
    const Res = z.object({ ok: z.boolean() }).named(uniq("S4b_Desc_Res"));
    expect(() =>
      makeApplyApp(
        (r) => r.get("/desc-change", null, Res, async () => ({ ok: true })),
        endpoint("/desc-change", ["GET"]).had({ description: "new description" }),
      ),
    ).not.toThrow();
  });

  it("applies had({ tags }) — sets tags", () => {
    const Res = z.object({ ok: z.boolean() }).named(uniq("S4b_Tags_Res"));
    expect(() =>
      makeApplyApp(
        (r) => r.get("/tags-change", null, Res, async () => ({ ok: true })),
        endpoint("/tags-change", ["GET"]).had({ tags: ["tag-a", "tag-b"] }),
      ),
    ).not.toThrow();
  });

  it("applies had({ operationId }) — sets operationId", () => {
    const Res = z.object({ ok: z.boolean() }).named(uniq("S4b_OpId_Res"));
    expect(() =>
      makeApplyApp(
        (r) => r.get("/opid-change", null, Res, async () => ({ ok: true })),
        endpoint("/opid-change", ["GET"]).had({ operationId: "opForOld" }),
      ),
    ).not.toThrow();
  });

  it("applies had({ includeInSchema: false })", () => {
    const Res = z.object({ ok: z.boolean() }).named(uniq("S4b_IncSch_Res"));
    expect(() =>
      makeApplyApp(
        (r) => r.get("/inc-change", null, Res, async () => ({ ok: true })),
        endpoint("/inc-change", ["GET"]).had({ includeInSchema: false }),
      ),
    ).not.toThrow();
  });

  it("applies had({ responses }) — sets responses mapping", () => {
    const Res = z.object({ ok: z.boolean() }).named(uniq("S4b_Resp_Res"));
    expect(() =>
      makeApplyApp(
        (r) => r.get("/resp-change", null, Res, async () => ({ ok: true })),
        endpoint("/resp-change", ["GET"]).had({
          responses: { "404": { description: "not found" } },
        }),
      ),
    ).not.toThrow();
  });

  it("applies had({ callbacks }) — sets callbacks", () => {
    const Res = z.object({ ok: z.boolean() }).named(uniq("S4b_Cb_Res"));
    expect(() =>
      makeApplyApp(
        (r) => r.get("/cb-change", null, Res, async () => ({ ok: true })),
        endpoint("/cb-change", ["GET"]).had({
          callbacks: [{ path: "/cb", method: "POST" }],
        }),
      ),
    ).not.toThrow();
  });

  it("throws on no-op had({ methods }) when method is already the same", () => {
    // Cover the no-op detection branch when methods is specified.
    const Res = z.object({ ok: z.boolean() }).named(uniq("S4b_M_NoOp_Res"));
    const router = new VersionedRouter();
    router.get("/m-noop", null, Res, async () => ({ ok: true }));

    class NoOp extends VersionChange {
      description = "no-op methods";
      instructions = [endpoint("/m-noop", ["GET"]).had({ methods: ["GET"] })];
    }

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", NoOp),
        new Version("2000-01-01"),
      ),
    });

    expect(() => app.generateAndIncludeVersionedRouters(router)).toThrow(
      /no effect|no-op/i,
    );
  });

  it("throws on no-op had({ path }) when path is already the same", () => {
    // Cover the no-op detection branch when path is specified to the same value.
    const Res = z.object({ ok: z.boolean() }).named(uniq("S4b_P_NoOp_Res"));
    const router = new VersionedRouter();
    router.get("/p-noop", null, Res, async () => ({ ok: true }));

    class NoOp extends VersionChange {
      description = "no-op path";
      instructions = [endpoint("/p-noop", ["GET"]).had({ path: "/p-noop" })];
    }

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", NoOp),
        new Version("2000-01-01"),
      ),
    });

    expect(() => app.generateAndIncludeVersionedRouters(router)).toThrow(
      /no effect|no-op/i,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 5: applyEndpointHadInstruction path param validation
// ═══════════════════════════════════════════════════════════════════════════

describe("Section 5: endpoint().had({ path }) path-param validation", () => {
  it("succeeds when path changes but params are preserved (/users/:id -> /customers/:id)", async () => {
    const Res = z.object({ id: z.string() }).named(uniq("S5a_Res"));

    const router = new VersionedRouter();
    router.get("/users/:id", null, Res, async (req) => ({ id: String(req.params.id) }));

    class Change extends VersionChange {
      description = "rename /users -> /customers, keep :id";
      instructions = [
        endpoint("/users/:id", ["GET"]).had({ path: "/customers/:id" }),
      ];
    }

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", Change),
        new Version("2000-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    // New version: /users/:id remains (the rename moves the older version to /customers).
    const newRes = await request(app.expressApp)
      .get("/users/abc")
      .set("x-api-version", "2001-01-01");
    expect(newRes.status).toBe(200);

    // Older version: the path is /customers/:id.
    const oldRes = await request(app.expressApp)
      .get("/customers/abc")
      .set("x-api-version", "2000-01-01");
    expect(oldRes.status).toBe(200);
    expect(oldRes.body.id).toBe("abc");
  });

  it("throws RouterPathParamsModifiedError when params differ (/users/:id -> /users/:userId)", () => {
    const Res = z.object({ ok: z.boolean() }).named(uniq("S5b_Res"));

    const router = new VersionedRouter();
    router.get("/users/:id", null, Res, async () => ({ ok: true }));

    class Change extends VersionChange {
      description = "rename path param :id -> :userId (disallowed)";
      instructions = [
        endpoint("/users/:id", ["GET"]).had({ path: "/users/:userId" }),
      ];
    }

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", Change),
        new Version("2000-01-01"),
      ),
    });

    expect(() => app.generateAndIncludeVersionedRouters(router)).toThrow(
      RouterPathParamsModifiedError,
    );
  });

  it("succeeds when param order differs but the set is the same (sorted comparison)", () => {
    const Res = z.object({ ok: z.boolean() }).named(uniq("S5c_Res"));

    const router = new VersionedRouter();
    router.get("/users/:id/items/:itemId", null, Res, async () => ({ ok: true }));

    class Change extends VersionChange {
      description = "reorder path params";
      instructions = [
        endpoint("/users/:id/items/:itemId", ["GET"]).had({
          path: "/users/:itemId/items/:id",
        }),
      ];
    }

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", Change),
        new Version("2000-01-01"),
      ),
    });

    expect(() => app.generateAndIncludeVersionedRouters(router)).not.toThrow();
  });

  it("throws RouterPathParamsModifiedError when a param is removed (/users/:id -> /users)", () => {
    const Res = z.object({ ok: z.boolean() }).named(uniq("S5d_Res"));

    const router = new VersionedRouter();
    router.get("/users/:id", null, Res, async () => ({ ok: true }));

    class Change extends VersionChange {
      description = "remove the :id path param";
      instructions = [
        endpoint("/users/:id", ["GET"]).had({ path: "/users" }),
      ];
    }

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", Change),
        new Version("2000-01-01"),
      ),
    });

    expect(() => app.generateAndIncludeVersionedRouters(router)).toThrow(
      RouterPathParamsModifiedError,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 6: multipart/form-data request migration
// ═══════════════════════════════════════════════════════════════════════════

describe("Section 6: multipart/form-data request migration", () => {
  it("migration sees multipart form text fields in RequestInfo.form", async () => {
    const seenForm: Array<[string, any]> = [];
    const Res = z.object({ ok: z.boolean() }).named(uniq("S6a_Res"));

    class Change extends VersionChange {
      description = "inspect multipart form text field";
      instructions: any[] = [];
      migrateReq = convertRequestToNextVersionFor("/upload-text", ["POST"])(
        (req: RequestInfo) => {
          if (req.form) {
            for (const entry of req.form) {
              seenForm.push([entry[0], entry[1]]);
            }
          }
        },
      );
    }

    const router = new VersionedRouter();
    router.post("/upload-text", null, Res, async () => ({ ok: true }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", Change),
        new Version("2000-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .post("/upload-text")
      .set("x-api-version", "2000-01-01")
      .field("name", "alice")
      .field("role", "admin");

    expect(res.status).toBe(200);
    const keys = seenForm.map(([k]) => k).sort();
    expect(keys).toEqual(["name", "role"]);
    const nameEntry = seenForm.find(([k]) => k === "name");
    expect(nameEntry?.[1]).toBe("alice");
  });

  it("migration sees uploaded file's originalname in RequestInfo.form", async () => {
    const seenForm: Array<[string, any]> = [];
    const Res = z.object({ ok: z.boolean() }).named(uniq("S6b_Res"));

    class Change extends VersionChange {
      description = "inspect multipart form file field";
      instructions: any[] = [];
      migrateReq = convertRequestToNextVersionFor("/upload-file", ["POST"])(
        (req: RequestInfo) => {
          if (req.form) {
            for (const entry of req.form) {
              seenForm.push([entry[0], entry[1]]);
            }
          }
        },
      );
    }

    const handlerSeen: { hasFiles: boolean } = { hasFiles: false };
    const router = new VersionedRouter();
    router.post("/upload-file", null, Res, async (req) => {
      // After multer runs, req.files should be populated.
      handlerSeen.hasFiles = Array.isArray((req as any).headers);
      return { ok: true };
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", Change),
        new Version("2000-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .post("/upload-file")
      .set("x-api-version", "2000-01-01")
      .field("caption", "hello")
      .attach("document", Buffer.from("file contents"), "report.txt");

    expect(res.status).toBe(200);
    // Form array should include the caption text field AND the file entry.
    const fileEntry = seenForm.find(([k]) => k === "document");
    expect(fileEntry).toBeDefined();
    expect(fileEntry?.[1]).toBe("report.txt");
    const capEntry = seenForm.find(([k]) => k === "caption");
    expect(capEntry?.[1]).toBe("hello");
  });

  it("handler receives the migrated body from multipart form data", async () => {
    const Res = z.object({ name: z.string() }).named(uniq("S6c_Res"));

    class Change extends VersionChange {
      description = "migration that uppercases a field in the multipart body";
      instructions: any[] = [];
      migrateReq = convertRequestToNextVersionFor("/multi-body", ["POST"])(
        (req: RequestInfo) => {
          if (req.body && typeof req.body === "object" && req.body.name) {
            req.body.name = String(req.body.name).toUpperCase();
          }
        },
      );
    }

    const router = new VersionedRouter();
    router.post("/multi-body", null, Res, async (req: any) => ({
      name: String(req.body?.name ?? ""),
    }));

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", Change),
        new Version("2000-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .post("/multi-body")
      .set("x-api-version", "2000-01-01")
      .field("name", "bob");

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("BOB");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 7: string response migration path
// ═══════════════════════════════════════════════════════════════════════════

describe("Section 7: string response migration path", () => {
  it("sends a JSON string as-is when there are no migrations", async () => {
    const router = new VersionedRouter();
    router.get("/str-json-nomig", null, null, async () => {
      return JSON.stringify({ foo: "bar" });
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2000-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .get("/str-json-nomig")
      .set("x-api-version", "2000-01-01");

    expect(res.status).toBe(200);
    // No migrations -> sendNonJsonResponse -> text/plain with the raw JSON string.
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toBe('{"foo":"bar"}');
  });

  it("runs migrations against a parsed JSON string response body", async () => {
    // The handler returns a JSON string. Because there is a response migration
    // targeting this path, route-generation attempts to parse the string and
    // runs the migration against the parsed body.
    const Res = z.object({ foo: z.string() }).named(uniq("S7b_Res"));

    class Change extends VersionChange {
      description = "append '!' to foo in response";
      instructions: any[] = [];
      migrateRes = convertResponseToPreviousVersionFor("/str-json-mig", ["GET"])(
        (res: ResponseInfo) => {
          if (res.body && typeof res.body === "object" && typeof res.body.foo === "string") {
            res.body.foo = res.body.foo + "!";
          }
        },
      );
    }

    const router = new VersionedRouter();
    router.get("/str-json-mig", null, Res, async () => {
      return JSON.stringify({ foo: "bar" }) as any;
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", Change),
        new Version("2000-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .get("/str-json-mig")
      .set("x-api-version", "2000-01-01");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.foo).toBe("bar!");
  });

  it("sends a non-JSON string as text/plain when there are no migrations", async () => {
    const router = new VersionedRouter();
    router.get("/str-plain-nomig", null, null, async () => "hello world");

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2000-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .get("/str-plain-nomig")
      .set("x-api-version", "2000-01-01");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toBe("hello world");
  });

  it("sends a non-JSON string as text/plain when migrations exist but JSON.parse fails", async () => {
    // The handler returns a non-JSON string. There is a response migration, so
    // route-generation tries to JSON.parse, which throws, and falls through
    // to sendNonJsonResponse.
    const Res = z.object({ dummy: z.string() }).named(uniq("S7d_Res"));

    class Change extends VersionChange {
      description = "dummy migration that should never touch a non-JSON string";
      instructions: any[] = [];
      migrateRes = convertResponseToPreviousVersionFor("/str-plain-mig", ["GET"])(
        (res: ResponseInfo) => {
          if (res.body && typeof res.body === "object") {
            res.body.touched = true;
          }
        },
      );
    }

    const router = new VersionedRouter();
    router.get("/str-plain-mig", null, Res, async () => "not-json-at-all" as any);

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", Change),
        new Version("2000-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .get("/str-plain-mig")
      .set("x-api-version", "2000-01-01");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toBe("not-json-at-all");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 8: HttpError migration edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Section 8: HttpError migration edge cases", () => {
  it("applies HttpError custom headers to the Express response", async () => {
    const Res = z.object({ msg: z.string() }).named(uniq("S8a_Res"));

    class NoMigration extends VersionChange {
      description = "no migration, just to ensure migration path runs";
      instructions: any[] = [];
    }

    const router = new VersionedRouter();
    router.get("/http-hdr", null, Res, async () => {
      throw new HttpError(
        503,
        { msg: "unavailable" },
        { "x-service": "tsadwyn", "retry-after": "120" },
      );
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", NoMigration),
        new Version("2000-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .get("/http-hdr")
      .set("x-api-version", "2000-01-01");

    expect(res.status).toBe(503);
    expect(res.body.msg).toBe("unavailable");
    expect(res.headers["x-service"]).toBe("tsadwyn");
    expect(res.headers["retry-after"]).toBe("120");
  });

  it("does not run migrations on HttpError body when migrateHttpErrors is false", async () => {
    const Res = z.object({ msg: z.string(), touched: z.boolean().optional() })
      .named(uniq("S8b_Res"));

    class Change extends VersionChange {
      description = "migration that would add touched=true; migrateHttpErrors false";
      instructions: any[] = [];
      migrateRes = convertResponseToPreviousVersionFor(Res, { migrateHttpErrors: false })(
        (res: ResponseInfo) => {
          if (res.body && typeof res.body === "object") {
            res.body.touched = true;
          }
        },
      );
    }

    const router = new VersionedRouter();
    router.get("/err-passthrough", null, Res, async () => {
      throw new HttpError(418, { msg: "teapot" });
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", Change),
        new Version("2000-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .get("/err-passthrough")
      .set("x-api-version", "2000-01-01");

    expect(res.status).toBe(418);
    expect(res.body.msg).toBe("teapot");
    expect(res.body.touched).toBeUndefined();
  });

  it("respects statusCode changes made by the HttpError migration", async () => {
    const Res = z.object({ msg: z.string() }).named(uniq("S8c_Res"));

    class ChangeStatus extends VersionChange {
      description = "migration that rewrites statusCode on HttpError";
      instructions: any[] = [];
      migrateRes = convertResponseToPreviousVersionFor(Res, { migrateHttpErrors: true })(
        (res: ResponseInfo) => {
          if (res.statusCode === 404) {
            res.statusCode = 410; // Gone
          }
        },
      );
    }

    const router = new VersionedRouter();
    router.get("/err-status", null, Res, async () => {
      throw new HttpError(404, { msg: "not found" });
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", ChangeStatus),
        new Version("2000-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .get("/err-status")
      .set("x-api-version", "2000-01-01");

    expect(res.status).toBe(410);
    expect(res.body.msg).toBe("not found");
  });

  it("applies setCookie() calls made during HttpError migration", async () => {
    const Res = z.object({ msg: z.string() }).named(uniq("S8d_Res"));

    class AddCookie extends VersionChange {
      description = "migration sets a cookie on the HttpError response";
      instructions: any[] = [];
      migrateRes = convertResponseToPreviousVersionFor(Res, { migrateHttpErrors: true })(
        (res: ResponseInfo) => {
          res.setCookie("err_seen", "1", { path: "/" });
        },
      );
    }

    const router = new VersionedRouter();
    router.get("/err-cookie", null, Res, async () => {
      throw new HttpError(500, { msg: "boom" });
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", AddCookie),
        new Version("2000-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .get("/err-cookie")
      .set("x-api-version", "2000-01-01");

    expect(res.status).toBe(500);
    expect(res.body.msg).toBe("boom");
    const setCookieHeader = res.headers["set-cookie"];
    expect(setCookieHeader).toBeDefined();
    const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    expect(cookies.some((c: string) => c.includes("err_seen=1"))).toBe(true);
  });

  it("passes a plain Error to next() without running HttpError migration", async () => {
    const Res = z.object({ msg: z.string() }).named(uniq("S8e_Res"));

    const migrationCalls: number[] = [];

    class Change extends VersionChange {
      description = "migration that must not run for a plain Error";
      instructions: any[] = [];
      migrateRes = convertResponseToPreviousVersionFor(Res, { migrateHttpErrors: true })(
        (_res: ResponseInfo) => {
          migrationCalls.push(1);
        },
      );
    }

    const router = new VersionedRouter();
    router.get("/plain-err", null, Res, async () => {
      throw new Error("this is a plain error, not HttpError");
    });

    const app = new Tsadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", Change),
        new Version("2000-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    // Attach a terminal error handler so Express has a place to send the error.
    app.expressApp.use((err: any, _req: any, res: any, _next: any) => {
      res.status(500).json({ caught: err.message });
    });

    const res = await request(app.expressApp)
      .get("/plain-err")
      .set("x-api-version", "2000-01-01");

    expect(res.status).toBe(500);
    expect(res.body.caught).toBe("this is a plain error, not HttpError");
    // The HttpError-only migration path should NOT have run.
    expect(migrationCalls.length).toBe(0);
  });
});
