import express, { Express, Router } from "express";
import type { VersionBundle } from "./structure/versions.js";
import type { VersionedRouter } from "./router.js";
import { versionPickingMiddleware } from "./middleware.js";
import { generateVersionedRouters } from "./route-generation.js";

export interface CadwynOptions {
  versions: VersionBundle;
  apiVersionHeaderName?: string;
}

/**
 * The main Cadwyn application class. Wraps an Express app and orchestrates
 * versioned routing, schema generation, and request/response migration.
 */
export class Cadwyn {
  expressApp: Express;
  versions: VersionBundle;
  apiVersionHeaderName: string;
  private _versionedRouters: Map<string, Router> = new Map();

  constructor(options: CadwynOptions) {
    this.versions = options.versions;
    this.apiVersionHeaderName = options.apiVersionHeaderName || "x-api-version";

    this.expressApp = express();
    this.expressApp.use(express.json());
    this.expressApp.use(
      versionPickingMiddleware(this.apiVersionHeaderName),
    );
  }

  /**
   * Generate versioned routers from the given VersionedRouter(s) and mount them
   * on the Express app. Each version's routes are mounted and the version-picking
   * middleware dispatches requests to the correct versioned router based on the
   * API version header.
   */
  generateAndIncludeVersionedRouters(...routers: VersionedRouter[]): void {
    // Merge all route definitions from all routers
    const mergedRouter: VersionedRouter = {
      routes: routers.flatMap((r) => r.routes),
    } as VersionedRouter;

    this._versionedRouters = generateVersionedRouters(
      mergedRouter,
      this.versions,
    );

    // Mount a dispatch middleware that routes to the correct versioned router
    // based on the x-api-version header.
    const versionedRouters = this._versionedRouters;
    const headerName = this.apiVersionHeaderName;
    const versionValues = this.versions.versionValues;

    this.expressApp.use((req, res, next) => {
      const requestedVersion = req.headers[headerName.toLowerCase()] as
        | string
        | undefined;
      const version = requestedVersion || versionValues[0]; // default to latest

      const router = versionedRouters.get(version);
      if (router) {
        router(req, res, next);
      } else {
        res.status(404).json({
          detail: `API version "${version}" not found. Available versions: ${versionValues.join(", ")}`,
        });
      }
    });
  }
}
