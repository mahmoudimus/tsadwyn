import express, { Express, Router, Request, Response, NextFunction } from "express";
import type { VersionBundle } from "./structure/versions.js";
import { VersionedRouter } from "./router.js";
import type { RouteDefinition } from "./router.js";
import {
  versionPickingMiddleware,
  apiVersionStorage,
  type APIVersionLocation,
  type APIVersionFormat,
  type VersionPickingOptions,
} from "./middleware.js";
import { generateVersionedRouters } from "./route-generation.js";
import { TsadwynStructureError } from "./exceptions.js";
import { AlterSchemaInstructionFactory } from "./structure/schemas.js";
import { buildOpenAPIDocument } from "./openapi.js";
import type { OpenAPIDocument } from "./openapi.js";
import { generateChangelog } from "./changelog.js";
import type { ChangelogResource } from "./changelog.js";
import { ZodSchemaRegistry, generateVersionedSchemas } from "./schema-generation.js";
import { renderDocsDashboard, renderSwaggerUI, renderRedocUI, DEFAULT_ASSET_URLS } from "./docs.js";
import type { DocsAssetUrls } from "./docs.js";
import { RootTsadwynRouter } from "./routing.js";

/**
 * Regex for validating ISO date strings (YYYY-MM-DD).
 */
const _ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Check if a string is a valid ISO date (YYYY-MM-DD) that represents a real calendar date.
 */
function _isValidISODate(value: string): boolean {
  if (!_ISO_DATE_REGEX.test(value)) {
    return false;
  }
  const parsed = new Date(value + "T00:00:00Z");
  if (isNaN(parsed.getTime())) {
    return false;
  }
  const [y, m, d] = value.split("-").map(Number);
  return (
    parsed.getUTCFullYear() === y &&
    parsed.getUTCMonth() + 1 === m &&
    parsed.getUTCDate() === d
  );
}

export interface TsadwynOptions {
  versions: VersionBundle;
  apiVersionHeaderName?: string;

  /**
   * Where the API version is extracted from.
   * - "custom_header" (default): version comes from a request header
   * - "path": version comes from the URL path (e.g., /2024-01-01/users)
   */
  apiVersionLocation?: APIVersionLocation;

  /**
   * Format validation for version strings.
   * - "date" (default): versions must be valid ISO date strings (YYYY-MM-DD), sorted newest-first
   * - "string": any string is accepted, no sorting validation
   */
  apiVersionFormat?: APIVersionFormat;

  /**
   * Default version to use when no version is provided.
   * Can be a string or an async function receiving the request.
   * Cannot be used with apiVersionLocation: "path".
   */
  apiVersionDefaultValue?: string | ((req: Request) => string | Promise<string>) | null;

  /**
   * Custom Express middleware for version picking.
   * When provided, replaces the built-in versionPickingMiddleware entirely.
   * The middleware should set version information for downstream use.
   */
  versioningMiddleware?: (req: Request, res: Response, next: NextFunction) => void;

  /** Application title used in OpenAPI docs. */
  title?: string;
  /** Application description used in OpenAPI docs. */
  description?: string;
  /** Application version string used in OpenAPI docs (not the API version). */
  appVersion?: string;

  /** URL path for the Swagger UI docs page. Set to null to disable. Default: "/docs" */
  docsUrl?: string | null;
  /** URL path for the OpenAPI JSON endpoint. Set to null to disable. Default: "/openapi.json" */
  openApiUrl?: string | null;
  /** URL path for the ReDoc docs page. Set to null to disable. Default: "/redoc" */
  redocUrl?: string | null;
  /** URL path for the changelog endpoint. Set to null to disable. Default: "/changelog" */
  changelogUrl?: string | null;

  /** Whether to include the changelog endpoint in the OpenAPI schema. Default: true */
  includeChangelogUrlInSchema?: boolean;

  /** T-2006: Title for the API version parameter in OpenAPI docs. */
  apiVersionTitle?: string;
  /** T-2006: Description for the API version parameter in OpenAPI docs. */
  apiVersionDescription?: string;

  /** Custom URL for the Swagger UI JavaScript bundle. */
  swaggerJsUrl?: string;
  /** Custom URL for the Swagger UI CSS. */
  swaggerCssUrl?: string;
  /** Custom URL for the Swagger UI favicon. */
  swaggerFaviconUrl?: string;
  /** Custom URL for the ReDoc JavaScript bundle. */
  redocJsUrl?: string;
  /** Custom URL for the ReDoc favicon. */
  redocFaviconUrl?: string;

