/**
 * FAILING TEST — verifies the gap described in tsadwyn-issue-wildcard-route-collision.md
 *
 * path-to-regexp matches first-registered-wins. If `GET /widgets/:id` is
 * registered before sibling literal `GET /widgets/archived`, the wildcard
 * captures `:id = "archived"` and any UUID validator middleware on the
 * wildcard 400s the request — the literal handler never runs.
 *
 * tsadwyn does not warn at registration time and does not auto-sort. The bug
 * is only visible the first time the literal endpoint is exercised against
 * a real client.
 *
 * Acceptable resolutions (the test passes if EITHER holds):
 *   1. A warning is emitted at `generateAndIncludeVersionedRouters()` /
 *      `generateVersionedRouters()` time naming both colliding routes.
 *   2. Routes are auto-sorted so literals precede wildcard siblings, and
 *      the literal endpoint is reachable.
 *
 * Run: npx vitest run tests/issue-wildcard-route-collision.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { z } from "zod";

import {
  Tsadwyn,
  Version,
  VersionBundle,
  VersionedRouter,
} from "../src/index.js";

const ItemResp = z
  .object({ id: z.string() })
  .named("IssueWildcard_Item");
const ListResp = z
  .object({ widgets: z.array(z.string()) })
  .named("IssueWildcard_List");

describe("Issue: wildcard route shadows later sibling literal", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("either warns at registration OR auto-sorts so the literal is reachable", async () => {
    const router = new VersionedRouter();
    const idParams = z.object({ id: z.string().uuid("Invalid ID format") });

    // Wildcard registered FIRST with a strict validator middleware.
    router.get(
      "/widgets/:id",
      null,
      ItemResp,
      async (req: any) => ({ id: req.params.id }),
      {
        middleware: [
          (req, res, next) => {
            const r = idParams.safeParse(req.params);
            if (!r.success) {
              return res.status(400).json({
                error: r.error.issues[0]?.message ?? "invalid",
              });
            }
            next();
          },
        ],
      },
    );

    // Literal registered SECOND.
    router.get("/widgets/archived", null, ListResp, async () => ({
      widgets: [],
    }));

    const app = new Tsadwyn({
      versions: new VersionBundle(new Version("2026-04-01")),
    });
    app.generateAndIncludeVersionedRouters(router);

    // EITHER (1) a warning was emitted naming both colliding routes…
    const warningEmitted = warnSpy.mock.calls.some((args) =>
      args.some(
        (a) =>
          typeof a === "string" &&
          /widgets\/:id/.test(a) &&
          /widgets\/archived/.test(a),
      ),
    );

    // …OR (2) the literal is reachable (auto-sorted).
    const res = await request(app.expressApp)
      .get("/widgets/archived")
      .set("x-api-version", "2026-04-01");
    const literalReachable = res.status === 200 && Array.isArray(res.body?.widgets);

    expect(
      warningEmitted || literalReachable,
      `Expected either a registration-time warning naming both colliding routes ` +
        `(/widgets/:id and /widgets/archived) OR the literal route to be reachable ` +
        `via auto-sort. Neither happened. Got status=${res.status}, body=${JSON.stringify(res.body)}, ` +
        `warn calls=${JSON.stringify(warnSpy.mock.calls)}`,
    ).toBe(true);
  });
});
