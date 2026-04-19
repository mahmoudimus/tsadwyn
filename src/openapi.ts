import { ZodObject, ZodTypeAny, ZodArray, ZodOptional, ZodNullable, ZodDefault, ZodEffects } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { RouteDefinition } from "./router.js";
import type { VersionBundle } from "./structure/versions.js";
import type { ZodSchemaRegistry } from "./schema-generation.js";
import { getSchemaName as _getSchemaName } from "./zod-extend.js";

/**
 * OpenAPI 3.1.0 document shape (simplified).
 */
export interface OpenAPIDocument {
  openapi: string;
  info: {
    title: string;
    version: string;
    description?: string;
  };
  paths: Record<string, Record<string, any>>;
  webhooks?: Record<string, Record<string, any>>;
  servers?: Array<{ url: string; description?: string }>;
  components?: {
    schemas?: Record<string, any>;
    parameters?: Record<string, any>;
  };
}

/**
 * Options for building an OpenAPI document for a single version.
 */
export interface OpenAPIBuildOptions {
  title: string;
  appVersion: string;
  apiVersion: string;
  description?: string;
  routes: RouteDefinition[];
  /** Webhook route definitions (documentation-only, not served as HTTP endpoints). */
  webhookRoutes?: RouteDefinition[];
  registry: ZodSchemaRegistry | undefined;
  apiVersionHeaderName: string;
  changelogUrl?: string | null;
  includeChangelogUrlInSchema?: boolean;
  /** T-2004: Base path / server URL to inject into the servers array. */
  basePath?: string;
  /** T-2006: Title for the API version parameter in the OpenAPI schema. */
  apiVersionTitle?: string;
  /** T-2006: Description for the API version parameter in the OpenAPI schema. */
  apiVersionDescription?: string;
  /** T-2203: When true, generate separate XxxInput and XxxOutput component schemas. */
  separateInputOutputSchemas?: boolean;
}

/**
 * Local indirection so the OpenAPI builder accepts the narrower
 * `ZodTypeAny | null` shape it uses at callsites, while the underlying
 * resolution goes through the canonical WeakMap-backed helper.
 */
function getSchemaName(schema: ZodTypeAny | null): string | null {
  return _getSchemaName(schema);
}

/**
 * Convert a Zod schema to a JSON Schema object, stripping the top-level wrapper.
 */
function zodToOpenAPISchema(schema: ZodTypeAny): Record<string, any> {
  try {
    const jsonSchema = zodToJsonSchema(schema, { target: "openApi3" });
    // Remove the top-level $schema if present
    const result = { ...jsonSchema } as Record<string, any>;
    delete result["$schema"];
    return result;
  } catch {
    return { type: "object" };
  }
}

/**
 * Build the versioned request schema for a route.
 */
function getVersionedSchema(
  routeSchema: ZodTypeAny | null,
  registry: ZodSchemaRegistry | undefined,
): ZodTypeAny | null {
  if (!routeSchema) return null;
  const name = getSchemaName(routeSchema);
  if (name && registry?.has(name)) {
    return registry.get(name)!.schema;
  }
  return routeSchema;
}

/**
 * Build an OpenAPI document for a single API version.
 */
