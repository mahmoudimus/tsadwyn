import type { ZodTypeAny } from "zod";
import { getSchemaName as _getSchemaName } from "../zod-extend.js";

// Valid HTTP methods for path-based instructions
const VALID_HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function validateHttpMethods(methods: string[]): void {
  for (const m of methods) {
    if (!VALID_HTTP_METHODS.has(m.toUpperCase())) {
      throw new Error(`Invalid HTTP method: "${m}". Must be one of: ${[...VALID_HTTP_METHODS].join(", ")}`);
    }
  }
}

/**
 * Cookie options for ResponseInfo.setCookie / deleteCookie.
 */
export interface CookieOptions {
  domain?: string;
  path?: string;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "strict" | "lax" | "none";
  expires?: Date;
}

/**
 * Internal record of a cookie that should be set on the response.
 */
export interface SetCookieRecord {
  name: string;
  value: string;
  options?: CookieOptions;
}

/**
 * Internal record of a cookie that should be deleted from the response.
 */
export interface DeleteCookieRecord {
  name: string;
  options?: CookieOptions;
}

/**
 * Information about the incoming request, available for migration callbacks.
 */
export class RequestInfo {
  body: any;
  headers: Record<string, string>;
  queryParams: Record<string, string>;
  cookies: Record<string, string>;
  form: Array<[string, string | File]> | null;

  constructor(
    body: any,
    headers: Record<string, string>,
    queryParams: Record<string, string> = {},
    cookies: Record<string, string> = {},
    form: Array<[string, string | File]> | null = null,
  ) {
    this.body = body;
    this.headers = { ...headers };
    this.queryParams = { ...queryParams };
    this.cookies = { ...cookies };
    this.form = form;
  }
}

/**
 * Information about the outgoing response, available for migration callbacks.
 */
export class ResponseInfo {
  body: any;
  statusCode: number;
  headers: Record<string, string>;

  /** Cookies to set on the response after migration. */
  _cookiesToSet: SetCookieRecord[] = [];
  /** Cookies to delete from the response after migration. */
  _cookiesToDelete: DeleteCookieRecord[] = [];

  constructor(body: any, statusCode: number = 200, headers: Record<string, string> = {}) {
    this.body = body;
    this.statusCode = statusCode;
    this.headers = { ...headers };
  }

  /**
   * Queue a Set-Cookie header to be applied to the Express response.
   */
  setCookie(name: string, value: string, options?: CookieOptions): void {
    this._cookiesToSet.push({ name, value, options });
  }

  /**
   * Queue a cookie deletion to be applied to the Express response.
   */
  deleteCookie(name: string, options?: CookieOptions): void {
    this._cookiesToDelete.push({ name, options });
  }
}

/**
 * Internal instruction for request migration by schema.
 */
export interface AlterRequestBySchemaInstruction {
  kind: "alter_request_by_schema";
  schemaNames: string[];
  transformer: (request: RequestInfo) => void;
  methodName: string;
  checkUsage: boolean;
}

/**
 * Internal instruction for response migration by schema.
 */
export interface AlterResponseBySchemaInstruction {
  kind: "alter_response_by_schema";
  schemaNames: string[];
  transformer: (response: ResponseInfo) => void;
  methodName: string;
  migrateHttpErrors: boolean;
  checkUsage: boolean;
  /** When true, migration runs on body-less responses (HEAD, 204, 304). */
  headerOnly: boolean;
}

/**
 * Internal instruction for request migration by path.
 */
export interface AlterRequestByPathInstruction {
  kind: "alter_request_by_path";
  path: string;
  methods: Set<string>;
  transformer: (request: RequestInfo) => void;
  methodName: string;
}

/**
 * Internal instruction for response migration by path.
 */
export interface AlterResponseByPathInstruction {
  kind: "alter_response_by_path";
  path: string;
  methods: Set<string>;
  transformer: (response: ResponseInfo) => void;
  methodName: string;
  migrateHttpErrors: boolean;
  /** When true, migration runs on body-less responses (HEAD, 204, 304). */
  headerOnly: boolean;
}

