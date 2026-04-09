import type { ZodTypeAny } from "zod";

/**
 * Information about the incoming request, available for migration callbacks.
 */
export class RequestInfo {
  body: any;
  headers: Record<string, string>;
  queryParams: Record<string, string>;

  constructor(body: any, headers: Record<string, string>, queryParams: Record<string, string> = {}) {
    this.body = body;
    this.headers = { ...headers };
    this.queryParams = { ...queryParams };
  }
}

/**
 * Information about the outgoing response, available for migration callbacks.
 */
export class ResponseInfo {
  body: any;
  statusCode: number;
  headers: Record<string, string>;

  constructor(body: any, statusCode: number = 200, headers: Record<string, string> = {}) {
    this.body = body;
    this.statusCode = statusCode;
    this.headers = { ...headers };
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
}

/**
 * Internal instruction for response migration by schema.
 */
export interface AlterResponseBySchemaInstruction {
  kind: "alter_response_by_schema";
  schemaNames: string[];
  transformer: (response: ResponseInfo) => void;
  methodName: string;
}

/**
 * Decorator (used as a function) that marks a method as a request migration.
 *
 * In TypeScript we implement this as a higher-order function that returns a
 * property descriptor value (the instruction object) which gets placed on the
 * class at that property key.
 *
 * Usage inside a VersionChange subclass:
 * ```
 * @convertRequestToNextVersionFor(MySchema)
 * migrateRequest(request: RequestInfo) { ... }
 * ```
 *
 * Or as a function returning a decorator:
 * ```
 * static migrateRequest = convertRequestToNextVersionFor(MySchema)(
 *   (request: RequestInfo) => { ... }
 * );
 * ```
 */
export function convertRequestToNextVersionFor(
  ...schemas: Array<ZodTypeAny & { _tsadwynName?: string }>
): any {
  const schemaNames = schemas.map((s) => {
    if (!s._tsadwynName) {
      throw new Error("Schema must have a name. Use `.named('SchemaName')` on the Zod schema.");
    }
    return s._tsadwynName;
  });

  // This can be used either as a decorator or as a function that wraps a callback.
  return function decoratorOrWrapper(
    targetOrTransformer: any,
    propertyKeyOrUndefined?: string | symbol,
    descriptorOrUndefined?: PropertyDescriptor,
  ): any {
    // Case 1: Used as a TypeScript decorator (@convertRequestToNextVersionFor(Schema))
    if (propertyKeyOrUndefined !== undefined && descriptorOrUndefined !== undefined) {
      const originalMethod = descriptorOrUndefined.value;
      const instruction: AlterRequestBySchemaInstruction = {
        kind: "alter_request_by_schema",
        schemaNames,
        transformer: (request: RequestInfo) => originalMethod(request),
        methodName: String(propertyKeyOrUndefined),
      };
      descriptorOrUndefined.value = instruction;
      return descriptorOrUndefined;
    }

    // Case 2: Used as a wrapping function
    const transformer = targetOrTransformer as (request: RequestInfo) => void;
    const instruction: AlterRequestBySchemaInstruction = {
      kind: "alter_request_by_schema",
      schemaNames,
      transformer,
      methodName: transformer.name || "anonymous",
    };
    return instruction;
  };
}

/**
 * Decorator (used as a function) that marks a method as a response migration.
 *
 * Same usage patterns as convertRequestToNextVersionFor but for responses.
 */
export function convertResponseToPreviousVersionFor(
  ...schemas: Array<ZodTypeAny & { _tsadwynName?: string }>
): any {
  const schemaNames = schemas.map((s) => {
    if (!s._tsadwynName) {
      throw new Error("Schema must have a name. Use `.named('SchemaName')` on the Zod schema.");
    }
    return s._tsadwynName;
  });

  return function decoratorOrWrapper(
    targetOrTransformer: any,
    propertyKeyOrUndefined?: string | symbol,
    descriptorOrUndefined?: PropertyDescriptor,
  ): any {
    // Case 1: Used as a TypeScript decorator
    if (propertyKeyOrUndefined !== undefined && descriptorOrUndefined !== undefined) {
      const originalMethod = descriptorOrUndefined.value;
      const instruction: AlterResponseBySchemaInstruction = {
        kind: "alter_response_by_schema",
        schemaNames,
        transformer: (response: ResponseInfo) => originalMethod(response),
        methodName: String(propertyKeyOrUndefined),
      };
      descriptorOrUndefined.value = instruction;
      return descriptorOrUndefined;
    }

    // Case 2: Used as a wrapping function
    const transformer = targetOrTransformer as (response: ResponseInfo) => void;
    const instruction: AlterResponseBySchemaInstruction = {
      kind: "alter_response_by_schema",
      schemaNames,
      transformer,
      methodName: transformer.name || "anonymous",
    };
    return instruction;
  };
}
