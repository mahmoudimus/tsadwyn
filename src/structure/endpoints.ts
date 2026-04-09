/**
 * Instruction that an endpoint didn't exist in the previous version.
 */
export interface EndpointDidntExistInstruction {
  kind: "endpoint_didnt_exist";
  path: string;
  methods: string[];
}

/**
 * Instruction that an endpoint existed in the previous version
 * (i.e., it was restored).
 */
export interface EndpointExistedInstruction {
  kind: "endpoint_existed";
  path: string;
  methods: string[];
}

/**
 * Instruction that an endpoint had different properties in a previous version.
 */
export interface EndpointHadInstruction {
  kind: "endpoint_had";
  path: string;
  methods: string[];
  attributes: Record<string, any>;
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
  ) {}

  get didntExist(): EndpointDidntExistInstruction {
    return {
      kind: "endpoint_didnt_exist",
      path: this.path,
      methods: this.methods,
    };
  }

  get existed(): EndpointExistedInstruction {
    return {
      kind: "endpoint_existed",
      path: this.path,
      methods: this.methods,
    };
  }

  had(attributes: Record<string, any>): EndpointHadInstruction {
    return {
      kind: "endpoint_had",
      path: this.path,
      methods: this.methods,
      attributes,
    };
  }
}

/**
 * Entry point for the endpoint alteration DSL.
 * Usage: `endpoint("/users", ["GET"]).didntExist`
 */
export function endpoint(
  path: string,
  methods: string[],
): EndpointInstructionFactory {
  return new EndpointInstructionFactory(path, methods);
}
