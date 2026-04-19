import { describe, it, expect } from "vitest";
import request from "supertest";
import { Readable } from "node:stream";
import { z } from "zod";

import {
  Tsadwyn,
  Version,
  VersionBundle,
  VersionChange,
  VersionedRouter,
  schema,
  convertResponseToPreviousVersionFor,
  ResponseInfo,
  HttpError,
  convertRequestToNextVersionFor,
  RequestInfo,
} from "../src/index.js";

// ---------- Helpers ----------

function createSimpleApp(
  ChangeClasses: Array<new () => VersionChange>,
  routerSetup: (router: VersionedRouter) => void,
) {
  const router = new VersionedRouter();
  routerSetup(router);

  const versionList: Version[] = [new Version("2000-01-01")];
  for (let i = 0; i < ChangeClasses.length; i++) {
    versionList.push(new Version(`${2001 + i}-01-01`, ChangeClasses[i]));
  }
  versionList.reverse();

  const app = new Tsadwyn({
    versions: new VersionBundle(...versionList),
  });
  app.generateAndIncludeVersionedRouters(router);
  return app;
}

// ---------- T-1901: StreamingResponse / FileResponse passthrough ----------

describe("T-1901: non-JSON response passthrough", () => {
  describe("Buffer response", () => {
    const app = createSimpleApp([], (router) => {
      router.get("/download", null, null, async () => {
        return Buffer.from("binary content here", "utf-8");
      });
    });

    it("sends a Buffer as-is without migration", async () => {
      const res = await request(app.expressApp)
        .get("/download")
        .set("x-api-version", "2000-01-01");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/octet-stream");
      expect(res.body).toEqual(Buffer.from("binary content here", "utf-8"));
    });
  });

  describe("ReadableStream response", () => {
    const app = createSimpleApp([], (router) => {
      router.get("/stream", null, null, async () => {
        const readable = new Readable({
          read() {
            this.push("streamed ");
            this.push("data");
            this.push(null);
          },
        });
        return readable;
      });
    });

    it("pipes a ReadableStream through without migration", async () => {
      const res = await request(app.expressApp)
        .get("/stream")
        .set("x-api-version", "2000-01-01")
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => cb(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/octet-stream");
      expect(res.body.toString("utf-8")).toBe("streamed data");
    });
  });

  describe("plain string response", () => {
    const app = createSimpleApp([], (router) => {
      router.get("/text", null, null, async () => {
        return "Hello, plain text!";
      });
    });

    it("sends a plain string as text", async () => {
      const res = await request(app.expressApp)
        .get("/text")
        .set("x-api-version", "2000-01-01");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");
      expect(res.text).toBe("Hello, plain text!");
    });
  });

  describe("Buffer response skips response migrations", () => {
    const BufRes = z.object({ data: z.string() }).named("BufSkipRes");

    class SomeChange extends VersionChange {
      description = "A change that should not apply to buffer responses";
      instructions: any[] = [];

      @convertResponseToPreviousVersionFor(BufRes)
      migrateRes(response: ResponseInfo) {
        // This should never be called for buffer responses
        response.body.extra = "added_by_migration";
      }
    }

    const app = createSimpleApp([SomeChange], (router) => {
      router.get("/buf-skip", null, BufRes, async () => {
        return Buffer.from("raw binary", "utf-8");
      });
    });

    it("does not run response migrations on Buffer responses", async () => {
      const res = await request(app.expressApp)
        .get("/buf-skip")
        .set("x-api-version", "2000-01-01");

      expect(res.status).toBe(200);
      // Should be raw binary, not JSON with 'extra' field
      expect(res.headers["content-type"]).toContain("application/octet-stream");
      expect(res.body).toEqual(Buffer.from("raw binary", "utf-8"));
    });
  });
});

// ---------- T-1900: HttpError response migration ----------

describe("T-1900: HttpError response migration", () => {
  describe("HttpError thrown without migrations", () => {
    const app = createSimpleApp([], (router) => {
      router.get("/fail", null, null, async () => {
        throw new HttpError(404, { detail: "Not found" });
      });
    });

    it("sends the error response with correct status and body", async () => {
      const res = await request(app.expressApp)
        .get("/fail")
        .set("x-api-version", "2000-01-01");

      expect(res.status).toBe(404);
      expect(res.body.detail).toBe("Not found");
    });
  });

  describe("HttpError with custom headers", () => {
    const app = createSimpleApp([], (router) => {
      router.get("/fail-headers", null, null, async () => {
        throw new HttpError(403, { detail: "Forbidden" }, { "x-custom": "value" });
      });
    });

    it("includes custom headers from HttpError", async () => {
      const res = await request(app.expressApp)
        .get("/fail-headers")
        .set("x-api-version", "2000-01-01");

      expect(res.status).toBe(403);
      expect(res.body.detail).toBe("Forbidden");
      expect(res.headers["x-custom"]).toBe("value");
    });
  });

  describe("HttpError with migrateHttpErrors response migration", () => {
    const ErrRes = z.object({ detail: z.string() }).named("ErrMigrateRes");

    class MigrateErrorChange extends VersionChange {
      description = "Migrates error responses too";
      instructions: any[] = [];

      @convertResponseToPreviousVersionFor(ErrRes, { migrateHttpErrors: true })
      migrateRes(response: ResponseInfo) {
        if (response.body && response.body.detail) {
          response.body.error_message = response.body.detail;
          delete response.body.detail;
        }
      }
    }

    const app = createSimpleApp([MigrateErrorChange], (router) => {
      router.get("/err-migrate", null, ErrRes, async () => {
        throw new HttpError(400, { detail: "Validation failed" });
      });
    });

    it("runs migrateHttpErrors migrations on HttpError", async () => {
      const res = await request(app.expressApp)
        .get("/err-migrate")
        .set("x-api-version", "2000-01-01");

      expect(res.status).toBe(400);
      // The migration should have renamed 'detail' to 'error_message'
      expect(res.body.error_message).toBe("Validation failed");
      expect(res.body.detail).toBeUndefined();
    });

    it("does not run migration on latest version", async () => {
      const res = await request(app.expressApp)
        .get("/err-migrate")
        .set("x-api-version", "2001-01-01");

      expect(res.status).toBe(400);
      // Latest version: no migration applied
      expect(res.body.detail).toBe("Validation failed");
      expect(res.body.error_message).toBeUndefined();
    });
  });

  describe("HttpError: non-migrateHttpErrors migrations are skipped", () => {
    const SkipRes = z.object({ detail: z.string() }).named("ErrSkipRes");

    class NoMigrateErrorChange extends VersionChange {
      description = "Does NOT migrate error responses";
      instructions: any[] = [];

      // Explicit opt-out: default is TRUE now (Stripe semantics). Pass
      // false to preserve the success-only scope this test asserts.
      @convertResponseToPreviousVersionFor(SkipRes, { migrateHttpErrors: false })
      migrateRes(response: ResponseInfo) {
        response.body.extra = "should_not_appear";
      }
    }

    const app = createSimpleApp([NoMigrateErrorChange], (router) => {
      router.get("/err-skip", null, SkipRes, async () => {
        throw new HttpError(500, { detail: "Server error" });
      });
    });

    it("does not run non-migrateHttpErrors migrations on HttpError", async () => {
      const res = await request(app.expressApp)
        .get("/err-skip")
        .set("x-api-version", "2000-01-01");

      expect(res.status).toBe(500);
      expect(res.body.detail).toBe("Server error");
      expect(res.body.extra).toBeUndefined();
    });
  });

  describe("HttpError status code migration", () => {
    const StatusRes = z.object({ detail: z.string() }).named("ErrStatusRes");

    class MigrateStatusChange extends VersionChange {
      description = "Changes error status code for old version";
      instructions: any[] = [];

      @convertResponseToPreviousVersionFor(StatusRes, { migrateHttpErrors: true })
      migrateRes(response: ResponseInfo) {
        if (response.statusCode === 422) {
          response.statusCode = 400;
          response.body.detail = "Bad request (old format)";
        }
      }
    }

    const app = createSimpleApp([MigrateStatusChange], (router) => {
      router.post("/validate", null, StatusRes, async () => {
        throw new HttpError(422, { detail: "Unprocessable entity" });
      });
    });

    it("migrates both status code and body for old version", async () => {
      const res = await request(app.expressApp)
        .post("/validate")
        .set("x-api-version", "2000-01-01")
        .send({});

      // Migration should change 422 -> 400 for old version
      expect(res.body.detail).toBe("Bad request (old format)");
      expect(res.status).toBe(400);
    });
  });

  describe("non-HttpError errors pass through to next()", () => {
    const app = createSimpleApp([], (router) => {
      router.get("/crash", null, null, async () => {
        throw new Error("Unexpected crash");
      });
    });

    it("non-HTTP errors result in 500 (default Express behavior)", async () => {
      const res = await request(app.expressApp)
        .get("/crash")
        .set("x-api-version", "2000-01-01");

      // Express default: unhandled error -> 500
      expect(res.status).toBe(500);
    });
  });

  describe("error-like object with statusCode property", () => {
    const app = createSimpleApp([], (router) => {
      router.get("/custom-err", null, null, async () => {
        const err: any = new Error("Custom");
        err.statusCode = 409;
        err.body = { detail: "Conflict" };
        throw err;
      });
    });

    it("intercepts error-like objects with statusCode property", async () => {
      const res = await request(app.expressApp)
        .get("/custom-err")
        .set("x-api-version", "2000-01-01");

      expect(res.status).toBe(409);
      expect(res.body.detail).toBe("Conflict");
    });
  });
});
