import type { HiddenFromChangelogMixin } from "./schemas.js";

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);

/**
 * Validate that the given strings are valid HTTP methods.
 */
function _validateHttpMethods(methods: string[]): void {
  const invalid = methods.filter((m) => !HTTP_METHODS.has(m.toUpperCase()));
  if (invalid.length > 0) {
    throw new Error(
      `The following HTTP methods are not valid: ${invalid.sort().join(", ")}. ` +
      "Please use valid HTTP methods such as GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD.",
    );
  }
}

/**
 * Attributes that an endpoint "had" in a previous version.
 * Each field is optional; only set fields are applied.
 */
export interface EndpointHadAttributes {
  path?: string;
  methods?: string[];
  statusCode?: number;
  deprecated?: boolean;
  summary?: string;
  description?: string;
  tags?: string[];
  operationId?: string;
  /** T-2001: Whether to include this route in the OpenAPI schema. */
  includeInSchema?: boolean;
  /** T-2002: Custom responses dict for OpenAPI. */
  responses?: Record<string, any>;
  /** T-2003: Callbacks for OpenAPI. */
  callbacks?: Array<{ path: string; method: string; description?: string }>;
}

/**
 * Instruction that an endpoint didn't exist in the previous version.
 */
export interface EndpointDidntExistInstruction extends HiddenFromChangelogMixin {
  kind: "endpoint_didnt_exist";
  path: string;
  methods: string[];
  funcName: string | null;
}

/**
 * Instruction that an endpoint existed in the previous version
 * (i.e., it was restored).
 */
export interface EndpointExistedInstruction extends HiddenFromChangelogMixin {
  kind: "endpoint_existed";
  path: string;
  methods: string[];
  funcName: string | null;
}

/**
 * Instruction that an endpoint had different properties in a previous version.
 */
export interface EndpointHadInstruction extends HiddenFromChangelogMixin {
  kind: "endpoint_had";
  path: string;
  methods: string[];
  funcName: string | null;
  attributes: EndpointHadAttributes;
}

export type AlterEndpointSubInstruction =
  | EndpointDidntExistInstruction
  | EndpointExistedInstruction
  | EndpointHadInstruction;

/**
 * Factory for creating endpoint alteration instructions.
 */
export class EndpointInstructionFactory {
  constructor(
    public readonly path: string,
    public readonly methods: string[],
    public readonly funcName: string | null = null,
  ) {}

  get didntExist(): EndpointDidntExistInstruction {
    return {
      kind: "endpoint_didnt_exist",
      path: this.path,
      methods: this.methods,
      funcName: this.funcName,
      isHiddenFromChangelog: false,
    };
  }

  get existed(): EndpointExistedInstruction {
    return {
      kind: "endpoint_existed",
      path: this.path,
      methods: this.methods,
      funcName: this.funcName,
      isHiddenFromChangelog: false,
    };
  }

  had(attributes: EndpointHadAttributes): EndpointHadInstruction {
    return {
      kind: "endpoint_had",
      path: this.path,
      methods: this.methods,
      funcName: this.funcName,
      attributes,
      isHiddenFromChangelog: false,
    };
  }
}

/**
 * Entry point for the endpoint alteration DSL.
 * Usage: `endpoint("/users", ["GET"]).didntExist`
 *        `endpoint("/users", ["GET"], "myFuncName").had({ path: "/old-users" })`
 */
export function endpoint(
  path: string,
  methods: string[],
  funcName?: string,
): EndpointInstructionFactory {
  _validateHttpMethods(methods);
  return new EndpointInstructionFactory(path, methods, funcName ?? null);
}
