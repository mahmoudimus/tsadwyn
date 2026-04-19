/**
 * Fixture app for CLI tests that exercise the exception-map introspection
 * subcommand (`tsadwyn exceptions`). Exposes a Tsadwyn instance whose
 * `errorMapper` is an introspectable ExceptionMapFn with three mapping
 * kinds — function, static, static-with-transform — so the CLI has
 * concrete data to render.
 */
import {
  Tsadwyn,
  Version,
  VersionBundle,
  VersionedRouter,
  HttpError,
  exceptionMap,
} from "../../src/index.js";

const router = new VersionedRouter();
router.get("/ping", null, null, async () => ({ ok: true }));

const app = new Tsadwyn({
  versions: new VersionBundle(new Version("2024-01-01")),
  errorMapper: exceptionMap({
    IdempotencyKeyReuseError: (err) =>
      new HttpError(409, {
        code: "idempotency_key_reused",
        message: err.message,
      }),
    NotFoundError: { status: 404, code: "not_found" },
    RateLimitError: {
      status: 429,
      code: "rate_limited",
      transform: (err) => ({
        message: err.message,
        retryAfter: (err as any).retryAfter,
      }),
    },
  }),
});
app.generateAndIncludeVersionedRouters(router);

export default app;
