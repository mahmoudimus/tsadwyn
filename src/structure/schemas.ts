import { z, ZodTypeAny } from "zod";

// Sentinel value for "not set"
const SENTINEL = Symbol("SENTINEL");
type SentinelType = typeof SENTINEL;

/**
 * Options for what a field "had" in a previous version.
 * `name` means the field was renamed (its old name).
 * `type` means the field had a different Zod type.
 */
export interface FieldHadOptions {
  name?: string;
  type?: ZodTypeAny;
}

/**
 * Represents an instruction that a schema field "had" different properties
 * in the previous version.
 */
export interface FieldHadInstruction {
  kind: "field_had";
  schemaName: string;
  fieldName: string;
  oldName?: string;
  oldType?: ZodTypeAny;
}

/**
 * Represents an instruction that a schema field "didn't exist" in the previous version.
 */
export interface FieldDidntExistInstruction {
  kind: "field_didnt_exist";
  schemaName: string;
  fieldName: string;
}

/**
 * Factory for creating field alteration instructions.
 */
export class AlterFieldInstructionFactory {
  constructor(
    public readonly schemaName: string,
    public readonly fieldName: string,
  ) {}

  /**
   * Declares that this field "had" different properties in the previous version.
   * For example, it had a different name, different type, or both.
   */
  had(options: FieldHadOptions): FieldHadInstruction {
    return {
      kind: "field_had",
      schemaName: this.schemaName,
      fieldName: this.fieldName,
      oldName: options.name,
      oldType: options.type,
    };
  }

  /**
   * Declares that this field didn't exist in the previous version.
   */
  get didntExist(): FieldDidntExistInstruction {
    return {
      kind: "field_didnt_exist",
      schemaName: this.schemaName,
      fieldName: this.fieldName,
    };
  }
}

/**
 * Factory for creating schema alteration instructions.
 */
export class AlterSchemaInstructionFactory {
  constructor(public readonly schemaName: string) {}

  /**
   * Target a specific field for alteration.
   */
  field(name: string): AlterFieldInstructionFactory {
    return new AlterFieldInstructionFactory(this.schemaName, name);
  }
}

export type AlterSchemaSubInstruction =
  | FieldHadInstruction
  | FieldDidntExistInstruction;

/**
 * Entry point for the schema alteration DSL.
 * Usage: `schema(MyZodSchema).field("name").had({ name: "oldName", type: z.string() })`
 */
export function schema(
  zodSchema: ZodTypeAny & { _tsadwynName?: string },
): AlterSchemaInstructionFactory {
  const name = zodSchema._tsadwynName;
  if (!name) {
    throw new Error(
      "Schema must have a name. Use `.named('SchemaName')` on the Zod schema.",
    );
  }
  return new AlterSchemaInstructionFactory(name);
}
