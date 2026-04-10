import { describe, it, expect } from "vitest";

import {
  currentDependencySolver,
  currentDependencySolverStorage,
} from "../src/index.js";

describe("currentDependencySolver", () => {
  it("returns the default 'express' outside any AsyncLocalStorage context", () => {
    // When called outside any `.run()` block, getStore() returns undefined,
    // and the function falls back to the "express" default.
    expect(currentDependencySolver()).toBe("express");
  });

  it("returns the stored value when called inside a .run() block", () => {
    currentDependencySolverStorage.run("cadwyn", () => {
      expect(currentDependencySolver()).toBe("cadwyn");
    });
  });

  it("returns 'express' when explicitly stored as 'express'", () => {
    currentDependencySolverStorage.run("express", () => {
      expect(currentDependencySolver()).toBe("express");
    });
  });

  it("returns the innermost value when .run() calls are nested", () => {
    currentDependencySolverStorage.run("express", () => {
      expect(currentDependencySolver()).toBe("express");

      currentDependencySolverStorage.run("cadwyn", () => {
        // Innermost wins.
        expect(currentDependencySolver()).toBe("cadwyn");

        currentDependencySolverStorage.run("express", () => {
          expect(currentDependencySolver()).toBe("express");
        });

        // Back to the previous level.
        expect(currentDependencySolver()).toBe("cadwyn");
      });

      // Back to the outer level.
      expect(currentDependencySolver()).toBe("express");
    });
  });

  it("falls back to 'express' after the .run() block exits", () => {
    currentDependencySolverStorage.run("cadwyn", () => {
      expect(currentDependencySolver()).toBe("cadwyn");
    });

    // Outside the block once again - default behavior.
    expect(currentDependencySolver()).toBe("express");
    expect(currentDependencySolverStorage.getStore()).toBeUndefined();
  });

  it("propagates the stored value through async boundaries", async () => {
    await currentDependencySolverStorage.run("cadwyn", async () => {
      expect(currentDependencySolver()).toBe("cadwyn");
      await Promise.resolve();
      expect(currentDependencySolver()).toBe("cadwyn");
      await new Promise((resolve) => setImmediate(resolve));
      expect(currentDependencySolver()).toBe("cadwyn");
    });

    expect(currentDependencySolver()).toBe("express");
  });
});