/**
 * Options for convertRequestToNextVersionFor when using schema-based migration.
 */
export interface RequestMigrationOptions {
  checkUsage?: boolean;
}

/**
 * Options for convertResponseToPreviousVersionFor when using schema-based migration.
 */
export interface ResponseMigrationOptions {
  migrateHttpErrors?: boolean;
  checkUsage?: boolean;
  /**
   * When true, the migration runs even on body-less responses (HEAD, 204 No
   * Content, 304 Not Modified). Use when your transformer only touches
   * `res.headers` and doesn't depend on `res.body` being populated.
   *
   * Composes with `migrateHttpErrors: true` — a migration flagged both
   * headerOnly and migrateHttpErrors runs on error responses too.
   */
  headerOnly?: boolean;
}

/**
 * Decorator (used as a function) that marks a method as a request migration.
 *
 * Can be called with Zod schemas or with a path + methods array.
 *
 * Schema-based usage:
 * ```
 * @convertRequestToNextVersionFor(MySchema)
 * migrateRequest(request: RequestInfo) { ... }
 * ```
 *
 * Path-based usage:
 * ```
 * @convertRequestToNextVersionFor("/users/:id", ["GET"])
 * migrateRequest(request: RequestInfo) { ... }
 * ```
 */
export function convertRequestToNextVersionFor(
  pathOrFirstSchema: string | (ZodTypeAny & { _tsadwynName?: string }),
  methodsOrSecondSchema?: string[] | (ZodTypeAny & { _tsadwynName?: string }),
  ...rest: any[]
): any {
  // Parse options from rest args if present
  // Path-based: convertRequestToNextVersionFor("/path", ["GET"])
  if (typeof pathOrFirstSchema === "string") {
    if (!Array.isArray(methodsOrSecondSchema)) {
      throw new TypeError("If path was provided as a first argument, methods must be provided as a second argument");
    }
    validateHttpMethods(methodsOrSecondSchema);
    const path = pathOrFirstSchema;
    const methods = new Set(methodsOrSecondSchema.map((m: string) => m.toUpperCase()));

    return function decoratorOrWrapper(
      targetOrTransformer: any,
      propertyKeyOrUndefined?: string | symbol,
      descriptorOrUndefined?: PropertyDescriptor,
    ): any {
      // Case 1: TypeScript decorator
      if (propertyKeyOrUndefined !== undefined && descriptorOrUndefined !== undefined) {
        const originalMethod = descriptorOrUndefined.value;
        const instruction: AlterRequestByPathInstruction = {
          kind: "alter_request_by_path",
          path,
          methods,
          transformer: (request: RequestInfo) => originalMethod.call(targetOrTransformer, request),
          methodName: String(propertyKeyOrUndefined),
        };
        descriptorOrUndefined.value = instruction;
        return descriptorOrUndefined;
      }

      // Case 2: Wrapping function
      const transformer = targetOrTransformer as (request: RequestInfo) => void;
      const instruction: AlterRequestByPathInstruction = {
        kind: "alter_request_by_path",
        path,
        methods,
        transformer,
        methodName: transformer.name || "anonymous",
      };
      return instruction;
    };
  }

  // Schema-based: convertRequestToNextVersionFor(Schema1, Schema2, ..., { checkUsage: true })
  const schemas: Array<ZodTypeAny & { _tsadwynName?: string }> = [pathOrFirstSchema];
  let options: RequestMigrationOptions = {};

  if (methodsOrSecondSchema !== undefined) {
    // Could be another schema or not present
    if (typeof methodsOrSecondSchema === "object" && "_def" in (methodsOrSecondSchema as any)) {
      schemas.push(methodsOrSecondSchema as ZodTypeAny & { _tsadwynName?: string });
    } else if (typeof methodsOrSecondSchema === "object" && !("_def" in (methodsOrSecondSchema as any))) {
      // Second argument is an options object, not a schema
      options = methodsOrSecondSchema as RequestMigrationOptions;
    }
  }

  // Check rest for more schemas or options
  for (const arg of rest) {
    if (arg && typeof arg === "object" && "_def" in arg) {
      schemas.push(arg);
    } else if (arg && typeof arg === "object" && !("_def" in arg)) {
      options = arg as RequestMigrationOptions;
    }
  }

  const checkUsage = options.checkUsage !== undefined ? options.checkUsage : true;

  const schemaNames = schemas.map((s) => {
    const name = _getSchemaName(s);
    if (!name) {
      throw new Error("Schema must have a name. Use `.named('SchemaName')` on the Zod schema.");
    }
    return name;
  });

  return function decoratorOrWrapper(
    targetOrTransformer: any,
    propertyKeyOrUndefined?: string | symbol,
    descriptorOrUndefined?: PropertyDescriptor,
  ): any {
    // Case 1: TypeScript decorator
    if (propertyKeyOrUndefined !== undefined && descriptorOrUndefined !== undefined) {
      const originalMethod = descriptorOrUndefined.value;
      const instruction: AlterRequestBySchemaInstruction = {
        kind: "alter_request_by_schema",
        schemaNames,
        transformer: (request: RequestInfo) => originalMethod.call(targetOrTransformer, request),
        methodName: String(propertyKeyOrUndefined),
        checkUsage,
      };
      descriptorOrUndefined.value = instruction;
      return descriptorOrUndefined;
    }

    // Case 2: Wrapping function
    const transformer = targetOrTransformer as (request: RequestInfo) => void;
    const instruction: AlterRequestBySchemaInstruction = {
      kind: "alter_request_by_schema",
      schemaNames,
      transformer,
      methodName: transformer.name || "anonymous",
      checkUsage,
    };
    return instruction;
  };
}