export function buildOpenAPIDocument(options: OpenAPIBuildOptions): OpenAPIDocument {
  const {
    title,
    appVersion,
    apiVersion,
    description,
    routes,
    registry,
    apiVersionHeaderName,
    changelogUrl,
    includeChangelogUrlInSchema,
    basePath,
    apiVersionTitle,
    apiVersionDescription,
    separateInputOutputSchemas,
  } = options;

  const paths: Record<string, Record<string, any>> = {};
  const componentSchemas: Record<string, any> = {};
  const seenSchemaNames = new Set<string>();

  for (const route of routes) {
    const method = route.method.toLowerCase();
    if (!paths[route.path]) {
      paths[route.path] = {};
    }

    // T-2001: Skip routes where includeInSchema is false
    if (route.includeInSchema === false) {
      continue;
    }

    // T-2006: Build the API version parameter with optional title/description
    const versionParam: Record<string, any> = {
      name: apiVersionHeaderName,
      in: "header",
      required: false,
      schema: { type: "string", default: apiVersion },
      description: apiVersionDescription || "API version",
    };
    if (apiVersionTitle) {
      versionParam.title = apiVersionTitle;
    }

    const operation: Record<string, any> = {
      parameters: [versionParam],
      responses: {},
    };

    // T-2000: Serialize tags (filter out internal _TSADWYN tags)
    const publicTags = route.tags.filter((t) => !t.startsWith("_TSADWYN"));
    if (publicTags.length > 0) {
      operation.tags = publicTags;
    }

    // T-2000: Serialize deprecated flag
    if (route.deprecated) {
      operation.deprecated = true;
    }

    // T-2000: Serialize operationId
    if (route.operationId) {
      operation.operationId = route.operationId;
    }

    // T-2000: Serialize summary
    if (route.summary) {
      operation.summary = route.summary;
    }

    // T-2000: Serialize description
    if (route.description) {
      operation.description = route.description;
    }

    // Extract path parameters (Express :param -> OpenAPI {param})
    const pathParams = route.path.match(/:([a-zA-Z_][a-zA-Z0-9_]*)/g);
    if (pathParams) {
      for (const param of pathParams) {
        const paramName = param.slice(1);
        operation.parameters.push({
          name: paramName,
          in: "path",
          required: true,
          schema: { type: "string" },
        });
      }
    }

    // Request body
    const versionedRequestSchema = getVersionedSchema(route.requestSchema, registry);
    if (versionedRequestSchema) {
      const reqJsonSchema = zodToOpenAPISchema(versionedRequestSchema);
      const reqName = getSchemaName(route.requestSchema);

      // T-2203: Separate input/output schema naming
      const reqComponentName = reqName && separateInputOutputSchemas ? `${reqName}Input` : reqName;

      if (reqComponentName && !seenSchemaNames.has(reqComponentName)) {
        seenSchemaNames.add(reqComponentName);
        componentSchemas[reqComponentName] = reqJsonSchema;
      }

      operation.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: reqComponentName ? { $ref: `#/components/schemas/${reqComponentName}` } : reqJsonSchema,
          },
        },
      };
    }

    // Response
    const statusCode = route.statusCode ?? 200;
    const versionedResponseSchema = getVersionedSchema(route.responseSchema, registry);
    if (versionedResponseSchema) {
      const resJsonSchema = zodToOpenAPISchema(versionedResponseSchema);
      const resName = getSchemaName(route.responseSchema);

      // T-2203: Separate input/output schema naming
      const resComponentName = resName && separateInputOutputSchemas ? `${resName}Output` : resName;

      if (resComponentName && !seenSchemaNames.has(resComponentName)) {
        seenSchemaNames.add(resComponentName);
        componentSchemas[resComponentName] = resJsonSchema;
      }

      operation.responses[String(statusCode)] = {
        description: "Successful response",
        content: {
          "application/json": {
            schema: resComponentName ? { $ref: `#/components/schemas/${resComponentName}` } : resJsonSchema,
          },
        },
      };
    } else {
      operation.responses[String(statusCode)] = {
        description: "Successful response",
      };
    }

    // T-2002: Merge custom responses into the operation
    if (route.responses) {
      for (const [code, responseObj] of Object.entries(route.responses)) {
        operation.responses[code] = {
          ...operation.responses[code],
          ...responseObj,
        };
      }
    }

    // T-2003: Serialize callbacks
    if (route.callbacks && route.callbacks.length > 0) {
      const callbacksObj: Record<string, any> = {};
      for (const cb of route.callbacks) {
        const cbKey = `${cb.method.toUpperCase()} ${cb.path}`;
        callbacksObj[cbKey] = {
          [cb.path]: {
            [cb.method.toLowerCase()]: {
              ...(cb.description ? { description: cb.description } : {}),
              responses: {
                "200": { description: "Callback response" },
              },
            },
          },
        };
      }
      operation.callbacks = callbacksObj;
    }

    // Convert Express-style path params to OpenAPI style
    const openApiPath = route.path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, "{$1}");
    if (!paths[openApiPath]) {
      paths[openApiPath] = {};
    }
    // Remove the Express-style path key if it differs
    if (openApiPath !== route.path) {
      delete paths[route.path];
    }
    paths[openApiPath][method] = operation;
  }

  // Build webhooks section (OpenAPI 3.1 `webhooks` — documentation-only, not HTTP endpoints)
  const webhooks: Record<string, Record<string, any>> = {};
  if (options.webhookRoutes) {
    for (const route of options.webhookRoutes) {
      if (route.includeInSchema === false) continue;
      if (route.tags.includes("_TSADWYN_DELETED_ROUTE")) continue;

      const method = route.method.toLowerCase();
      // Webhook names are the path (without leading slash)
      const webhookName = route.path.replace(/^\/+/, "");

      if (!webhooks[webhookName]) {
        webhooks[webhookName] = {};
      }

      const operation: Record<string, any> = { responses: {} };

      const publicTags = route.tags.filter((t) => !t.startsWith("_TSADWYN"));
      if (publicTags.length > 0) operation.tags = publicTags;
      if (route.deprecated) operation.deprecated = true;
      if (route.operationId) operation.operationId = route.operationId;
      if (route.summary) operation.summary = route.summary;
      if (route.description) operation.description = route.description;

      // Request body (what the webhook sends to the consumer)
      const versionedReqSchema = getVersionedSchema(route.requestSchema, registry);
      if (versionedReqSchema) {
        const reqJsonSchema = zodToOpenAPISchema(versionedReqSchema);
        const reqName = getSchemaName(route.requestSchema);
        const reqComponentName = reqName && separateInputOutputSchemas ? `${reqName}Input` : reqName;

        if (reqComponentName && !seenSchemaNames.has(reqComponentName)) {
          seenSchemaNames.add(reqComponentName);
          componentSchemas[reqComponentName] = reqJsonSchema;
        }

        operation.requestBody = {
          required: true,
          content: {
            "application/json": {
              schema: reqComponentName ? { $ref: `#/components/schemas/${reqComponentName}` } : reqJsonSchema,
            },
          },
        };
      }

      // Response
      const statusCode = route.statusCode ?? 200;
      const versionedResSchema = getVersionedSchema(route.responseSchema, registry);
      if (versionedResSchema) {
        const resJsonSchema = zodToOpenAPISchema(versionedResSchema);
        const resName = getSchemaName(route.responseSchema);
        const resComponentName = resName && separateInputOutputSchemas ? `${resName}Output` : resName;

        if (resComponentName && !seenSchemaNames.has(resComponentName)) {
          seenSchemaNames.add(resComponentName);
          componentSchemas[resComponentName] = resJsonSchema;
        }

        operation.responses[String(statusCode)] = {
          description: "Webhook response",
          content: {
            "application/json": {
              schema: resComponentName ? { $ref: `#/components/schemas/${resComponentName}` } : resJsonSchema,
            },
          },
        };
      } else {
        operation.responses[String(statusCode)] = { description: "Webhook response" };
      }

      webhooks[webhookName][method] = operation;
    }
  }

  // If changelog is enabled and should be included in schema
  if (changelogUrl && includeChangelogUrlInSchema !== false) {
    const openApiChangelogPath = changelogUrl.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, "{$1}");
    paths[openApiChangelogPath] = {
      get: {
        summary: "API Changelog",
        description: "Returns a structured changelog of all API version changes.",
        responses: {
          "200": {
            description: "Changelog response",
            content: {
              "application/json": {
                schema: { type: "object" },
              },
            },
          },
        },
      },
    };
  }

  const doc: OpenAPIDocument = {
    openapi: "3.1.0",
    info: {
      title,
      version: apiVersion,
    },
    paths,
  };

  if (description) {
    doc.info.description = description;
  }

  if (Object.keys(webhooks).length > 0) {
    doc.webhooks = webhooks;
  }

  // T-2004: Add servers array if basePath is provided
  if (basePath) {
    doc.servers = [{ url: basePath }];
  }

  if (Object.keys(componentSchemas).length > 0) {
    doc.components = { schemas: componentSchemas };
  }

  return doc;
}
