#!/usr/bin/env node

/**
 * CLI tool for tsadwyn.
 *
 * Usage:
 *   npx tsadwyn codegen --app path/to/app.ts
 *
 * The `codegen` command:
 *   1. Dynamically imports the module specified by --app
 *   2. Looks for a default or named `app` export that is a Cadwyn instance
 *   3. Calls app.generateAndIncludeVersionedRouters() to trigger generation
 *   4. Prints a summary of generated versions and routes
 */

import { Command } from "commander";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const program = new Command();

program
  .name("tsadwyn")
  .description("Stripe-like API versioning framework for TypeScript/Express")
  .version("0.1.0");

program
  .command("codegen")
  .description("Generate versioned routers from a Cadwyn application module")
  .requiredOption("--app <path>", "Path to the module that exports the Cadwyn app")
  .action(async (options: { app: string }) => {
    try {
      const modulePath = resolve(process.cwd(), options.app);
      const moduleUrl = pathToFileURL(modulePath).href;

      console.log(`Loading module from: ${modulePath}`);

      // Dynamically import the module
      const mod = await import(moduleUrl);

      // Look for a Cadwyn instance: check default export, then named 'app' export
      const app = mod.default ?? mod.app;

      if (!app) {
        console.error(
          "Error: Could not find a Cadwyn app export. " +
          "The module should have a default export or a named 'app' export.",
        );
        process.exit(1);
      }

      if (typeof app.generateAndIncludeVersionedRouters !== "function") {
        console.error(
          "Error: The exported object does not appear to be a Cadwyn instance. " +
          "It must have a generateAndIncludeVersionedRouters() method.",
        );
        process.exit(1);
      }

      // Check if there are pending routers to supply. If the app was constructed
      // but generateAndIncludeVersionedRouters was not yet called with routers,
      // we call it with no args (triggering internal initialization).
      if (typeof app.versions?.versionValues !== "undefined") {
        const versionValues: string[] = app.versions.versionValues;
        console.log(`\nFound ${versionValues.length} API version(s):`);
        for (const v of versionValues) {
          console.log(`  - ${v}`);
        }
      }

      // If the module also exports routers, pass them to the generator
      const routers = mod.routers ?? mod.versionedRouters;
      if (routers) {
        const routerArr = Array.isArray(routers) ? routers : [routers];
        app.generateAndIncludeVersionedRouters(...routerArr);
      } else {
        // The app may have already had routers configured; just ensure initialization
        if (app._pendingRouters) {
          app._performInitialization?.();
        }
      }

      // Print summary
      const versionedRouters: Map<string, any> = app._versionedRouters;
      if (versionedRouters && versionedRouters.size > 0) {
        console.log(`\nGenerated ${versionedRouters.size} versioned router(s).`);
        for (const [version, router] of versionedRouters) {
          const routeCount = router?.stack?.length ?? "unknown";
          console.log(`  Version ${version}: ${routeCount} route(s)`);
        }
      } else {
        console.log("\nNo versioned routers were generated.");
        console.log(
          "Make sure the module exports routers (as 'routers' or 'versionedRouters') " +
          "or calls generateAndIncludeVersionedRouters() before export.",
        );
      }

      console.log("\nCode generation complete.");
    } catch (err: any) {
      console.error(`Error during code generation: ${err.message}`);
      if (err.stack) {
        console.error(err.stack);
      }
      process.exit(1);
    }
  });

program.parse();
