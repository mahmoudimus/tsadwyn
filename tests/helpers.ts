import request from "supertest";
import { z, ZodTypeAny } from "zod";
import {
  Cadwyn,
  Version,
  VersionBundle,
  VersionChange,
  VersionedRouter,
  RequestInfo,
  ResponseInfo,
} from "../src/index.js";
import type { PossibleInstruction } from "../src/structure/versions.js";
import type {
  AlterRequestBySchemaInstruction,
  AlterResponseBySchemaInstruction,
} from "../src/structure/data.js";

/**
 * Helper to create a standard 2-version setup (2000-01-01, 2001-01-01).
 * Additional version changes create additional versions (2002-01-01, etc.).
 * Returns versions ordered newest-first as VersionBundle expects.
 */
export function versions(
  ...changes: Array<new () => VersionChange>
): Version[] {
  const result: Version[] = [new Version("2000-01-01")];
  for (let i = 0; i < changes.length; i++) {
    result.push(new Version(`${2001 + i}-01-01`, changes[i]));
  }
  return result.reverse();
}

/**
 * Helper to create anonymous VersionChange classes inline from instructions.
 *
 * Supports both schema/endpoint instructions and migration functions passed
 * as object properties via the optional `body` parameter.
 */
export function versionChange(
  instructions: PossibleInstruction[],
  body?: Record<string, any>,
): new () => VersionChange {
  class AnonymousVersionChange extends VersionChange {
    description = "Auto-generated test version change";
    instructions: PossibleInstruction[];

    constructor() {
      super();
      this.instructions = instructions;
    }
  }

  // Attach migration methods to the prototype so _extractInstructions can find them
  if (body) {
    for (const [key, value] of Object.entries(body)) {
      Object.defineProperty(AnonymousVersionChange.prototype, key, {
        value,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
  }

  return AnonymousVersionChange;
}

/**
 * Factory to create versioned apps quickly in tests.
 * Takes VersionChange classes and creates a Cadwyn app with a default router.
 */
export function createVersionedApp(
  router: VersionedRouter,
  ...changeClasses: Array<new () => VersionChange>
): Cadwyn {
  const versionList = versions(...changeClasses);
  const app = new Cadwyn({
    versions: new VersionBundle(...versionList),
  });
  app.generateAndIncludeVersionedRouters(router);
  return app;
}

/**
 * Factory to create test clients per version.
 * Returns a record of version string -> supertest instance.
 */
export function createVersionedClients(
  app: Cadwyn,
): Record<string, request.Agent> {
  const clients: Record<string, request.Agent> = {};
  for (const version of app.versions.versionValues) {
    // Create a supertest agent that always sets the version header
    const agent = request.agent(app.expressApp);
    // We wrap the agent methods to always include the version header
    clients[version] = new Proxy(agent, {
      get(target, prop, receiver) {
        const original = Reflect.get(target, prop, receiver);
        if (
          typeof original === "function" &&
          ["get", "post", "put", "patch", "delete", "head", "options"].includes(
            prop as string,
          )
        ) {
          return (...args: any[]) => {
            const req = original.apply(target, args);
            return req.set(
              app.apiVersionHeaderName,
              version,
            );
          };
        }
        return original;
      },
    });
  }
  return clients;
}
