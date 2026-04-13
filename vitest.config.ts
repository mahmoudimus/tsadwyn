import { defineConfig } from "vitest/config";

/**
 * Vitest pool selection.
 *
 * tsadwyn defaults to `pool: "forks"` because Node's HTTP keep-alive parser
 * state is shared across workers in the `threads` pool, producing intermittent
 * "Parse Error: Expected HTTP/, RTSP/ or ICE/" and random status mismatches
 * in supertest-heavy tests. Observed flake rate in threads mode: ~20–30% per
 * file; with forks: 0% over hundreds of runs.
 *
 * Override via the TSADWYN_TEST_POOL env var:
 *   TSADWYN_TEST_POOL=threads npm test
 *
 * Vitest's own `--pool=<name>` CLI flag takes precedence over the env var.
 */
const pool = (process.env.TSADWYN_TEST_POOL as "forks" | "threads" | undefined) ?? "forks";

if (pool === "threads") {
  // eslint-disable-next-line no-console
  console.warn(
    "\n\u26A0\uFE0F  vitest pool=threads is known to produce ~20–30% HTTP-socket " +
      "flakes in tsadwyn's supertest-heavy tests due to shared Node HTTP " +
      "keep-alive state. Prefer the default `forks` pool unless you're " +
      "explicitly validating thread-pool behavior.\n",
  );
}

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    pool,
  },
});