  /**
   * T-2200: Enable version waterfalling (closest-version fallback).
   * When true and apiVersionFormat is "date", if the requested version is not
   * in the known versions list, the closest version that is <= the requested
   * date is used instead of returning 422.
   * Default: false
   */
  enableWaterfalling?: boolean;

  /**
   * T-2202: Called at the end of lazy initialization (first request).
   */
  onStartup?: () => void | Promise<void>;

  /**
   * T-2202: Called on SIGTERM/SIGINT for graceful shutdown.
   */
  onShutdown?: () => void | Promise<void>;

  /**
   * T-2203: When true, the OpenAPI builder generates separate XxxInput and XxxOutput
   * component schemas for request vs response usage.
   * Default: false
   */
  separateInputOutputSchemas?: boolean;
}

/**
 * The main Tsadwyn application class. Wraps an Express app and orchestrates
 * versioned routing, schema generation, and request/response migration.
 */
export class Tsadwyn {
  expressApp: Express;
  versions: VersionBundle;
  apiVersionHeaderName: string;
  apiVersionLocation: APIVersionLocation;
  apiVersionFormat: APIVersionFormat;
  apiVersionDefaultValue: string | ((req: Request) => string | Promise<string>) | null;

  /**
   * Router for unversioned routes that are accessible without any version header.
   * Routes added here are mounted directly on the Express app.
   */
  unversionedRouter: VersionedRouter;

  /**
   * Router for webhook definitions. Webhooks are documentation-only —
   * they are NOT served as HTTP endpoints but appear in the OpenAPI
   * `webhooks` section with per-version schema transformations.
   *
   * Usage:
   * ```ts
   * app.webhooks.post("new-subscription", SubscriptionPayload, null, async () => {});
   * ```
   */
  webhooks: VersionedRouter;

  title: string;
  description: string;
  appVersion: string;

  docsUrl: string | null;
  openApiUrl: string | null;
  redocUrl: string | null;
  changelogUrl: string | null;
  includeChangelogUrlInSchema: boolean;

  /** T-2006: Title for the API version parameter. */
  apiVersionTitle: string | undefined;
  /** T-2006: Description for the API version parameter. */
  apiVersionDescription: string | undefined;

  assetUrls: DocsAssetUrls;

  /**
   * Map of original handler -> replacement handler for test-time dependency overrides.
   * When a handler is in this map, the replacement is called instead of the original.
   */
  dependencyOverrides: Map<Function, Function> = new Map();

  /**
   * Internal root router that manages versioned Express routers (T-1303).
   */
  private _rootRouter!: RootTsadwynRouter;

  private _routes: RouteDefinition[] = [];
  private _versionedRoutes: Map<string, RouteDefinition[]> = new Map();
  private _versionedSchemas: Map<string, ZodSchemaRegistry> = new Map();
  private _versionedWebhookRoutes: Map<string, RouteDefinition[]> = new Map();
  _pendingRouters: VersionedRouter[] | null = null;
  private _initialized: boolean = false;
  private _customVersioningMiddleware: ((req: Request, res: Response, next: NextFunction) => void) | null;

  /** T-2200: Enable version waterfalling. */
  private _enableWaterfalling: boolean;

  /** T-2202: Startup hook. */
  private _onStartup: (() => void | Promise<void>) | null;

  /** T-2202: Shutdown hook. */
  private _onShutdown: (() => void | Promise<void>) | null;

  /** T-2203: Separate input/output schemas flag. */
  separateInputOutputSchemas: boolean;

  /**
   * Access the internal versioned routers map.
   * Used by the CLI and for introspection.
   */
  get _versionedRouters(): Map<string, Router> {
    return this._rootRouter.versionedRouters;
  }

