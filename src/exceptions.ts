/**
 * Tsadwyn error hierarchy.
 *
 * All Tsadwyn-specific errors extend TsadwynError (which itself extends Error)
 * so callers can catch the whole family with a single `catch (e) { if (e instanceof TsadwynError) ... }`.
 */

// ── Base ────────────────────────────────────────────────────────────────────

export class TsadwynError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "TsadwynError";
    // Fix prototype chain for instanceof checks when targeting ES5
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── Structure / schema errors ───────────────────────────────────────────────

export class TsadwynStructureError extends TsadwynError {
  constructor(message?: string) {
    super(message);
    this.name = "TsadwynStructureError";
  }
}

// ── Validation errors ───────────────────────────────────────────────────────

/**
 * Raised when the *latest* (head) version's request schema validation fails
 * after migration has been applied. This indicates a bug in the migration code
 * rather than bad user input.
 */
export class TsadwynLatestRequestValidationError extends TsadwynError {
  errors: unknown[];
  body: unknown;
  version: string;

  constructor(errors: unknown[], body: unknown, version: string) {
    super(
      `Request validation failed after migrating to latest from version=${version}. ` +
        "This likely indicates an error in migrations or schema structure.\n" +
        `body=${JSON.stringify(body)}\n\nerrors=${JSON.stringify(errors)}`,
    );
    this.name = "TsadwynLatestRequestValidationError";
    this.errors = errors;
    this.body = body;
    this.version = version;
  }
}

/**
 * Raised when the *head* (versioned) request schema validation fails before
 * migration. This indicates the client sent an invalid request for the
 * requested API version.
 */
export class TsadwynHeadRequestValidationError extends TsadwynError {
  errors: unknown[];
  body: unknown;
  version: string;

  constructor(errors: unknown[], body: unknown, version: string) {
    super(
      `We failed to migrate the request with version=${version}. ` +
        "This means that there is some error in your migrations or schema structure that makes it impossible " +
        "to migrate the request of that version to latest.\n" +
        `body=${JSON.stringify(body)}\n\nerrors=${JSON.stringify(errors)}`,
    );
    this.name = "TsadwynHeadRequestValidationError";
    this.errors = errors;
    this.body = body;
    this.version = version;
  }
}

// ── Linting ─────────────────────────────────────────────────────────────────

export class LintingError extends TsadwynError {
  constructor(message?: string) {
    super(message);
    this.name = "LintingError";
  }
}

// ── Router generation errors ────────────────────────────────────────────────

export class RouterGenerationError extends TsadwynError {
  constructor(message?: string) {
    super(message);
    this.name = "RouterGenerationError";
  }
}

export class RouteAlreadyExistsError extends RouterGenerationError {
  routes: unknown[];

  constructor(...routes: unknown[]) {
    super(`The following routes are duplicates of each other: ${JSON.stringify(routes)}`);
    this.name = "RouteAlreadyExistsError";
    this.routes = routes;
  }
}

export class RouteByPathConverterDoesNotApplyToAnythingError extends RouterGenerationError {
  constructor(message?: string) {
    super(message);
    this.name = "RouteByPathConverterDoesNotApplyToAnythingError";
  }
}

export class RouteRequestBySchemaConverterDoesNotApplyToAnythingError extends RouterGenerationError {
  constructor(message?: string) {
    super(message);
    this.name = "RouteRequestBySchemaConverterDoesNotApplyToAnythingError";
  }
}

export class RouteResponseBySchemaConverterDoesNotApplyToAnythingError extends RouterGenerationError {
  constructor(message?: string) {
    super(message);
    this.name = "RouteResponseBySchemaConverterDoesNotApplyToAnythingError";
  }
}

export class RouterPathParamsModifiedError extends RouterGenerationError {
  constructor(message?: string) {
    super(message);
    this.name = "RouterPathParamsModifiedError";
  }
}

// ── Generation instruction errors ───────────────────────────────────────────

export class InvalidGenerationInstructionError extends TsadwynError {
  constructor(message?: string) {
    super(message);
    this.name = "InvalidGenerationInstructionError";
  }
}

// ── HTTP errors ────────────────────────────────────────────────────────────

/**
 * An HTTP error that can be thrown from route handlers.
 * When thrown, tsadwyn intercepts it, runs response migrations that have
 * `migrateHttpErrors: true`, and sends the (potentially modified) error
 * response with the migrated status code, body, and headers.
 *
 * This mirrors Tsadwyn's HTTPException interception behavior.
 */
export class HttpError extends Error {
  statusCode: number;
  body: any;
  headers: Record<string, string>;

  constructor(statusCode: number, body: any, headers?: Record<string, string>) {
    super(typeof body === "string" ? body : JSON.stringify(body));
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.body = body;
    this.headers = headers ?? {};
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── Module errors ───────────────────────────────────────────────────────────

export class ModuleIsNotVersionedError extends TsadwynError {
  constructor(message?: string) {
    super(message);
    this.name = "ModuleIsNotVersionedError";
  }
}
