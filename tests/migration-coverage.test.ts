/**
 * migration-coverage.test.ts
 *
 * Comprehensive tests for request/response migrations, covering edge cases in
 * `RequestInfo`, `ResponseInfo`, the migration chain, path-based migrations,
 * schema validation boundaries, and route generation options.
 *
 * All tests are self-contained: each creates its own schemas, VersionChange
 * classes, and Cadwyn app. Migrations use the function-wrapper style so the
 * file works cleanly with tsx/esbuild without TypeScript decorator metadata.
 *
 * Run:  npx vitest run tests/migration-coverage.test.ts
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { z } from "zod";
import type { Request, Response, NextFunction } from "express";

import {
  Cadwyn,
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
} from "../src/index.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a Cadwyn app with a simple 2-version (2001-01-01 → 2000-01-01) setup.
 * Newer version changes are prepended so the version list stays newest-first.
 */
function makeApp(
  ChangeClasses: Array<new () => VersionChange>,
  routerSetup: (router: VersionedRouter) => void,
  options: { prefix?: string } = {},
): Cadwyn {
  const router = new VersionedRouter({ prefix: options.prefix });
  routerSetup(router);

  const versionList: Version[] = [new Version("2000-01-01")];
  for (let i = 0; i < ChangeClasses.length; i++) {
    versionList.push(new Version(`${2001 + i}-01-01`, ChangeClasses[i]));
  }
  versionList.reverse();

  const app = new Cadwyn({
    versions: new VersionBundle(...versionList),
  });
  app.generateAndIncludeVersionedRouters(router);
  return app;
}

// A unique counter so every schema name is fresh across tests and does not
// collide with AlterSchemaInstructionFactory._knownSchemas across files.
let __uniq = 0;
const uniq = (prefix: string) => `MC_${prefix}_${++__uniq}`;

