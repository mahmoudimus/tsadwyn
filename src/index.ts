// Ensure Zod is extended with .named() before anything else
import "./zod-extend.js";
export { getSchemaName, setSchemaName, named } from "./zod-extend.js";

// Public API surface for tsadwyn
export { Tsadwyn } from "./application.js";
export type { TsadwynOptions } from "./application.js";

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
  TsadwynError,
  TsadwynStructureError,
  TsadwynLatestRequestValidationError,
  TsadwynHeadRequestValidationError,
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
export { RootTsadwynRouter } from "./routing.js";
export type { RootTsadwynRouterOptions } from "./routing.js";

// Dependency context (T-1304)
export {
  currentDependencySolver,
  currentDependencySolverStorage,
  type DependencySolverOption,
} from "./dependencies.js";

// T-1701: Standalone response migration utility
export { migrateResponseBody } from "./migrate.js";

// Per-client default version resolver (pairs with preVersionPick)
export { perClientDefaultVersion } from "./per-client-default.js";
export type { PerClientDefaultVersionOptions } from "./per-client-default.js";

// Behavior-map helper for per-version behavior branching in handlers
export { buildBehaviorResolver } from "./behavior-resolver.js";
export type { BuildBehaviorResolverOptions } from "./behavior-resolver.js";

// Canonical upgrade-policy helper for /versioning/upgrade endpoints
export { validateVersionUpgrade } from "./version-upgrade.js";
export type {
  ValidateVersionUpgradeArgs,
  ValidateVersionUpgradeResult,
  CompareFn,
} from "./version-upgrade.js";

// Pre-wired RESTful /versioning resource (GET + POST with optimistic
// concurrency) built on top of validateVersionUpgrade.
export { createVersioningRoutes } from "./versioning-routes.js";
export type { CreateVersioningRoutesOptions } from "./versioning-routes.js";

// Declarative exception→HttpError helper (pairs with errorMapper option)
export { exceptionMap, isExceptionMapFn } from "./exception-map.js";
export type {
  ExceptionMapConfig,
  ExceptionMapEntry,
  ExceptionMapFn,
  ExceptionMapping,
} from "./exception-map.js";

// Outbound payload migration (webhooks, internal events)
export { migratePayloadToVersion } from "./migrate-payload.js";

// Stripe-style deleted-resource response helper
export { deletedResponseSchema } from "./delete-response.js";

// Raw / binary / streaming response marker
export { raw, isRawResponse, RAW_RESPONSE_MARKER } from "./raw-response.js";
export type { RawResponseOptions, RawResponseMarker } from "./raw-response.js";

// Debugging / introspection trio: routes / migrations / simulation
export { dumpRouteTable } from "./route-table.js";
export type {
  DumpRouteTableOptions,
  RouteTableEntry,
} from "./route-table.js";

export { inspectMigrationChain } from "./migration-chain.js";
export type {
  InspectMigrationChainOptions,
  MigrationChainEntry,
} from "./migration-chain.js";

export { simulateRoute } from "./route-simulation.js";
export type {
  SimulateRouteOptions,
  SimulationResult,
  MatchedRouteSummary,
  RouteCandidate,
  FallthroughSummary,
  MigrationSummary,
} from "./route-simulation.js";

// T-1300 and T-1301: AST analysis and custom module loading
// These features are N/A in the TypeScript version. In the Python Tsadwyn library,
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
