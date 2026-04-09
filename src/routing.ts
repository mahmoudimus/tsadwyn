/**
 * T-1303: Internal routing module.
 *
 * Provides the RootCadwynRouter class that manages the collection of versioned
 * Express routers. This is the TypeScript equivalent of Cadwyn's
 * _RootCadwynAPIRouter from cadwyn/routing.py.
 */

import { Router, Request, Response, NextFunction } from "express";
import type { OpenAPIDocument } from "./openapi.js";
import { buildOpenAPIDocument } from "./openapi.js";
import type { RouteDefinition } from "./router.js";
import type { ZodSchemaRegistry } from "./schema-generation.js";

/**
 * Options for constructing a RootCadwynRouter.
 */
export interface RootCadwynRouterOptions {
  /** The header/parameter name used for API version selection. */
  apiVersionParameterName: string;
  /** All known API version values, ordered newest-first. */
  versionValues: string[];
}

/**
 * RootCadwynRouter manages the collection of versioned Express routers and
 * provides OpenAPI schema aggregation across versions.
 *
 * This class is used internally by the Cadwyn application class to organize
 * versioned routing. It is the TypeScript equivalent of Cadwyn's
 * _RootCadwynAPIRouter.
 */
export class RootCadwynRouter {
  /**
   * Map of version string to the Express Router for that version.
   */
  readonly versionedRouters: Map<string, Router> = new Map();

  /**
   * The name of the API version parameter (e.g., "x-api-version").
   */
  readonly apiVersionParameterName: string;

  /**
   * All known version values, ordered newest-first.
   */
  private readonly _versionValues: string[];

  /**
   * Versioned schema registries for OpenAPI generation.
   */
  private _versionedSchemas: Map<string, ZodSchemaRegistry> = new Map();

  /**
   * Route definitions for OpenAPI generation.
   */
  private _routes: RouteDefinition[] = [];

  constructor(options: RootCadwynRouterOptions) {
    this.apiVersionParameterName = options.apiVersionParameterName.toLowerCase();
    this._versionValues = options.versionValues;
  }

  /**
   * Get all known version values.
   */
  get versionValues(): string[] {
    return this._versionValues;
  }

  /**
   * Get the sorted list of versions (oldest to newest).
   * Mirrors the Python _RootCadwynAPIRouter.versions cached_property.
   */
  get sortedVersions(): string[] {
    return [...this.versionedRouters.keys()].sort();
  }

  /**
   * Set the versioned routers map (typically called after generation).
   */
  setVersionedRouters(routers: Map<string, Router>): void {
    this.versionedRouters.clear();
    for (const [version, router] of routers) {
      this.versionedRouters.set(version, router);
    }
  }

  /**
   * Set the versioned schemas and routes for OpenAPI generation.
   */
  setOpenAPIData(
    routes: RouteDefinition[],
    versionedSchemas: Map<string, ZodSchemaRegistry>,
  ): void {
    this._routes = routes;
    this._versionedSchemas = versionedSchemas;
  }

  /**
   * Get the Express Router for a given version.
   */
  getRouter(version: string): Router | undefined {
    return this.versionedRouters.get(version);
  }

  /**
   * Check if a version exists in the router collection.
   */
  hasVersion(version: string): boolean {
    return this.versionedRouters.has(version);
  }

  /**
   * Build the OpenAPI document for a specific version.
   */
  buildOpenAPI(
    version: string,
    options: {
      title: string;
      appVersion: string;
      description?: string;
      changelogUrl?: string | null;
      includeChangelogUrlInSchema?: boolean;
    },
  ): OpenAPIDocument {
    const registry = this._versionedSchemas.get(version);
    return buildOpenAPIDocument({
      title: options.title,
      appVersion: options.appVersion,
      apiVersion: version,
      description: options.description,
      routes: this._routes,
      registry,
      apiVersionHeaderName: this.apiVersionParameterName,
      changelogUrl: options.changelogUrl ?? null,
      includeChangelogUrlInSchema: options.includeChangelogUrlInSchema ?? true,
    });
  }

  /**
   * Dispatch a request to the appropriate versioned router.
   * Returns true if a router was found and called, false otherwise.
   */
  dispatch(version: string, req: Request, res: Response, next: NextFunction): boolean {
    const router = this.versionedRouters.get(version);
    if (router) {
      router(req, res, next);
      return true;
    }
    return false;
  }
}