// ═══════════════════════════════════════════════════════════════════════════
// Section 1: Request body migration edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Section 1: request body migration edge cases", () => {
  it("1. migrates a nested object field", async () => {
    const UserInner = z.object({ name: z.string() }).named(uniq("UserInner"));
    const Req = z.object({ user: UserInner }).named(uniq("NestedReq"));
    const Res = z.object({ ok: z.boolean(), name: z.string() }).named(uniq("NestedRes"));

    class Change extends VersionChange {
      description = "uppercase user.name during migration";
      instructions: any[] = [];
      migrateReq = convertRequestToNextVersionFor(Req)(
        (req: RequestInfo) => {
          req.body.user.name = String(req.body.user.name).toUpperCase();
        },
      );
    }

    const app = makeApp([Change], (r) => {
      r.post("/u", Req, Res, async (req) => ({ ok: true, name: req.body.user.name }));
    });

    const res = await request(app.expressApp)
      .post("/u")
      .set("x-api-version", "2000-01-01")
      .send({ user: { name: "alice" } });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("ALICE");
  });

  it("2. migrates an array field by iterating each element", async () => {
    const Req = z.object({ tags: z.array(z.string()) }).named(uniq("TagsReq"));
    const Res = z.object({ tags: z.array(z.string()) }).named(uniq("TagsRes"));

    class Change extends VersionChange {
      description = "uppercase each tag";
      instructions: any[] = [];
      migrateReq = convertRequestToNextVersionFor(Req)(
        (req: RequestInfo) => {
          req.body.tags = req.body.tags.map((t: string) => t.toUpperCase());
        },
      );
    }

    const app = makeApp([Change], (r) => {
      r.post("/tags", Req, Res, async (req) => ({ tags: req.body.tags }));
    });

    const res = await request(app.expressApp)
      .post("/tags")
      .set("x-api-version", "2000-01-01")
      .send({ tags: ["a", "b", "c"] });

    expect(res.status).toBe(200);
    expect(res.body.tags).toEqual(["A", "B", "C"]);
  });

  it("3. adds a new field that the head schema requires", async () => {
    // Old clients send {a: 1}; head schema also requires b. Migration fills in b.
    const Req = z.object({ a: z.number(), b: z.number() }).named(uniq("ABReq"));
    const Res = z.object({ a: z.number(), b: z.number() }).named(uniq("ABRes"));

    class Change extends VersionChange {
      description = "add b with default 2 for old clients";
      instructions = [
        schema(Req).field("b").didntExist,
        schema(Res).field("b").didntExist,
      ];
      migrateReq = convertRequestToNextVersionFor(Req)(
        (req: RequestInfo) => {
          if (req.body.b === undefined) req.body.b = 2;
        },
      );
      migrateRes = convertResponseToPreviousVersionFor(Res)(
        (res: ResponseInfo) => {
          delete res.body.b;
        },
      );
    }

    const app = makeApp([Change], (r) => {
      r.post("/ab", Req, Res, async (req) => ({ a: req.body.a, b: req.body.b }));
    });

    const res = await request(app.expressApp)
      .post("/ab")
      .set("x-api-version", "2000-01-01")
      .send({ a: 1 });

    expect(res.status).toBe(200);
    // Old-version response should not include b
    expect(res.body.a).toBe(1);
    expect(res.body.b).toBeUndefined();
  });

  it("4. removes an old-only field going old → new", async () => {
    const Req = z
      .object({ new_field: z.string() })
      .named(uniq("RemoveOldReq"));
    const Res = z.object({ ok: z.boolean() }).named(uniq("RemoveOldRes"));

    class Change extends VersionChange {
      description = "remove old_field when migrating old -> new";
      instructions = [
        // Old version had old_field as a required string; head schema removed it.
        schema(Req).field("old_field").existedAs({ type: z.string() }),
      ];
      migrateReq = convertRequestToNextVersionFor(Req)((req: RequestInfo) => {
        // old_field should not reach the head schema; drop it
        delete req.body.old_field;
      });
    }

    const app = makeApp([Change], (r) => {
      r.post("/rm", Req, Res, async (req) => {
        // Verify that the handler only sees the head-schema fields
        expect((req.body as any).old_field).toBeUndefined();
        expect(req.body.new_field).toBe("y");
        return { ok: true };
      });
    });

    const res = await request(app.expressApp)
      .post("/rm")
      .set("x-api-version", "2000-01-01")
      .send({ old_field: "x", new_field: "y" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("5. chains request migrations across 3 versions", async () => {
    // v1 → v2 → v3: each step appends a token to the field.
    const Req = z.object({ val: z.string() }).named(uniq("ChainReq"));
    const Res = z.object({ val: z.string() }).named(uniq("ChainRes"));

    class V2toV3 extends VersionChange {
      description = "append '+v3'";
      instructions: any[] = [];
      migrateReq = convertRequestToNextVersionFor(Req)((req: RequestInfo) => {
        req.body.val = req.body.val + "+v3";
      });
    }
    class V1toV2 extends VersionChange {
      description = "append '+v2'";
      instructions: any[] = [];
      migrateReq = convertRequestToNextVersionFor(Req)((req: RequestInfo) => {
        req.body.val = req.body.val + "+v2";
      });
    }

    // Build a 3-version app (newest first).
    const router = new VersionedRouter();
    router.post("/chain", Req, Res, async (req) => ({ val: req.body.val }));
    const app = new Cadwyn({
      versions: new VersionBundle(
        new Version("2002-01-01", V2toV3),
        new Version("2001-01-01", V1toV2),
        new Version("2000-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    // Sending on the oldest version must run both migrations in order.
    const res = await request(app.expressApp)
      .post("/chain")
      .set("x-api-version", "2000-01-01")
      .send({ val: "base" });

    expect(res.status).toBe(200);
    expect(res.body.val).toBe("base+v2+v3");
  });

  it("6. migrates a field inside a nested named schema", async () => {
    const Inner = z.object({ inner_val: z.string() }).named(uniq("InnerSchema"));
    const Req = z.object({ outer: Inner }).named(uniq("OuterReq"));
    const Res = z.object({ outer: Inner }).named(uniq("OuterRes"));

    class Change extends VersionChange {
      description = "rename inner_val from old_inner_val on the inner schema";
      instructions = [
        schema(Inner).field("inner_val").had({ name: "old_inner_val" }),
      ];
      migrateReq = convertRequestToNextVersionFor(Req)((req: RequestInfo) => {
        if (req.body.outer && "old_inner_val" in req.body.outer) {
          req.body.outer.inner_val = req.body.outer.old_inner_val;
          delete req.body.outer.old_inner_val;
        }
      });
      migrateRes = convertResponseToPreviousVersionFor(Res)(
        (res: ResponseInfo) => {
          if (res.body.outer && "inner_val" in res.body.outer) {
            res.body.outer.old_inner_val = res.body.outer.inner_val;
            delete res.body.outer.inner_val;
          }
        },
      );
    }

    const app = makeApp([Change], (r) => {
      r.post("/nested", Req, Res, async (req) => ({ outer: req.body.outer }));
    });

    const res = await request(app.expressApp)
      .post("/nested")
      .set("x-api-version", "2000-01-01")
      .send({ outer: { old_inner_val: "hello" } });

    expect(res.status).toBe(200);
    expect(res.body.outer.old_inner_val).toBe("hello");
    expect(res.body.outer.inner_val).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 2: request headers / cookies / query migration
// ═══════════════════════════════════════════════════════════════════════════

describe("Section 2: request headers / cookies / query migration", () => {
  it("7. migration reads a header and copies it into the body", async () => {
    const Req = z
      .object({ legacy_version: z.string() })
      .named(uniq("HdrCopyReq"));
    const Res = z
      .object({ got: z.string() })
      .named(uniq("HdrCopyRes"));

    class Change extends VersionChange {
      description = "copy x-client-version header into body.legacy_version";
      instructions = [schema(Req).field("legacy_version").didntExist];
      migrateReq = convertRequestToNextVersionFor(Req)((req: RequestInfo) => {
        req.body = req.body ?? {};
        const v = req.headers["x-client-version"];
        if (v !== undefined) req.body.legacy_version = v;
      });
    }

    const app = makeApp([Change], (r) => {
      r.post("/hdr", Req, Res, async (req) => ({ got: req.body.legacy_version }));
    });

    const res = await request(app.expressApp)
      .post("/hdr")
      .set("x-api-version", "2000-01-01")
      .set("x-client-version", "legacy-42")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.got).toBe("legacy-42");
  });

  it("8. migration sets a header that the handler reads", async () => {
    const Req = z.object({ x: z.number() }).named(uniq("HdrSetReq"));
    const Res = z.object({ seen: z.string() }).named(uniq("HdrSetRes"));

    class Change extends VersionChange {
      description = "set a request header during migration";
      instructions: any[] = [];
      migrateReq = convertRequestToNextVersionFor(Req)((req: RequestInfo) => {
        req.headers["x-migrated-via"] = "tsadwyn";
      });
    }

    const app = makeApp([Change], (r) => {
      r.post("/hdr-set", Req, Res, async (req) => {
        return { seen: String(req.headers["x-migrated-via"] ?? "") };
      });
    });

    const res = await request(app.expressApp)
      .post("/hdr-set")
      .set("x-api-version", "2000-01-01")
      .send({ x: 1 });

    expect(res.status).toBe(200);
    expect(res.body.seen).toBe("tsadwyn");
  });

  it("9. migration adds a query param that the handler reads", async () => {
    const Req = z.object({ y: z.number() }).named(uniq("QSetReq"));
    const Res = z.object({ q: z.string() }).named(uniq("QSetRes"));

    class Change extends VersionChange {
      description = "add a query param in migration";
      instructions: any[] = [];
      migrateReq = convertRequestToNextVersionFor(Req)((req: RequestInfo) => {
        req.queryParams.injected = "from_migration";
      });
    }

    const app = makeApp([Change], (r) => {
      r.post("/q-set", Req, Res, async (req) => ({
        q: String((req.query as any).injected ?? ""),
      }));
    });

    const res = await request(app.expressApp)
      .post("/q-set")
      .set("x-api-version", "2000-01-01")
      .send({ y: 1 });

    expect(res.status).toBe(200);
    expect(res.body.q).toBe("from_migration");
  });

  it("10. migration can remove a header and deletion propagates to the handler", async () => {
    // Bug 2 fix: header deletions from RequestInfo.headers are now copied back
    // to Express req.headers, so the handler sees them removed.
    const Req = z.object({ v: z.number() }).named(uniq("HdrDelReq"));
    const Res = z
      .object({
        handler_sees_legacy: z.boolean(),
        deletion_confirmed: z.boolean(),
      })
      .named(uniq("HdrDelRes"));

    class Change extends VersionChange {
      description = "delete a header from the RequestInfo view";
      instructions: any[] = [];
      migrateReq = convertRequestToNextVersionFor(Req)((req: RequestInfo) => {
        expect("x-legacy" in req.headers).toBe(true);
        delete req.headers["x-legacy"];
        expect("x-legacy" in req.headers).toBe(false);
        req.headers["x-deletion-confirmed"] = "yes";
      });
    }

    const app = makeApp([Change], (r) => {
      r.post("/hdr-del", Req, Res, async (req) => ({
        // Handler should NOT see the legacy header (was deleted during migration)
        handler_sees_legacy: "x-legacy" in req.headers,
        deletion_confirmed:
          String(req.headers["x-deletion-confirmed"] ?? "") === "yes",
      }));
    });

    const res = await request(app.expressApp)
      .post("/hdr-del")
      .set("x-api-version", "2000-01-01")
      .set("x-legacy", "old-value")
      .send({ v: 1 });

    expect(res.status).toBe(200);
    expect(res.body.handler_sees_legacy).toBe(false);
    expect(res.body.deletion_confirmed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 3: response body migration edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Section 3: response body migration edge cases", () => {
  it("11. path-based migration iterates list items", async () => {
    const Item = z
      .object({ id: z.string(), name: z.string() })
      .named(uniq("ListItem"));

    class Change extends VersionChange {
      description = "uppercase names in list response for old version";
      instructions: any[] = [];
      migrateRes = convertResponseToPreviousVersionFor("/items", ["GET"])(
        (res: ResponseInfo) => {
          if (Array.isArray(res.body?.items)) {
            for (const it of res.body.items) {
              it.name = String(it.name).toUpperCase();
            }
          }
        },
      );
    }

    const app = makeApp([Change], (r) => {
      r.get("/items", null, null, async () => ({
        items: [
          { id: "1", name: "apple" },
          { id: "2", name: "pear" },
        ],
      }));
    });

    const res = await request(app.expressApp)
      .get("/items")
      .set("x-api-version", "2000-01-01");

    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.name)).toEqual(["APPLE", "PEAR"]);

    // On latest, migration should not run.
    const latest = await request(app.expressApp)
      .get("/items")
      .set("x-api-version", "2001-01-01");
    expect(latest.body.items.map((i: any) => i.name)).toEqual(["apple", "pear"]);
  });

  it("12. path-based migration handles a bare array response", async () => {
    class Change extends VersionChange {
      description = "append a sentinel to each array element";
      instructions: any[] = [];
      migrateRes = convertResponseToPreviousVersionFor("/bare", ["GET"])(
        (res: ResponseInfo) => {
          if (Array.isArray(res.body)) {
            res.body = res.body.map((v: any) => `${v}-old`);
          }
        },
      );
    }

    const app = makeApp([Change], (r) => {
      r.get("/bare", null, null, async () => ["one", "two", "three"]);
    });

    const res = await request(app.expressApp)
      .get("/bare")
      .set("x-api-version", "2000-01-01");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(["one-old", "two-old", "three-old"]);
  });

  it("13. adds back a removed field for the old version (monthly_fee)", async () => {
    const Plan = z
      .object({ id: z.string(), name: z.string() })
      .named(uniq("Plan"));

    class Change extends VersionChange {
      description = "new version removed monthly_fee; old version sees 9.99";
      instructions = [
        // In the old version, monthly_fee still existed.
        schema(Plan).field("monthly_fee").existedAs({ type: z.number() }),
      ];
      migrateRes = convertResponseToPreviousVersionFor(Plan)(
        (res: ResponseInfo) => {
          res.body.monthly_fee = 9.99;
        },
      );
    }

    const app = makeApp([Change], (r) => {
      r.get("/plan", null, Plan, async () => ({ id: "p1", name: "Pro" }));
    });

    const old = await request(app.expressApp)
      .get("/plan")
      .set("x-api-version", "2000-01-01");
    expect(old.body.monthly_fee).toBe(9.99);

    const latest = await request(app.expressApp)
      .get("/plan")
      .set("x-api-version", "2001-01-01");
    expect(latest.body.monthly_fee).toBeUndefined();
  });

  it("14. renames a field: assignees[] → assignee", async () => {
    const Task = z
      .object({ id: z.string(), assignees: z.array(z.string()) })
      .named(uniq("Task"));

    class Change extends VersionChange {
      description = "old version used singular `assignee`";
      instructions = [
        schema(Task).field("assignees").had({ name: "assignee" }),
      ];
      migrateRes = convertResponseToPreviousVersionFor(Task)(
        (res: ResponseInfo) => {
          if (Array.isArray(res.body.assignees)) {
            res.body.assignee = res.body.assignees[0] ?? null;
            delete res.body.assignees;
          }
        },
      );
    }

    const app = makeApp([Change], (r) => {
      r.get("/task", null, Task, async () => ({
        id: "t1",
        assignees: ["alice", "bob"],
      }));
    });

    const res = await request(app.expressApp)
      .get("/task")
      .set("x-api-version", "2000-01-01");

    expect(res.status).toBe(200);
    expect(res.body.assignee).toBe("alice");
    expect(res.body.assignees).toBeUndefined();
  });

  it("15. migration changes the status code (201 → 200)", async () => {
    const Made = z.object({ id: z.string() }).named(uniq("Made"));

    class Change extends VersionChange {
      description = "old version responded with 200 instead of 201";
      instructions: any[] = [];
      migrateRes = convertResponseToPreviousVersionFor(Made)(
        (res: ResponseInfo) => {
          if (res.statusCode === 201) res.statusCode = 200;
        },
      );
    }

    const router = new VersionedRouter();
    router.post("/make", null, Made, async () => ({ id: "m1" }));
    // Force the new version to respond 201:
    (router.routes[router.routes.length - 1] as any).statusCode = 201;

    const app = new Cadwyn({
      versions: new VersionBundle(
        new Version("2001-01-01", Change),
        new Version("2000-01-01"),
      ),
    });
    app.generateAndIncludeVersionedRouters(router);

    const oldRes = await request(app.expressApp)
      .post("/make")
      .set("x-api-version", "2000-01-01");
    expect(oldRes.status).toBe(200);
    expect(oldRes.body.id).toBe("m1");

    const newRes = await request(app.expressApp)
      .post("/make")
      .set("x-api-version", "2001-01-01");
    expect(newRes.status).toBe(201);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 4: response headers / cookies
// ═══════════════════════════════════════════════════════════════════════════

describe("Section 4: response headers / cookies", () => {
  it("16. migration sets a response header", async () => {
    const R = z.object({ ok: z.boolean() }).named(uniq("HeaderOut"));

    class Change extends VersionChange {
      description = "mark old version as deprecated via header";
      instructions: any[] = [];
      migrateRes = convertResponseToPreviousVersionFor(R)(
        (res: ResponseInfo) => {
          res.headers["x-deprecated"] = "true";
        },
      );
    }

    const app = makeApp([Change], (r) => {
      r.get("/hdr", null, R, async () => ({ ok: true }));
    });

    const old = await request(app.expressApp)
      .get("/hdr")
      .set("x-api-version", "2000-01-01");
    expect(old.headers["x-deprecated"]).toBe("true");

    const latest = await request(app.expressApp)
      .get("/hdr")
      .set("x-api-version", "2001-01-01");
    expect(latest.headers["x-deprecated"]).toBeUndefined();
  });

  it("17. migration calls setCookie", async () => {
    const R = z.object({ ok: z.boolean() }).named(uniq("SetCookieRes"));

    class Change extends VersionChange {
      description = "set a session cookie via migration";
      instructions: any[] = [];
      migrateRes = convertResponseToPreviousVersionFor(R)(
        (res: ResponseInfo) => {
          res.setCookie("sid", "xyz", { httpOnly: true, path: "/" });
        },
      );
    }

    const app = makeApp([Change], (r) => {
      r.get("/set-cookie", null, R, async () => ({ ok: true }));
    });

    const res = await request(app.expressApp)
      .get("/set-cookie")
      .set("x-api-version", "2000-01-01");

    expect(res.status).toBe(200);
    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const joined = Array.isArray(setCookie) ? setCookie.join("; ") : setCookie!;
    expect(joined).toContain("sid=xyz");
    expect(joined.toLowerCase()).toContain("httponly");
  });

  it("18. migration calls deleteCookie", async () => {
    const R = z.object({ ok: z.boolean() }).named(uniq("DelCookieRes"));

    class Change extends VersionChange {
      description = "delete a legacy cookie via migration";
      instructions: any[] = [];
      migrateRes = convertResponseToPreviousVersionFor(R)(
        (res: ResponseInfo) => {
          res.deleteCookie("legacy", { path: "/" });
        },
      );
    }

    const app = makeApp([Change], (r) => {
      r.get("/del-cookie", null, R, async () => ({ ok: true }));
    });

    const res = await request(app.expressApp)
      .get("/del-cookie")
      .set("x-api-version", "2000-01-01");

    expect(res.status).toBe(200);
    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const joined = Array.isArray(setCookie) ? setCookie.join("; ") : setCookie!;
    // Express's res.clearCookie writes an empty value with an expired date
    expect(joined).toContain("legacy=");
    expect(joined).toMatch(/Expires=|Max-Age=/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 5: HTTP error migration
// ═══════════════════════════════════════════════════════════════════════════

describe("Section 5: HTTP error migration", () => {
  it("19. error migration runs when migrateHttpErrors is true", async () => {
    const R = z.object({ id: z.string() }).named(uniq("ErrRes1"));

    class Change extends VersionChange {
      description = "rewrite error body for old version";
      instructions: any[] = [];
      migrateRes = convertResponseToPreviousVersionFor(R, { migrateHttpErrors: true })(
        (res: ResponseInfo) => {
          if (res.body && typeof res.body === "object") {
            res.body.legacy_detail = res.body.detail;
            delete res.body.detail;
          }
        },
      );
    }

    const app = makeApp([Change], (r) => {
      r.get("/things/:id", null, R, async (req) => {
        if (req.params.id === "missing") {
          throw new HttpError(404, { detail: "not found" });
        }
        return { id: req.params.id };
      });
    });

    const res = await request(app.expressApp)
      .get("/things/missing")
      .set("x-api-version", "2000-01-01");

    expect(res.status).toBe(404);
    expect(res.body.legacy_detail).toBe("not found");
    expect(res.body.detail).toBeUndefined();
  });

  it("20. error migration is skipped when migrateHttpErrors is false", async () => {
    const R = z.object({ id: z.string() }).named(uniq("ErrRes2"));

    class Change extends VersionChange {
      description = "should not run on error bodies";
      instructions: any[] = [];
      // Defaults to migrateHttpErrors: false
      migrateRes = convertResponseToPreviousVersionFor(R)(
        (res: ResponseInfo) => {
          if (res.body && typeof res.body === "object") {
            res.body.should_not_appear = true;
          }
        },
      );
    }

    const app = makeApp([Change], (r) => {
      r.get("/things/:id", null, R, async () => {
        throw new HttpError(404, { detail: "not found" });
      });
    });

    const res = await request(app.expressApp)
      .get("/things/missing")
      .set("x-api-version", "2000-01-01");

    expect(res.status).toBe(404);
    expect(res.body.detail).toBe("not found");
    expect(res.body.should_not_appear).toBeUndefined();
  });

  it("21. error migration preserves the status code", async () => {
    const R = z.object({ msg: z.string() }).named(uniq("ErrRes3"));

    class Change extends VersionChange {
      description = "touches body only; status must stay 404";
      instructions: any[] = [];
      migrateRes = convertResponseToPreviousVersionFor(R, { migrateHttpErrors: true })(
        (res: ResponseInfo) => {
          res.body.extra = "added";
        },
      );
    }

    const app = makeApp([Change], (r) => {
      r.get("/boom", null, R, async () => {
        throw new HttpError(404, { msg: "gone" });
      });
    });

    const res = await request(app.expressApp)
      .get("/boom")
      .set("x-api-version", "2000-01-01");

    expect(res.status).toBe(404);
    expect(res.body.msg).toBe("gone");
    expect(res.body.extra).toBe("added");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 6: path-based migration
// ═══════════════════════════════════════════════════════════════════════════

describe("Section 6: path-based migration", () => {
  it("22. only runs on the declared method", async () => {
    const R = z.object({ ok: z.boolean(), via: z.string() }).named(uniq("PathMethodRes"));

    class Change extends VersionChange {
      description = "only PATCH runs the migration";
      instructions: any[] = [];
      migrateReq = convertRequestToNextVersionFor("/users/:id", ["PATCH"])(
        (req: RequestInfo) => {
          req.headers["x-patch-migrated"] = "yes";
        },
      );
    }

    const app = makeApp([Change], (r) => {
      r.patch("/users/:id", null, R, async (req) => ({
        ok: true,
        via: String(req.headers["x-patch-migrated"] ?? "no"),
      }));
      r.get("/users/:id", null, R, async (req) => ({
        ok: true,
        via: String(req.headers["x-patch-migrated"] ?? "no"),
      }));
    });

    const patchRes = await request(app.expressApp)
      .patch("/users/42")
      .set("x-api-version", "2000-01-01")
      .send({});
    expect(patchRes.body.via).toBe("yes");

    const getRes = await request(app.expressApp)
      .get("/users/42")
      .set("x-api-version", "2000-01-01");
    expect(getRes.body.via).toBe("no");
  });

  it("23. a single path migration runs for multiple declared methods", async () => {
    const R = z.object({ seen: z.string() }).named(uniq("PathMultiRes"));

    class Change extends VersionChange {
      description = "/a runs on GET and POST";
      instructions: any[] = [];
      migrateRes = convertResponseToPreviousVersionFor("/a", ["GET", "POST"])(
        (res: ResponseInfo) => {
          res.body.seen = (res.body.seen ?? "") + "+migrated";
        },
      );
    }

    const app = makeApp([Change], (r) => {
      r.get("/a", null, R, async () => ({ seen: "get" }));
      r.post("/a", null, R, async () => ({ seen: "post" }));
    });

    const g = await request(app.expressApp).get("/a").set("x-api-version", "2000-01-01");
    const p = await request(app.expressApp).post("/a").set("x-api-version", "2000-01-01").send({});
    expect(g.body.seen).toBe("get+migrated");
    expect(p.body.seen).toBe("post+migrated");
  });

  it("24. path-based migration runs regardless of path-param values", async () => {
    const R = z.object({ id: z.string() }).named(uniq("PathParamRes"));

    class Change extends VersionChange {
      description = "append suffix for /users/:id";
      instructions: any[] = [];
      migrateRes = convertResponseToPreviousVersionFor("/users/:id", ["GET"])(
        (res: ResponseInfo) => {
          res.body.id = res.body.id + "-legacy";
        },
      );
    }

    const app = makeApp([Change], (r) => {
      r.get("/users/:id", null, R, async (req) => ({ id: String(req.params.id) }));
    });

    for (const id of ["1", "abc-123", "user_99"]) {
      const res = await request(app.expressApp)
        .get(`/users/${id}`)
        .set("x-api-version", "2000-01-01");
      expect(res.body.id).toBe(`${id}-legacy`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 7: schema validation behavior
// ═══════════════════════════════════════════════════════════════════════════

describe("Section 7: schema validation behavior", () => {
  it("25. rejects the request when the migration produces an invalid head body", async () => {
    const Req = z
      .object({ x: z.number() })
      .named(uniq("BadMigrationReq"));
    const Res = z.object({ ok: z.boolean() }).named(uniq("BadMigrationRes"));

    class Change extends VersionChange {
      description = "intentionally produce an invalid head body";
      instructions = [schema(Req).field("x").had({ type: z.string() })];
      migrateReq = convertRequestToNextVersionFor(Req)((req: RequestInfo) => {
        // Head requires a number; stamp a non-number to fail head validation.
        req.body.x = "not-a-number" as any;
      });
    }

    const app = makeApp([Change], (r) => {
      r.post("/bad", Req, Res, async () => ({ ok: true }));
    });

    const res = await request(app.expressApp)
      .post("/bad")
      .set("x-api-version", "2000-01-01")
      .send({ x: "abc" });

    // The head re-validation throws CadwynHeadRequestValidationError which
    // propagates to Express's default error handler as a 500.
    expect(res.status).toBe(500);
  });

  it("26. validates against the version-specific schema first (old-shape 422)", async () => {
    // Old shape: {foo: string}. Head shape: {bar: string}. The migration renames
    // foo -> bar. A body with {bar: 'x'} but no foo is invalid for the OLD
    // version -> 422 with the old-schema error (and migrations never run).
    const Req = z.object({ bar: z.string() }).named(uniq("OldShapeReq"));
    const Res = z.object({ bar: z.string() }).named(uniq("OldShapeRes"));

    class Change extends VersionChange {
      description = "old version called this field 'foo'";
      instructions = [
        schema(Req).field("bar").had({ name: "foo" }),
        schema(Res).field("bar").had({ name: "foo" }),
      ];
      migrateReq = convertRequestToNextVersionFor(Req)((req: RequestInfo) => {
        if ("foo" in req.body) {
          req.body.bar = req.body.foo;
          delete req.body.foo;
        }
      });
      migrateRes = convertResponseToPreviousVersionFor(Res)((res: ResponseInfo) => {
        res.body.foo = res.body.bar;
        delete res.body.bar;
      });
    }

    const app = makeApp([Change], (r) => {
      r.post("/rename", Req, Res, async (req) => ({ bar: req.body.bar }));
    });

    // Sending {bar: ...} on the old version — the old schema expects {foo: ...}.
    const res = await request(app.expressApp)
      .post("/rename")
      .set("x-api-version", "2000-01-01")
      .send({ bar: "x" });

    expect(res.status).toBe(422);
    expect(res.body.detail).toBeDefined();

    // Sending {foo: ...} on the old version works.
    const okRes = await request(app.expressApp)
      .post("/rename")
      .set("x-api-version", "2000-01-01")
      .send({ foo: "x" });
    expect(okRes.status).toBe(200);
    expect(okRes.body.foo).toBe("x"); // response migrated back to old shape
  });

  it("27. validates path params against paramsSchema (422 on failure)", async () => {
    const Res = z.object({ id: z.number() }).named(uniq("ParamsRes"));
    const Params = z.object({ id: z.coerce.number().int().positive() });

    const app = makeApp([], (r) => {
      r.get("/things/:id", null, Res, async (req) => ({ id: (req.params as any).id }), {
        paramsSchema: Params,
      });
    });

    const ok = await request(app.expressApp)
      .get("/things/42")
      .set("x-api-version", "2000-01-01");
    expect(ok.status).toBe(200);
    expect(ok.body.id).toBe(42);

    const bad = await request(app.expressApp)
      .get("/things/abc")
      .set("x-api-version", "2000-01-01");
    expect(bad.status).toBe(422);
    expect(bad.body.detail).toBeDefined();
  });

  it("28. validates query params against querySchema (422 on failure)", async () => {
    const Res = z
      .object({ n: z.number() })
      .named(uniq("QueryRes"));
    const Q = z.object({ n: z.coerce.number().int() });

    const app = makeApp([], (r) => {
      r.get("/q", null, Res, async (req) => ({ n: (req.query as any).n }), {
        querySchema: Q,
      });
    });

    const ok = await request(app.expressApp)
      .get("/q?n=5")
      .set("x-api-version", "2000-01-01");
    expect(ok.status).toBe(200);
    expect(ok.body.n).toBe(5);

    const bad = await request(app.expressApp)
      .get("/q?n=not-a-number")
      .set("x-api-version", "2000-01-01");
    expect(bad.status).toBe(422);
    expect(bad.body.detail).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 8: route generation edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Section 8: route generation edge cases", () => {
  it("29. route with no request schema but with response schema", async () => {
    const Res = z
      .object({ id: z.string(), created: z.boolean() })
      .named(uniq("NoReqRes"));

    const app = makeApp([], (r) => {
      r.get("/ping", null, Res, async () => ({ id: "pong", created: true }));
    });

    const res = await request(app.expressApp)
      .get("/ping")
      .set("x-api-version", "2000-01-01");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "pong", created: true });
  });

  it("30. route with no response schema can return nothing (204-style)", async () => {
    const app = makeApp([], (r) => {
      r.delete("/things/:id", null, null, async () => undefined);
    });

    const res = await request(app.expressApp)
      .delete("/things/42")
      .set("x-api-version", "2000-01-01");

    // Express sends 200 with an empty body when the handler returns undefined.
    // Supertest surfaces an empty response as res.text === "" and res.body as {}
    // for JSON or "" otherwise — accept either form.
    expect(res.status).toBe(200);
    const emptyBody =
      res.text === "" || res.body === undefined ||
      (typeof res.body === "object" && Object.keys(res.body).length === 0);
    expect(emptyBody).toBe(true);
  });

  it("31. multiple routes on the same path with different methods", async () => {
    const GetRes = z.object({ who: z.literal("get") }).named(uniq("SamePathGet"));
    const PostRes = z.object({ who: z.literal("post") }).named(uniq("SamePathPost"));

    const app = makeApp([], (r) => {
      r.get("/x", null, GetRes, async () => ({ who: "get" as const }));
      r.post("/x", null, PostRes, async () => ({ who: "post" as const }));
    });

    const g = await request(app.expressApp)
      .get("/x")
      .set("x-api-version", "2000-01-01");
    expect(g.body).toEqual({ who: "get" });

    const p = await request(app.expressApp)
      .post("/x")
      .set("x-api-version", "2000-01-01");
    expect(p.body).toEqual({ who: "post" });
  });

  it("32. router prefix is applied to all routes", async () => {
    const Res = z.object({ hello: z.string() }).named(uniq("PrefixRes"));

    const app = makeApp(
      [],
      (r) => {
        r.get("/hello", null, Res, async () => ({ hello: "world" }));
      },
      { prefix: "/api" },
    );

    const ok = await request(app.expressApp)
      .get("/api/hello")
      .set("x-api-version", "2000-01-01");
    expect(ok.status).toBe(200);
    expect(ok.body.hello).toBe("world");

    const notFound = await request(app.expressApp)
      .get("/hello")
      .set("x-api-version", "2000-01-01");
    expect(notFound.status).toBe(404);
  });

  // Tests 33 & 34 exercise router-level middleware via router.use(). The
  // current Cadwyn initialization path rebuilds a plain `mergedRouter` object
  // that carries `routes` but not `routerMiddleware`, so router-level
  // middleware registered via `router.use()` is dropped during merging.
  // These tests are skipped until the merged router is constructed to carry
  // the middleware through.
  it("33. router-level middleware runs before the route handler", async () => {
    // Now works — Cadwyn._performInitialization preserves router-level
    // middleware through the merged router. State propagates to the handler
    // via req.headers (since the handler receives only body/params/query/headers).
    const Res = z.object({ mark: z.string() }).named(uniq("RouterMwRes"));

    const router = new VersionedRouter();
    router.use((req: Request, _res: Response, next: NextFunction) => {
      req.headers["x-router-mark"] = "router-mw";
      next();
    });
    router.get("/mw", null, Res, async (req) => ({
      mark: String(req.headers["x-router-mark"] ?? ""),
    }));

    const app = new Cadwyn({
      versions: new VersionBundle(new Version("2000-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .get("/mw")
      .set("x-api-version", "2000-01-01");

    expect(res.status).toBe(200);
    expect(res.body.mark).toBe("router-mw");
  });

  it("34. router-level middleware runs before route-level middleware", async () => {
    const Res = z.object({ order: z.string() }).named(uniq("MwOrderRes"));

    const router = new VersionedRouter();
    router.use((req: Request, _res: Response, next: NextFunction) => {
      req.headers["x-mw-order"] = "router";
      next();
    });

    const routeLevel = (req: Request, _res: Response, next: NextFunction) => {
      req.headers["x-mw-order"] = `${req.headers["x-mw-order"] ?? ""}->route`;
      next();
    };

    router.get(
      "/mw2",
      null,
      Res,
      async (req) => ({ order: String(req.headers["x-mw-order"] ?? "") }),
      { middleware: [routeLevel] },
    );

    const app = new Cadwyn({
      versions: new VersionBundle(new Version("2000-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .get("/mw2")
      .set("x-api-version", "2000-01-01");

    expect(res.status).toBe(200);
    expect(res.body.order).toBe("router->route");
  });

  it("34b. route-level middleware runs before the route handler", async () => {
    // Route-level middleware IS preserved through Cadwyn's route generation.
    // The handler receives a subset of Express `req` (only body/params/query/
    // headers), so we propagate middleware state through `req.headers`, which
    // the handler can read from its typed request.
    const Res = z.object({ mark: z.string() }).named(uniq("RouteMwRes"));

    const router = new VersionedRouter();
    const mw = (req: Request, _res: Response, next: NextFunction) => {
      req.headers["x-mw-mark"] = "route-mw";
      next();
    };
    router.get(
      "/route-mw",
      null,
      Res,
      async (req) => ({ mark: String(req.headers["x-mw-mark"] ?? "") }),
      { middleware: [mw] },
    );

    const app = new Cadwyn({
      versions: new VersionBundle(new Version("2000-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .get("/route-mw")
      .set("x-api-version", "2000-01-01");

    expect(res.status).toBe(200);
    expect(res.body.mark).toBe("route-mw");
  });

  it("34c. multiple route-level middlewares run in order", async () => {
    // Verify that when multiple middleware functions are registered on a
    // single route, they run in the order they appear and their effects
    // accumulate before the handler runs.
    const Res = z.object({ trail: z.string() }).named(uniq("RouteMwOrderRes"));

    const router = new VersionedRouter();
    const mw1 = (req: Request, _res: Response, next: NextFunction) => {
      req.headers["x-trail"] = "one";
      next();
    };
    const mw2 = (req: Request, _res: Response, next: NextFunction) => {
      req.headers["x-trail"] = String(req.headers["x-trail"]) + "->two";
      next();
    };

    router.get(
      "/mw-order",
      null,
      Res,
      async (req) => ({ trail: String(req.headers["x-trail"] ?? "") }),
      { middleware: [mw1, mw2] },
    );

    const app = new Cadwyn({
      versions: new VersionBundle(new Version("2000-01-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    const res = await request(app.expressApp)
      .get("/mw-order")
      .set("x-api-version", "2000-01-01");

    expect(res.status).toBe(200);
    expect(res.body.trail).toBe("one->two");
  });
});
