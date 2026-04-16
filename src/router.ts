import { z, ZodType, ZodTypeAny } from "zod";
import type { Request, Response, NextFunction } from "express";

/**
 * Tag used to mark routes that are deleted (only exist in older versions).
 */
export const _DELETED_ROUTE_TAG = "_TSADWYN_DELETED_ROUTE";

/**
 * Express-compatible middleware function type.
 */
export type MiddlewareFunction = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

/**
 * A route definition that carries Zod schemas for request/response validation.
 */
export interface RouteDefinition {
  method: string;
  path: string;
  requestSchema: ZodTypeAny | null;
  responseSchema: ZodTypeAny | null;
  handler: (req: any) => Promise<any>;
  /** Optional function name for disambiguation when multiple routes share path+method. */
  funcName: string | null;
  /** Internal tags for route management. */
  tags: string[];
  /** HTTP status code for the response. */
  statusCode: number;
  /** Whether the route is deprecated. */
  deprecated: boolean;
  /** Route summary (for OpenAPI). */
  summary: string;
  /** Route description (for OpenAPI). */
  description: string;
  /** Route operation ID (for OpenAPI). */
  operationId: string;
  /** T-600: Optional Zod schema for validating path parameters. */
  paramsSchema: ZodTypeAny | null;
  /** T-601: Optional Zod schema for validating query parameters. */
  querySchema: ZodTypeAny | null;
  /** T-602: Route-level middleware functions. */
  middleware: MiddlewareFunction[];
  /** T-2001: Whether to include this route in the OpenAPI schema. */
  includeInSchema: boolean;
  /** T-2002: Custom responses dict for OpenAPI. */
  responses: Record<string, any> | null;
  /** T-2003: Callbacks for OpenAPI. */
  callbacks: Array<{ path: string; method: string; description?: string }> | null;
}

/**
 * Deep-clone a route definition.
 */
export function cloneRouteDefinition(route: RouteDefinition): RouteDefinition {
  return {
    method: route.method,
    path: route.path,
    requestSchema: route.requestSchema,
    responseSchema: route.responseSchema,
    handler: route.handler,
    funcName: route.funcName,
    tags: [...route.tags],
    statusCode: route.statusCode,
    deprecated: route.deprecated,
    summary: route.summary,
    description: route.description,
    operationId: route.operationId,
    paramsSchema: route.paramsSchema,
    querySchema: route.querySchema,
    middleware: [...route.middleware],
    includeInSchema: route.includeInSchema,
    responses: route.responses ? { ...route.responses } : null,
    callbacks: route.callbacks ? route.callbacks.map((cb) => ({ ...cb })) : null,
  };
}

/**
 * A typed request object passed to route handlers.
 */
export interface TypedRequest<TBody = unknown, TParams = Record<string, string>, TQuery = Record<string, string>> {
  body: TBody;
  params: TParams;
  query: TQuery;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * T-602: Options that can be passed when registering a route.
 */
export interface RouteOptions {
  /** T-602: Route-level middleware functions. */
  middleware?: MiddlewareFunction[];
  /** T-600: Zod schema for validating path parameters. */
  paramsSchema?: ZodTypeAny;
  /** T-601: Zod schema for validating query parameters. */
  querySchema?: ZodTypeAny;
  /**
   * HTTP status code to emit on successful responses. Defaults to 200.
   *
   * Set to `201` for POST routes that create a resource, `202` for routes
   * that enqueue async work, etc. When omitted, tsadwyn emits 200 for
   * every success path — the OpenAPI spec reflects the same default, so
   * overriding here is the single source of truth for both runtime status
   * and schema documentation.
   */
  statusCode?: number;
  /** T-2001: Whether to include this route in the OpenAPI schema. Default: true. */
  includeInSchema?: boolean;
  /** T-2002: Custom responses dict for OpenAPI. */
  responses?: Record<string, any>;
  /** T-2003: Callbacks for OpenAPI. */
  callbacks?: Array<{ path: string; method: string; description?: string }>;
  /**
   * OpenAPI tags for grouping this route in generated Swagger UI / ReDoc
   * output. Flow into `RouteDefinition.tags` at registration and compose
   * with any `endpoint().had({tags})` mutations in downstream VersionChanges
   * (the `had` form is a REPLACEMENT, not a merge).
   *
   * Tags starting with `_TSADWYN` are reserved for internal use and emit
   * a registration-time warning.
   */
  tags?: string[];
}

/**
 * T-603: Options for constructing a VersionedRouter.
 */
export interface VersionedRouterOptions {
  /** Path prefix to prepend to all routes (e.g. "/api"). */
  prefix?: string;
}

/**
 * VersionedRouter collects route definitions with their Zod schemas.
 * These definitions are later used by Tsadwyn to generate per-version
 * Express routers with appropriate validation and migration.
 *
 * Route methods are generic: when you provide Zod schemas for request and/or
 * response, the handler's `req.body` and return type are inferred automatically.
 */
export class VersionedRouter {
  routes: RouteDefinition[] = [];
  /** T-603: Path prefix for all routes. */
  readonly prefix: string;
  /** T-602: Router-level middleware applied to all routes. */
  private _middleware: MiddlewareFunction[] = [];

