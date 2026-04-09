// Ensure Zod is extended with .named() before anything else
import "./zod-extend.js";
export { getSchemaName, setSchemaName } from "./zod-extend.js";

// Public API surface for tsadwyn
export { Cadwyn } from "./application.js";
export type { CadwynOptions } from "./application.js";

export {
  HeadVersion,
  Version,
  VersionBundle,
  VersionChange,
  VersionChangeWithSideEffects,
} from "./structure/versions.js";

export {
  schema,
  hidden,
  namedRefine,
  namedComputedField,
} from "./structure/schemas.js";
export type { NamedComputedField } from "./structure/schemas.js";

export {
  endpoint,
} from "./structure/endpoints.js";

export {
  enum_,
  enumeration,
} from "./structure/enums.js";

export {
  RequestInfo,
  ResponseInfo,
  convertRequestToNextVersionFor,
  convertResponseToPreviousVersionFor,
} from "./structure/data.js";

export { VersionedRouter } from "./router.js";
export type { RouteDefinition, TypedRequest, RouteOptions, VersionedRouterOptions, MiddlewareFunction } from "./router.js";

export {
  versionPickingMiddleware,
  apiVersionStorage,
  type APIVersionLocation,
  type APIVersionFormat,
  type VersionPickingOptions,
} from "./middleware.js";
export { generateVersionedRouters } from "./route-generation.js";
export type { VersionedRouterResult } from "./route-generation.js";
export { ZodSchemaRegistry, generateVersionedSchemas, transformSchemaReferences } from "./schema-generation.js";

export {
  CadwynError,
  CadwynStructureError,
  CadwynLatestRequestValidationError,
  CadwynHeadRequestValidationError,
  LintingError,
  RouterGenerationError,
  RouteAlreadyExistsError,
  RouteByPathConverterDoesNotApplyToAnythingError,
  RouteRequestBySchemaConverterDoesNotApplyToAnythingError,
  RouteResponseBySchemaConverterDoesNotApplyToAnythingError,
  RouterPathParamsModifiedError,
  InvalidGenerationInstructionError,
  ModuleIsNotVersionedError,
  HttpError,
} from "./exceptions.js";

// OpenAPI
export { buildOpenAPIDocument } from "./openapi.js";
export type { OpenAPIDocument, OpenAPIBuildOptions } from "./openapi.js";

// Changelog
export { generateChangelog } from "./changelog.js";
export type {
  ChangelogResource,
  ChangelogVersion,
  ChangelogVersionChange,
  ChangelogInstruction,
  ChangelogAttributeChange,
  ChangelogEndpointAttributeChange,
} from "./changelog.js";

// Docs HTML renderers
export { renderDocsDashboard, renderSwaggerUI, renderRedocUI, DEFAULT_ASSET_URLS } from "./docs.js";
export type { DocsAssetUrls } from "./docs.js";

// Internal routing module (T-1303)
export { RootCadwynRouter } from "./routing.js";
export type { RootCadwynRouterOptions } from "./routing.js";

// Dependency context (T-1304)
export {
  currentDependencySolver,
  currentDependencySolverStorage,
  type DependencySolverOption,
} from "./dependencies.js";

// T-1701: Standalone response migration utility
export { migrateResponseBody } from "./migrate.js";

// T-1300 and T-1301: AST analysis and custom module loading
// These features are N/A in the TypeScript version. In the Python Cadwyn library,
// T-1300 (AST analysis) uses Python's ast module to analyze and render versioned
// Pydantic models as source code. T-1301 (custom module loading) uses importlib
// to intercept module imports and replace schemas with versioned copies at import time.
// Neither of these patterns applies to the TypeScript/Zod ecosystem, where schemas
// are runtime objects and there is no equivalent need for source-code rendering or
// import-time interception.

// T-1803: ClassVar field handling
// In Python, `ClassVar` fields are class-level attributes that don't participate in
// validation or serialization. In Zod/TypeScript, there is no equivalent concept --
// Zod schemas define validation shapes, and class-level constants are simply regular
// TypeScript constants or static class properties outside the schema. Therefore,
// ClassVar handling is N/A in the TypeScript port and no implementation is needed.
