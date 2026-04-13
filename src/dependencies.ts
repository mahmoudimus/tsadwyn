/**
 * T-1304: Dependency context module.
 *
 * Provides an AsyncLocalStorage-based context variable that tracks the current
 * dependency resolver during request handling. Distinguishes between dependencies
 * resolved by Tsadwyn's internal mechanism ("tsadwyn") and those resolved by the
 * underlying Express framework ("express").
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The possible values for the current dependency solver context.
 * - "tsadwyn": Dependencies are being resolved by Tsadwyn's internal mechanism
 * - "express": Dependencies are being resolved by the Express framework
 */
export type DependencySolverOption = "tsadwyn" | "express";

/**
 * AsyncLocalStorage instance that tracks which dependency solver is active
 * during the current request.
 */
export const currentDependencySolverStorage = new AsyncLocalStorage<DependencySolverOption>();

/**
 * Get the current dependency solver for the active request context.
 * Returns "express" as the default when no context is set.
 */
export function currentDependencySolver(): DependencySolverOption {
  return currentDependencySolverStorage.getStore() ?? "express";
}
