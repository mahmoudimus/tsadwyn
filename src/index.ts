// Ensure Zod is extended with .named() before anything else
import "./zod-extend.js";

// Public API surface for tsadwyn
export { Cadwyn } from "./application.js";
export type { CadwynOptions } from "./application.js";

export {
  Version,
  VersionBundle,
  VersionChange,
} from "./structure/versions.js";

export {
  schema,
} from "./structure/schemas.js";

export {
  endpoint,
} from "./structure/endpoints.js";

export {
  RequestInfo,
  ResponseInfo,
  convertRequestToNextVersionFor,
  convertResponseToPreviousVersionFor,
} from "./structure/data.js";

export { VersionedRouter } from "./router.js";
export type { RouteDefinition } from "./router.js";

export { versionPickingMiddleware, apiVersionStorage } from "./middleware.js";
export { generateVersionedRouters } from "./route-generation.js";
export { ZodSchemaRegistry, generateVersionedSchemas } from "./schema-generation.js";