  constructor(options?: VersionedRouterOptions) {
    this.prefix = options?.prefix ?? "";
  }

  /**
   * T-602: Add router-level middleware that applies to all routes.
   */
  use(...middleware: MiddlewareFunction[]): void {
    this._middleware.push(...middleware);
  }

  /**
   * Get the combined router-level middleware.
   */
  get routerMiddleware(): MiddlewareFunction[] {
    return this._middleware;
  }

  private addRoute(
    method: string,
    path: string,
    requestSchema: ZodTypeAny | null,
    responseSchema: ZodTypeAny | null,
    handler: (req: any) => Promise<any>,
    options?: RouteOptions,
  ): void {
    // T-603: Apply prefix
    const fullPath = this.prefix ? this.prefix + path : path;

    // Tags — registration-time warn for reserved _TSADWYN prefix; dedup preserves
    // insertion order so OpenAPI output doesn't shuffle consumer intent.
    const optionTags = options?.tags ?? [];
    for (const t of optionTags) {
      if (t.startsWith("_TSADWYN")) {
        // eslint-disable-next-line no-console
        console.warn(
          `tsadwyn: tag "${t}" on route [${method}] ${fullPath} starts with the ` +
            `reserved "_TSADWYN" prefix. Tags starting with "_TSADWYN" are reserved ` +
            `for internal tsadwyn bookkeeping — rename to avoid future collisions.`,
        );
      }
    }
    const seenTags = new Set<string>();
    const dedupedTags: string[] = [];
    for (const t of optionTags) {
      if (!seenTags.has(t)) {
        seenTags.add(t);
        dedupedTags.push(t);
      }
    }

    this.routes.push({
      method,
      path: fullPath,
      requestSchema,
      responseSchema,
      handler,
      funcName: handler.name || null,
      tags: dedupedTags,
      statusCode: options?.statusCode ?? 200,
      deprecated: false,
      summary: "",
      description: "",
      operationId: "",
      paramsSchema: options?.paramsSchema ?? null,
      querySchema: options?.querySchema ?? null,
      middleware: options?.middleware ?? [],
      includeInSchema: options?.includeInSchema !== undefined ? options.includeInSchema : true,
      responses: options?.responses ?? null,
      callbacks: options?.callbacks ?? null,
    });
  }

  get<TReq extends ZodTypeAny | null = null, TRes extends ZodTypeAny | null = null>(
    path: string,
    requestSchema: TReq,
    responseSchema: TRes,
    handler: (
      req: TypedRequest<TReq extends ZodType ? z.infer<TReq> : unknown>,
    ) => Promise<TRes extends ZodType ? z.infer<TRes> : any>,
    options?: RouteOptions,
  ): void {
    this.addRoute("GET", path, requestSchema, responseSchema, handler, options);
  }