  constructor(options: TsadwynOptions) {
    this.versions = options.versions;
    this.apiVersionHeaderName = options.apiVersionHeaderName || "x-api-version";
    this.apiVersionLocation = options.apiVersionLocation || "custom_header";
    this.apiVersionFormat = options.apiVersionFormat || "date";
    this.apiVersionDefaultValue = options.apiVersionDefaultValue ?? null;
    this._customVersioningMiddleware = options.versioningMiddleware || null;

    this.title = options.title || "API";
    this.description = options.description || "";
    this.appVersion = options.appVersion || "0.1.0";

    this.docsUrl = options.docsUrl !== undefined ? options.docsUrl : "/docs";
    this.openApiUrl = options.openApiUrl !== undefined ? options.openApiUrl : "/openapi.json";
    this.redocUrl = options.redocUrl !== undefined ? options.redocUrl : "/redoc";
    this.changelogUrl = options.changelogUrl !== undefined ? options.changelogUrl : "/changelog";
    this.includeChangelogUrlInSchema =
      options.includeChangelogUrlInSchema !== undefined ? options.includeChangelogUrlInSchema : true;

    this.apiVersionTitle = options.apiVersionTitle;
    this.apiVersionDescription = options.apiVersionDescription;

    this.assetUrls = {
      swaggerJsUrl: options.swaggerJsUrl || DEFAULT_ASSET_URLS.swaggerJsUrl,
      swaggerCssUrl: options.swaggerCssUrl || DEFAULT_ASSET_URLS.swaggerCssUrl,
      swaggerFaviconUrl: options.swaggerFaviconUrl || DEFAULT_ASSET_URLS.swaggerFaviconUrl,
      redocJsUrl: options.redocJsUrl || DEFAULT_ASSET_URLS.redocJsUrl,
      redocFaviconUrl: options.redocFaviconUrl || DEFAULT_ASSET_URLS.redocFaviconUrl,
    };

    // T-2200: Waterfalling
    this._enableWaterfalling = options.enableWaterfalling ?? false;

    // T-2202: Lifecycle hooks
    this._onStartup = options.onStartup ?? null;
    this._onShutdown = options.onShutdown ?? null;

    // T-2203: Separate input/output schemas
    this.separateInputOutputSchemas = options.separateInputOutputSchemas ?? false;

    // T-1003: Validate version format and ordering
    this._validateVersionFormat();

    // Validation: apiVersionDefaultValue cannot be used with path-based versioning
    if (this.apiVersionDefaultValue !== null && this.apiVersionLocation === "path") {
      throw new TsadwynStructureError(
        "You tried to pass an apiVersionDefaultValue while putting the API version in Path. " +
        "This is not currently supported by Tsadwyn. " +
        "Please, open an issue on our github if you'd like to have it."
      );
    }

    // Note: Date format validation and sort-order checks are handled by VersionBundle
    // when the apiVersionFormat option is passed to it. The Tsadwyn class only stores
    // the format for use in middleware and routing logic.

    // Initialize the internal root router (T-1303)
    this._rootRouter = new RootTsadwynRouter({
      apiVersionParameterName: this.apiVersionHeaderName,
      versionValues: this.versions.versionValues,
    });

    // Initialize unversioned router
    this.unversionedRouter = new VersionedRouter();

    // Initialize webhooks router (documentation-only, not served as HTTP endpoints)
    this.webhooks = new VersionedRouter();

    this.expressApp = express();
    this.expressApp.use(express.json());

    // Set up version picking middleware
    if (this._customVersioningMiddleware) {
      this.expressApp.use(this._customVersioningMiddleware);
    } else {
      const pickingOpts: VersionPickingOptions = {
        headerName: this.apiVersionHeaderName,
        apiVersionLocation: this.apiVersionLocation,
        apiVersionDefaultValue: this.apiVersionDefaultValue,
        versionValues: this.versions.versionValues,
      };
      this.expressApp.use(versionPickingMiddleware(pickingOpts));
    }

    this._mountUtilityEndpoints();

    // T-2202: Register shutdown hooks
    if (this._onShutdown) {
      const shutdownHandler = () => {
        const result = this._onShutdown!();
        if (result && typeof (result as Promise<void>).then === "function") {
          (result as Promise<void>).then(() => process.exit(0)).catch(() => process.exit(1));
        } else {
          process.exit(0);
        }
      };
      process.on("SIGTERM", shutdownHandler);
      process.on("SIGINT", shutdownHandler);
    }
  }

