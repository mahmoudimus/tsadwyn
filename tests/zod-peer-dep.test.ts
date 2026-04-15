/**
 * zod-peer-dep.test.ts
 *
 * Guard test for tsadwyn's zod peerDependency contract.
 *
 * Prior to `zod` being declared a peerDependency, when a downstream
 * consumer installed tsadwyn via `file:` (git submodule, workspace, etc.),
 * npm would install tsadwyn's own `zod` nested at
 * `vendor/tsadwyn/node_modules/zod` alongside the consumer's top-level
 * `zod`. Both were the same semver-major but distinct class identities —
 * `schema instanceof ZodObject` would be FALSE across the package
 * boundary, causing `ZodSchemaRegistry.register()` to silently fall
 * through to `shape: {}` and any `schema().field(...)` instruction to
 * throw "field does not exist."
 *
 * The fix is packaging-level: move `zod` to `peerDependencies` so npm
 * doesn't install a nested copy. This test verifies the package.json is
 * shaped correctly. If someone adds `zod` back to `dependencies` the
 * test fails loudly; reviewers can then reject the regression.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("package.json — zod must be a peerDependency, not a dependency", () => {
  const pkg = JSON.parse(
    readFileSync(resolve(__dirname, "..", "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it("does not declare zod in dependencies", () => {
    expect(pkg.dependencies?.zod).toBeUndefined();
  });

  it("declares zod in peerDependencies", () => {
    expect(pkg.peerDependencies?.zod).toBeDefined();
  });

  it("keeps zod in devDependencies so tests + build can compile", () => {
    // Without this tsadwyn's own test suite + build would break — the
    // peer contract requires the consumer to provide zod, but dev work
    // in this repo still needs its own copy.
    expect(pkg.devDependencies?.zod).toBeDefined();
  });

  it("peer and dev zod ranges agree", () => {
    // If the ranges drift, a consumer satisfying the peer range might
    // still not be compatible with what tsadwyn was tested against.
    expect(pkg.peerDependencies?.zod).toBe(pkg.devDependencies?.zod);
  });
});
