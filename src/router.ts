import { ZodTypeAny } from "zod";

/**
 * A route definition that carries Zod schemas for request/response validation.
 */
export interface RouteDefinition {
  method: string;
  path: string;
  requestSchema: ZodTypeAny | null;
  responseSchema: ZodTypeAny | null;
  handler: (req: any) => Promise<any>;
}

/**
 * VersionedRouter collects route definitions with their Zod schemas.
 * These definitions are later used by Cadwyn to generate per-version
 * Express routers with appropriate validation and migration.
 */
export class VersionedRouter {
  routes: RouteDefinition[] = [];

  private addRoute(
    method: string,
    path: string,
    requestSchema: ZodTypeAny | null,
    responseSchema: ZodTypeAny | null,
    handler: (req: any) => Promise<any>,
  ): void {
    this.routes.push({ method, path, requestSchema, responseSchema, handler });
  }

  get(
    path: string,
    requestSchema: ZodTypeAny | null,
    responseSchema: ZodTypeAny | null,
    handler: (req: any) => Promise<any>,
  ): void {
    this.addRoute("GET", path, requestSchema, responseSchema, handler);
  }

  post(
    path: string,
    requestSchema: ZodTypeAny | null,
    responseSchema: ZodTypeAny | null,
    handler: (req: any) => Promise<any>,
  ): void {
    this.addRoute("POST", path, requestSchema, responseSchema, handler);
  }

  put(
    path: string,
    requestSchema: ZodTypeAny | null,
    responseSchema: ZodTypeAny | null,
    handler: (req: any) => Promise<any>,
  ): void {
    this.addRoute("PUT", path, requestSchema, responseSchema, handler);
  }

  patch(
    path: string,
    requestSchema: ZodTypeAny | null,
    responseSchema: ZodTypeAny | null,
    handler: (req: any) => Promise<any>,
  ): void {
    this.addRoute("PATCH", path, requestSchema, responseSchema, handler);
  }

  delete(
    path: string,
    requestSchema: ZodTypeAny | null,
    responseSchema: ZodTypeAny | null,
    handler: (req: any) => Promise<any>,
  ): void {
    this.addRoute("DELETE", path, requestSchema, responseSchema, handler);
  }
}