  /**
   * Mount utility endpoints (OpenAPI, docs, redoc, changelog) on the Express app.
   * These are mounted before versioned routers so they take priority.
   */
  private _mountUtilityEndpoints(): void {
    // OpenAPI JSON endpoint
    if (this.openApiUrl !== null) {
      this.expressApp.get(this.openApiUrl, (req: Request, res: Response) => {
        const version =
          (req.query.version as string) ||
          (req.headers[this.apiVersionHeaderName.toLowerCase()] as string) ||
          this.versions.versionValues[0];

        // T-2005: Handle ?version=unversioned
        if (version === "unversioned") {
          // Ensure initialization has happened
          if (!this._initialized && this._pendingRouters) {
            this._performInitialization();
          }
          const publicUnversionedRoutes = this.unversionedRouter.routes.filter(
            (r) => r.includeInSchema !== false,
          );
          if (publicUnversionedRoutes.length === 0) {
            res.status(404).json({
              detail: `OpenAPI file with version \`unversioned\` not found`,
            });
            return;
          }
          const doc = buildOpenAPIDocument({
            title: this.title,
            appVersion: this.appVersion,
            apiVersion: "unversioned",
            description: this.description || undefined,
            routes: this.unversionedRouter.routes,
            registry: undefined,
            apiVersionHeaderName: this.apiVersionHeaderName,
            changelogUrl: this.changelogUrl,
            includeChangelogUrlInSchema: this.includeChangelogUrlInSchema,
            basePath: req.baseUrl || undefined,
            apiVersionTitle: this.apiVersionTitle,
            apiVersionDescription: this.apiVersionDescription,
          });
          res.json(doc);
          return;
        }

        if (!this.versions.versionValues.includes(version)) {
          res.status(404).json({
            detail: `OpenAPI file with version \`${version}\` not found`,
          });
          return;
        }

        // T-2004: Pass basePath from req.baseUrl
        const doc = this.openapi(version, req.baseUrl || undefined);
        res.json(doc);
      });

      // Swagger UI docs dashboard
      if (this.docsUrl !== null) {
        this.expressApp.get(this.docsUrl, (req: Request, res: Response) => {
          const version = req.query.version as string | undefined;

          if (version) {
            const openApiFullUrl = `${this.openApiUrl}?version=${encodeURIComponent(version)}`;
            const html = renderSwaggerUI(openApiFullUrl, this.title, this.assetUrls);
            res.type("html").send(html);
            return;
          }

          const html = renderDocsDashboard(this.versions.versionValues, this.docsUrl!);
          res.type("html").send(html);
        });
      }

      // ReDoc docs dashboard
      if (this.redocUrl !== null) {
        this.expressApp.get(this.redocUrl, (req: Request, res: Response) => {
          const version = req.query.version as string | undefined;

          if (version) {
            const openApiFullUrl = `${this.openApiUrl}?version=${encodeURIComponent(version)}`;
            const html = renderRedocUI(openApiFullUrl, this.title, this.assetUrls);
            res.type("html").send(html);
            return;
          }

          const html = renderDocsDashboard(this.versions.versionValues, this.redocUrl!);
          res.type("html").send(html);
        });
      }
    }

    // Changelog endpoint
    if (this.changelogUrl !== null) {
      this.expressApp.get(this.changelogUrl, (_req: Request, res: Response) => {
        const changelog = this.generateChangelog();
        res.json(changelog);
      });
    }
  }

  /**
   * Generate versioned routers from the given VersionedRouter(s) and mount them
   * on the Express app. Initialization is performed eagerly so that validation
   * errors surface at configuration time rather than on the first request.
   */
  generateAndIncludeVersionedRouters(...routers: VersionedRouter[]): void {
    this._pendingRouters = routers;

    // Perform initialization eagerly so validation errors surface at configuration time
    this._performInitialization();

    // T-2201: Mount versioned dispatch BEFORE unversioned routes.
    // Versioned routes get priority; if versioned dispatch doesn't match,
    // it calls next() and falls through to unversioned routes.
    this.expressApp.use((req: Request, res: Response, next: NextFunction) => {
      this._dispatchToVersionedRouter(req, res, next);
    });

    // Mount unversioned routes AFTER versioned dispatch (fallback)
    this._mountUnversionedRoutes();
  }

  /**
   * Mount unversioned routes directly on the Express app.
   */
  private _mountUnversionedRoutes(): void {
    if (this.unversionedRouter.routes.length === 0) return;

    const unversionedExpressRouter = Router();
    for (const routeDef of this.unversionedRouter.routes) {
      const method = routeDef.method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";
      const handler = this._wrapHandlerWithOverrides(routeDef);
      unversionedExpressRouter[method](routeDef.path, handler);
    }
    this.expressApp.use(unversionedExpressRouter);
  }

