/**
 * T-1304: Dependency context module.
 *
 * Provides an AsyncLocalStorage-based context variable that tracks the current
 * dependency resolver during request handling. This is the TypeScript equivalent
 * of Cadwyn's `current_dependency_solver` from cadwyn/dependencies.py and the
 * CURRENT_DEPENDENCY_SOLVER_VAR from cadwyn/_internal/context_vars.py.
 *
 * In the Python version, this tracks whether dependencies are being resolved
 * by Cadwyn or by the underlying framework (FastAPI). In the TypeScript version,
 * the equivalent distinction is between "cadwyn" and "express".
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The possible values for the current dependency solver context.
 * - "cadwyn": Dependencies are being resolved by Cadwyn's internal mechanism
 * - "express": Dependencies are being resolved by the Express framework
 */
export type DependencySolverOption = "cadwyn" | "express";

/**
 * AsyncLocalStorage instance that tracks which dependency solver is active
 * during the current request. This mirrors Cadwyn's CURRENT_DEPENDENCY_SOLVER_VAR
 * ContextVar from Python.
 */
export const currentDependencySolverStorage = new AsyncLocalStorage<DependencySolverOption>();

/**
 * Get the current dependency solver for the active request context.
 * Returns "express" as the default when no context is set (matching
 * the Python behavior of defaulting to "fastapi").
 */
export function currentDependencySolver(): DependencySolverOption {
  return currentDependencySolverStorage.getStore() ?? "express";
}