/**
 * Decorator (used as a function) that marks a method as a response migration.
 *
 * Can be called with Zod schemas or with a path + methods array.
 *
 * Schema-based usage:
 * ```
 * @convertResponseToPreviousVersionFor(MySchema, { migrateHttpErrors: true })
 * migrateResponse(response: ResponseInfo) { ... }
 * ```
 *
 * Path-based usage:
 * ```
 * @convertResponseToPreviousVersionFor("/users/:id", ["GET"], { migrateHttpErrors: true })
 * migrateResponse(response: ResponseInfo) { ... }
 * ```
 */
export function convertResponseToPreviousVersionFor(
  pathOrFirstSchema: string | (ZodTypeAny & { _tsadwynName?: string }),
  methodsOrSecondSchema?: string[] | (ZodTypeAny & { _tsadwynName?: string }),
  ...rest: any[]
): any {
  // Path-based
  if (typeof pathOrFirstSchema === "string") {
    if (!Array.isArray(methodsOrSecondSchema)) {
      throw new TypeError("If path was provided as a first argument, methods must be provided as a second argument");
    }
    validateHttpMethods(methodsOrSecondSchema);
    const path = pathOrFirstSchema;
    const methods = new Set(methodsOrSecondSchema.map((m: string) => m.toUpperCase()));

    // Check for options in rest. Default: TRUE — response migrations apply
    // to error responses by default, matching Stripe's versioning semantics.
    // Pass { migrateHttpErrors: false } to opt out for migrations that only
    // touch success-response shapes.
    let migrateHttpErrors = true;
    let headerOnly = false;
    for (const arg of rest) {
      if (arg && typeof arg === "object" && "migrateHttpErrors" in arg) {
        migrateHttpErrors = arg.migrateHttpErrors ?? true;
      }
      if (arg && typeof arg === "object" && "headerOnly" in arg) {
        headerOnly = arg.headerOnly ?? false;
      }
    }

    return function decoratorOrWrapper(
      targetOrTransformer: any,
      propertyKeyOrUndefined?: string | symbol,
      descriptorOrUndefined?: PropertyDescriptor,
    ): any {
      // Case 1: TypeScript decorator
      if (propertyKeyOrUndefined !== undefined && descriptorOrUndefined !== undefined) {
        const originalMethod = descriptorOrUndefined.value;
        const instruction: AlterResponseByPathInstruction = {
          kind: "alter_response_by_path",
          path,
          methods,
          transformer: (response: ResponseInfo) => originalMethod.call(targetOrTransformer, response),
          methodName: String(propertyKeyOrUndefined),
          migrateHttpErrors,
          headerOnly,
        };
        descriptorOrUndefined.value = instruction;
        return descriptorOrUndefined;
      }

      // Case 2: Wrapping function
      const transformer = targetOrTransformer as (response: ResponseInfo) => void;
      const instruction: AlterResponseByPathInstruction = {
        kind: "alter_response_by_path",
        path,
        methods,
        transformer,
        methodName: transformer.name || "anonymous",
        migrateHttpErrors,
        headerOnly,
      };
      return instruction;
    };
  }

  // Schema-based
  const schemas: Array<ZodTypeAny & { _tsadwynName?: string }> = [pathOrFirstSchema];
  let options: ResponseMigrationOptions = {};

  if (methodsOrSecondSchema !== undefined) {
    if (typeof methodsOrSecondSchema === "object" && "_def" in (methodsOrSecondSchema as any)) {
      schemas.push(methodsOrSecondSchema as ZodTypeAny & { _tsadwynName?: string });
    } else if (typeof methodsOrSecondSchema === "object" && !("_def" in (methodsOrSecondSchema as any))) {
      // Second argument is an options object, not a schema
      options = methodsOrSecondSchema as ResponseMigrationOptions;
    }
  }

  for (const arg of rest) {
    if (arg && typeof arg === "object" && "_def" in arg) {
      schemas.push(arg);
    } else if (arg && typeof arg === "object" && !("_def" in arg)) {
      options = arg as ResponseMigrationOptions;
    }
  }

  // Default: TRUE — response migrations apply to error responses by default.
  // Stripe-style versioning: error envelopes drift across versions and clients
  // pinned to older versions see their version's error shape. Pass
  // { migrateHttpErrors: false } for migrations that should only affect
  // success-response bodies.
  const migrateHttpErrors = options.migrateHttpErrors !== undefined ? options.migrateHttpErrors : true;
  const checkUsage = options.checkUsage !== undefined ? options.checkUsage : true;
  const headerOnly = options.headerOnly ?? false;

  const schemaNames = schemas.map((s) => {
    const name = _getSchemaName(s);
    if (!name) {
      throw new Error("Schema must have a name. Use `.named('SchemaName')` on the Zod schema.");
    }
    return name;
  });

  return function decoratorOrWrapper(
    targetOrTransformer: any,
    propertyKeyOrUndefined?: string | symbol,
    descriptorOrUndefined?: PropertyDescriptor,
  ): any {
    // Case 1: TypeScript decorator
    if (propertyKeyOrUndefined !== undefined && descriptorOrUndefined !== undefined) {
      const originalMethod = descriptorOrUndefined.value;
      const instruction: AlterResponseBySchemaInstruction = {
        kind: "alter_response_by_schema",
        schemaNames,
        transformer: (response: ResponseInfo) => originalMethod.call(targetOrTransformer, response),
        methodName: String(propertyKeyOrUndefined),
        migrateHttpErrors,
        checkUsage,
        headerOnly,
      };
      descriptorOrUndefined.value = instruction;
      return descriptorOrUndefined;
    }

    // Case 2: Wrapping function
    const transformer = targetOrTransformer as (response: ResponseInfo) => void;
    const instruction: AlterResponseBySchemaInstruction = {
      kind: "alter_response_by_schema",
      schemaNames,
      transformer,
      methodName: transformer.name || "anonymous",
      migrateHttpErrors,
      checkUsage,
      headerOnly,
    };
    return instruction;
  };
}