  post<TReq extends ZodTypeAny | null = null, TRes extends ZodTypeAny | null = null>(
    path: string,
    requestSchema: TReq,
    responseSchema: TRes,
    handler: (
      req: TypedRequest<TReq extends ZodType ? z.infer<TReq> : unknown>,
    ) => Promise<TRes extends ZodType ? z.infer<TRes> : any>,
    options?: RouteOptions,
  ): void {
    this.addRoute("POST", path, requestSchema, responseSchema, handler, options);
  }

  put<TReq extends ZodTypeAny | null = null, TRes extends ZodTypeAny | null = null>(
    path: string,
    requestSchema: TReq,
    responseSchema: TRes,
    handler: (
      req: TypedRequest<TReq extends ZodType ? z.infer<TReq> : unknown>,
    ) => Promise<TRes extends ZodType ? z.infer<TRes> : any>,
    options?: RouteOptions,
  ): void {
    this.addRoute("PUT", path, requestSchema, responseSchema, handler, options);
  }

  patch<TReq extends ZodTypeAny | null = null, TRes extends ZodTypeAny | null = null>(
    path: string,
    requestSchema: TReq,
    responseSchema: TRes,
    handler: (
      req: TypedRequest<TReq extends ZodType ? z.infer<TReq> : unknown>,
    ) => Promise<TRes extends ZodType ? z.infer<TRes> : any>,
    options?: RouteOptions,
  ): void {
    this.addRoute("PATCH", path, requestSchema, responseSchema, handler, options);
  }

  delete<TReq extends ZodTypeAny | null = null, TRes extends ZodTypeAny | null = null>(
    path: string,
    requestSchema: TReq,
    responseSchema: TRes,
    handler: (
      req: TypedRequest<TReq extends ZodType ? z.infer<TReq> : unknown>,
    ) => Promise<TRes extends ZodType ? z.infer<TRes> : any>,
    options?: RouteOptions,
  ): void {
    this.addRoute("DELETE", path, requestSchema, responseSchema, handler, options);
  }

  /**
   * Explicit HEAD handler registration. HEAD is GET without a body —
   * consumers use it for existence checks and cache validation. When no
   * explicit HEAD is registered for a path that has a GET, Express
   * auto-mirrors the GET handler. Explicit registration wins for precise
   * HEAD-specific semantics (skip expensive body computation, HEAD-only
   * cache validators).
   *
   * Handlers return void — HEAD responses carry no body per HTTP spec.
   */
  head<TReq extends ZodTypeAny | null = null, TRes extends ZodTypeAny | null = null>(
    path: string,
    requestSchema: TReq,
    responseSchema: TRes,
    handler: (
      req: TypedRequest<TReq extends ZodType ? z.infer<TReq> : unknown>,
    ) => Promise<void | (TRes extends ZodType ? z.infer<TRes> : any)>,
    options?: RouteOptions,
  ): void {
    this.addRoute("HEAD", path, requestSchema, responseSchema, handler as any, options);
  }

  /**
   * Mark a route so it is excluded from the head (latest) version but can be
   * restored in older versions via `endpoint(...).existed`.
   *
   * @param path  The route path to mark.
   * @param methods  The HTTP methods to match (e.g. ["GET"]).
   */
  onlyExistsInOlderVersions(path: string, methods: string[]): void {
    const methodSet = new Set(methods.map((m) => m.toUpperCase()));
    const normalizedPath = path.replace(/\/+$/, "");

    const matchingRoutes = this.routes.filter((r) => {
      return (
        r.path.replace(/\/+$/, "") === normalizedPath &&
        methodSet.has(r.method.toUpperCase()) &&
        !r.tags.includes(_DELETED_ROUTE_TAG)
      );
    });

    if (matchingRoutes.length === 0) {
      throw new Error(
        `Route not found for path "${path}" with methods [${methods.join(", ")}]. ` +
        "Are you sure it's registered?",
      );
    }

    for (const route of matchingRoutes) {
      route.tags.push(_DELETED_ROUTE_TAG);
    }
  }
}
