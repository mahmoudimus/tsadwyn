import { beforeEach } from "vitest";
import { AlterSchemaInstructionFactory } from "../src/structure/schemas.js";

/**
 * Reset module-level shared state before every test to prevent state leaks
 * between test files when running in pools that share process memory (threads).
 *
 * Currently clears:
 * - AlterSchemaInstructionFactory._knownSchemas — static Map populated by
 *   every `schema()` call. If two files register schemas under the same name
 *   (e.g. "UserResource") the second overwrites the first and route generation
 *   in later tests sees the wrong definition.
 *
 * The fact that this reset is needed is itself a design smell; the real fix
 * is to restructure AlterSchemaInstructionFactory to not use static state.
 * Tracked as a follow-up ticket (see _gitless/ROADMAP.md T-2600).
 */
beforeEach(() => {
  AlterSchemaInstructionFactory._knownSchemas.clear();
});