  /**
   * Wrap a route handler to check dependencyOverrides before calling.
   */
  private _wrapHandlerWithOverrides(routeDef: RouteDefinition): (req: Request, res: Response, next: NextFunction) => void {
    const successStatus = routeDef.statusCode ?? 200;
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        const effectiveHandler = this.dependencyOverrides.get(routeDef.handler) as
          | typeof routeDef.handler
          | undefined;
        const handler = effectiveHandler || routeDef.handler;

        const handlerReq = {
          body: req.body,
          params: req.params,
          query: req.query,
          headers: req.headers,
        };

        const result = await handler(handlerReq);
        res.status(successStatus).json(result);
      } catch (err) {
        next(err);
      }
    };
  }

  /**
   * Perform lazy initialization: generate versioned routers from pending routers.
   */
  private _performInitialization(): void {
    if (this._initialized || !this._pendingRouters) return;

    // Build a real VersionedRouter that preserves router-level middleware
    // from all pending routers (fixes bug where .use() was silently dropped).
    const mergedRouter = new VersionedRouter();
    for (const r of this._pendingRouters) {
      mergedRouter.routes.push(...r.routes);
      for (const mw of r.routerMiddleware) {
        mergedRouter.use(mw);
      }
    }

    // Store routes for OpenAPI generation
    this._routes = mergedRouter.routes;

    const generatedRouters = generateVersionedRouters(
      mergedRouter,
      this.versions,
      this.dependencyOverrides,
      this.webhooks.routes.length > 0 ? this.webhooks.routes : undefined,
    );

    // Store per-version routes for OpenAPI generation
    this._versionedRoutes = generatedRouters.versionedRoutes;

    // Store per-version webhook routes (documentation-only, from the same generation pipeline)
    this._versionedWebhookRoutes = generatedRouters.versionedWebhookRoutes;

    // Store in the internal root router (T-1303)
    this._rootRouter.setVersionedRouters(generatedRouters.routers);

    // Build versioned schemas for OpenAPI generation (include webhook schemas too)
    const allRoutes = [...mergedRouter.routes, ...this.webhooks.routes];
    this._versionedSchemas = generateVersionedSchemas(
      this.versions,
      this._buildRegistryFromRoutes(allRoutes),
    );

    // Provide OpenAPI data to the root router
    this._rootRouter.setOpenAPIData(this._routes, this._versionedSchemas);

    this._initialized = true;
    this._pendingRouters = null;

    // T-2202: Call onStartup hook at the end of initialization
    if (this._onStartup) {
      this._onStartup();
    }
  }

  /**
   * Dispatch a request to the appropriate versioned router.
   */
  private _dispatchToVersionedRouter(req: Request, res: Response, next: NextFunction): void {
    const versionValues = this.versions.versionValues;
    const versionSet = new Set(versionValues);
    let version: string | undefined;

    if (this.apiVersionLocation === "path") {
      // Extract version from path
      version = this._extractVersionFromPath(req.path);
      if (version) {
        // Strip the version prefix from the URL for the sub-router
        req.url = req.url.replace(`/${version}`, "") || "/";
      }
    } else {
      // Read from AsyncLocalStorage (set by versionPickingMiddleware)
      const storedVersion = apiVersionStorage.getStore();
      version = storedVersion || undefined;
    }

    // Fallback to latest version if no version specified
    if (!version) {
      version = versionValues[0];
    }

    // Validate that the requested version is in the known set
    if (!versionSet.has(version)) {
      // T-2200: Version waterfalling - find closest version <= requested date
      if (this._enableWaterfalling && this.apiVersionFormat === "date") {
        const closestVersion = this._findClosestVersion(version);
        if (closestVersion) {
          version = closestVersion;
        } else {
          res.status(422).json({
            detail: `Invalid API version "${version}". No version available at or before this date. Available versions: ${versionValues.join(", ")}`,
          });
          return;
        }
      } else {
        res.status(422).json({
          detail: `Invalid API version "${version}". Available versions: ${versionValues.join(", ")}`,
        });
        return;
      }
    }

    const dispatched = this._rootRouter.dispatch(version, req, res, next);
    if (!dispatched) {
      // T-2201: Fall through to unversioned routes if versioned dispatch returns no match
      next();
      return;
    }
  }

  /**
   * T-2200: Find the closest version that is <= the requested date using binary search.
   * versionValues are sorted newest-first, so reversedVersionValues are oldest-first.
   */
  private _findClosestVersion(requestedVersion: string): string | undefined {
    const sorted = this.versions.reversedVersionValues;
    if (sorted.length === 0) return undefined;
    if (requestedVersion < sorted[0]) return undefined;

    let lo = 0;
    let hi = sorted.length - 1;
    let result = -1;

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (sorted[mid] <= requestedVersion) {
        result = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    if (result === -1) return undefined;
    return sorted[result];
  }

  /**
   * Extract the version from the URL path by matching known version values.
   */
  private _extractVersionFromPath(path: string): string | undefined {
    for (const v of this.versions.versionValues) {
      if (path.startsWith(`/${v}/`) || path === `/${v}`) {
        return v;
      }
    }
    return undefined;
  }

  /**
   * Generate the OpenAPI JSON document for a given API version.
   */
  openapi(version: string, basePath?: string): OpenAPIDocument {
    // Ensure initialization has happened
    if (!this._initialized && this._pendingRouters) {
      this._performInitialization();
    }
    const registry = this._versionedSchemas.get(version);
    // Use per-version routes if available (these include endpoint().had() changes)
    const routes = this._versionedRoutes.get(version) ?? this._routes;
    const webhookRoutes = this._versionedWebhookRoutes.get(version) ?? this.webhooks.routes;
    return buildOpenAPIDocument({
      title: this.title,
      appVersion: this.appVersion,
      apiVersion: version,
      description: this.description || undefined,
      routes,
      webhookRoutes: webhookRoutes.length > 0 ? webhookRoutes : undefined,
      registry,
      apiVersionHeaderName: this.apiVersionHeaderName,
      changelogUrl: this.changelogUrl,
      includeChangelogUrlInSchema: this.includeChangelogUrlInSchema,
      basePath,
      apiVersionTitle: this.apiVersionTitle,
      apiVersionDescription: this.apiVersionDescription,
      separateInputOutputSchemas: this.separateInputOutputSchemas,
    });
  }

  /**
   * Generate the structured changelog from the version bundle.
   */
  generateChangelog(): ChangelogResource {
    return generateChangelog(this.versions);
  }

  /**
   * Validate version values match the configured format and are sorted correctly.
   */
  private _validateVersionFormat(): void {
    const versions = this.versions.versionValues;

    if (this.apiVersionFormat === "date") {
      // Validate each version is a valid ISO date string
      for (const v of versions) {
        if (!_isValidISODate(v)) {
          throw new TsadwynStructureError(
            `Version value "${v}" is not a valid ISO date (YYYY-MM-DD).`,
          );
        }
      }

      // Validate versions are sorted newest-first
      for (let i = 0; i < versions.length - 1; i++) {
        if (versions[i] <= versions[i + 1]) {
          throw new TsadwynStructureError(
            `Versions must be sorted from newest to oldest, but "${versions[i]}" ` +
            `is not newer than "${versions[i + 1]}".`,
          );
        }
      }
    }
    // When apiVersionFormat is "string", no format or ordering validation
  }

  /**
   * Build a ZodSchemaRegistry from route definitions.
   */
  private _buildRegistryFromRoutes(routes: RouteDefinition[]): ZodSchemaRegistry {
    const registry = new ZodSchemaRegistry();
    for (const route of routes) {
      if (route.requestSchema && (route.requestSchema as any)._tsadwynName) {
        registry.register(
          (route.requestSchema as any)._tsadwynName,
          route.requestSchema,
        );
      }
      if (route.responseSchema && (route.responseSchema as any)._tsadwynName) {
        registry.register(
          (route.responseSchema as any)._tsadwynName,
          route.responseSchema,
        );
      }
    }

    // T-2400: Also discover schemas from version change instructions
    const knownSchemas = AlterSchemaInstructionFactory._knownSchemas;
    for (const version of this.versions.versions) {
      for (const change of version.changes) {
        for (const instr of change._alterSchemaInstructions) {
          const name = (instr as any).schemaName as string | undefined;
          if (name && !registry.has(name) && knownSchemas.has(name)) {
            registry.register(name, knownSchemas.get(name)!);
          }
        }
      }
    }
    if (this.versions.headVersion) {
      for (const change of this.versions.headVersion.changes) {
        for (const instr of change._alterSchemaInstructions) {
          const name = (instr as any).schemaName as string | undefined;
          if (name && !registry.has(name) && knownSchemas.has(name)) {
            registry.register(name, knownSchemas.get(name)!);
          }
        }
      }
    }

    return registry;
  }

}
