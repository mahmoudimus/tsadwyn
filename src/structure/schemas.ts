import { z, ZodTypeAny, ZodString, ZodNumber, ZodBigInt, ZodArray, ZodEffects } from "zod";
import { getSchemaName as _getSchemaName } from "../zod-extend.js";

/**
 * Options for what a field "had" in a previous version.
 * `name` means the field was renamed (its old name).
 * `type` means the field had a different Zod type.
 * Additional constraint options allow changing field-level Zod constraints.
 */
export interface FieldHadOptions {
  name?: string;
  type?: ZodTypeAny;
  default?: unknown;
  optional?: boolean;
  nullable?: boolean;
  description?: string;
  min?: number;
  minLength?: number;
  max?: number;
  maxLength?: number;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  regex?: RegExp;
  pattern?: RegExp;
  multipleOf?: number;
  int?: boolean;

  // T-1800: Additional Zod-mappable attributes ported from Python Tsadwyn
  /**
   * Title metadata. Stored as custom metadata on the Zod schema.
   * In JSON Schema output, this maps to the "title" field.
   */
  title?: string;
  /**
   * Example values. Stored as custom metadata on the Zod schema.
   * In JSON Schema output, this maps to the "examples" field.
   */
  examples?: unknown[];
  /**
   * Discriminator key for z.discriminatedUnion.
   * Stores the discriminator key as metadata.
   */
  discriminator?: string;
  /**
   * Extra JSON Schema properties. Stored as custom metadata on the Zod schema.
   * In JSON Schema output, these are merged into the schema.
   */
  json_schema_extra?: Record<string, unknown>;

  // ────────────────────────────────────────────────────────────────────────
  // Pydantic-specific attributes that have NO Zod equivalent (N/A).
  // These are documented here for completeness and to match the Python
  // Tsadwyn API surface. They are accepted but ignored at schema-generation
  // time because Zod does not have equivalent concepts.
  // ────────────────────────────────────────────────────────────────────────

  /** N/A: Zod uses field names directly; there is no alias concept. */
  alias?: string;
  /** N/A: Zod uses field names directly. */
  alias_priority?: number;
  /** N/A: Zod uses field names directly. */
  validation_alias?: string;
  /** N/A: Zod uses field names directly. */
  serialization_alias?: string;
  /** N/A: Pydantic-specific field title generator callback. */
  field_title_generator?: unknown;
  /** N/A: Pydantic v1 const field concept; Zod uses z.literal() instead. */
  const?: boolean;
  /** N/A: Pydantic frozen/immutable field concept. */
  frozen?: boolean;
  /** N/A: Pydantic validate_default concept. */
  validate_default?: boolean;
  /** N/A: Pydantic repr flag for __repr__. */
  repr?: boolean;
  /** N/A: Pydantic dataclass init flag. */
  init?: boolean;
  /** N/A: Pydantic dataclass init_var flag. */
  init_var?: boolean;
  /** N/A: Pydantic dataclass kw_only flag. */
  kw_only?: boolean;
  /** N/A: Pydantic fail_fast validation flag. */
  fail_fast?: boolean;
  /** N/A: Numeric precision beyond Zod's constraints (allow_inf_nan). */
  allow_inf_nan?: boolean;
  /** N/A: Numeric precision beyond Zod's constraints (max_digits). */
  max_digits?: number;
  /** N/A: Numeric precision beyond Zod's constraints (decimal_places). */
  decimal_places?: number;
  /** N/A: Pydantic union_mode concept. */
  union_mode?: string;
  /** N/A: Pydantic v1 allow_mutation concept. */
  allow_mutation?: boolean;
}

/**
 * Mixin interface for all instructions that can be hidden from changelog.
 */
export interface HiddenFromChangelogMixin {
  isHiddenFromChangelog: boolean;
}

/**
 * Represents an instruction that a schema field "had" different properties
 * in the previous version.
 */
export interface FieldHadInstruction extends HiddenFromChangelogMixin {
  kind: "field_had";
  schemaName: string;
  fieldName: string;
  oldName?: string;
  oldType?: ZodTypeAny;
  // Constraint changes
  default?: unknown;
  hasDefault?: boolean; // true when `default` was explicitly set (even to undefined)
  optional?: boolean;
  nullable?: boolean;
  description?: string;
  min?: number;
  minLength?: number;
  max?: number;
  maxLength?: number;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  regex?: RegExp;
  pattern?: RegExp;
  multipleOf?: number;
  int?: boolean;
  // T-1800: Additional Zod-mappable attributes
  title?: string;
  examples?: unknown[];
  discriminator?: string;
  json_schema_extra?: Record<string, unknown>;
}

/**
 * Represents an instruction that a schema field "didn't exist" in the previous version.
 */
export interface FieldDidntExistInstruction extends HiddenFromChangelogMixin {
  kind: "field_didnt_exist";
  schemaName: string;
  fieldName: string;
}

/**
 * Represents an instruction that a schema field "existed as" a specific type
 * in a previous version (i.e. it was added in a newer version, so it existed before).
 */
export interface FieldExistedAsInstruction extends HiddenFromChangelogMixin {
  kind: "field_existed_as";
  schemaName: string;
  fieldName: string;
  type: ZodTypeAny;
}

/**
 * Options for existedAs instruction.
 */
export interface FieldExistedAsOptions {
  type: ZodTypeAny;
}

/**
 * Represents an instruction that a schema field "didn't have" certain constraints
 * in a previous version (i.e. they were added in a newer version).
 */
export interface FieldDidntHaveInstruction extends HiddenFromChangelogMixin {
  kind: "field_didnt_have";
  schemaName: string;
  fieldName: string;
  attributes: string[];
}

/**
 * Valid constraint names that can be used with didntHave().
 */
export type PossibleFieldConstraint =
  | "min"
  | "max"
  | "minLength"
  | "maxLength"
  | "regex"
  | "pattern"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "int"
  | "multipleOf"
  | "default"
  | "optional"
  | "nullable"
  | "description"
  // T-1800/T-1801: Additional Zod-mappable constraints
  | "title"
  | "examples"
  | "discriminator"
  | "json_schema_extra";

const VALID_CONSTRAINTS: Set<string> = new Set([
  "min", "max", "minLength", "maxLength", "regex", "pattern",
  "gt", "gte", "lt", "lte", "int", "multipleOf",
  "default", "optional", "nullable", "description",
  // T-1800/T-1801: Additional Zod-mappable constraints
  "title", "examples", "discriminator", "json_schema_extra",
]);

/**
 * Represents an instruction that a schema "had" different properties (e.g., a different name).
 */
export interface SchemaHadInstruction extends HiddenFromChangelogMixin {
  kind: "schema_had";
  schemaName: string;
  oldSchemaName: string;
}

/**
 * Represents an instruction that a named validator "existed" in a previous version
 * (i.e. it was removed in a newer version, so we re-add it for older versions).
 */
export interface ValidatorExistedInstruction extends HiddenFromChangelogMixin {
  kind: "validator_existed";
  schemaName: string;
  validatorName: string;
  validatorFn: (value: any) => boolean;
  message?: string;
}

/**
 * Represents an instruction that a named validator "didn't exist" in a previous version
 * (i.e. it was added in a newer version, so we remove it for older versions).
 */
export interface ValidatorDidntExistInstruction extends HiddenFromChangelogMixin {
  kind: "validator_didnt_exist";
  schemaName: string;
  validatorName: string;
}

/**
 * Factory for creating validator alteration instructions.
 */
export class AlterValidatorInstructionFactory {
  constructor(
    public readonly schemaName: string,
    public readonly validatorName: string,
    public readonly validatorFn?: (value: any) => boolean,
    public readonly validatorMessage?: string,
  ) {}

  /**
   * Declares that this validator existed in the previous version.
   * The validator function must have been provided via namedRefine.
   */
  get existed(): ValidatorExistedInstruction {
    if (!this.validatorFn) {
      throw new Error(
        `Cannot use .existed on validator "${this.validatorName}" without a function. ` +
        "Use namedRefine() to create a named refinement that can be re-added.",
      );
    }
    return {
      kind: "validator_existed",
      schemaName: this.schemaName,
      validatorName: this.validatorName,
      validatorFn: this.validatorFn,
      message: this.validatorMessage,
      isHiddenFromChangelog: false,
    };
  }

  /**
   * Declares that this validator didn't exist in the previous version.
   */
  get didntExist(): ValidatorDidntExistInstruction {
    return {
      kind: "validator_didnt_exist",
      schemaName: this.schemaName,
      validatorName: this.validatorName,
      isHiddenFromChangelog: false,
    };
  }
}

/**
 * Represents a named refinement attached to a Zod schema.
 */
export interface NamedRefinement {
  name: string;
  fn: (value: any) => boolean;
  message?: string;
}

/**
 * Creates a named refinement that can be referenced in versioning instructions.
 * The refinement is applied to the schema and its name is stored for later lookup.
 *
 * Usage:
 * ```ts
 * const MySchema = namedRefine(
 *   z.object({ ... }),
 *   "myValidation",
 *   (val) => val.age >= 18,
 *   "Must be 18 or older"
 * );
 * ```
 */
export function namedRefine<T extends ZodTypeAny>(
  schema: T,
  name: string,
  fn: (value: any) => boolean,
  message?: string,
): ZodEffects<T> {
  const refined = schema.refine(fn, message ? { message } : undefined);
  // Attach the named refinement info to the schema
  if (!(refined as any)._tsadwynNamedRefinements) {
    (refined as any)._tsadwynNamedRefinements = [];
  }
  (refined as any)._tsadwynNamedRefinements.push({ name, fn, message });
  // Also copy over any existing named refinements from the inner schema
  if ((schema as any)._tsadwynNamedRefinements) {
    for (const ref of (schema as any)._tsadwynNamedRefinements) {
      if (!((refined as any)._tsadwynNamedRefinements as NamedRefinement[]).some(r => r.name === ref.name)) {
        (refined as any)._tsadwynNamedRefinements.push(ref);
      }
    }
  }
  return refined;
}

/**
 * T-1802: Represents a named computed field attached to a Zod schema.
 * Computed fields are added via .transform() at generation time and
 * can be referenced in versioning instructions.
 */
export interface NamedComputedField {
  name: string;
  compute: (data: any) => any;
}

/**
 * T-1802: Creates a named computed field definition that can be referenced
 * in versioning instructions. The computed field adds a property to the
 * output shape via .transform().
 *
 * Usage:
 * ```ts
 * const fullNameField = namedComputedField("fullName", (data) => `${data.firstName} ${data.lastName}`);
 * ```
 */
export function namedComputedField(name: string, compute: (data: any) => any): NamedComputedField {
  return { name, compute };
}

/**
 * T-1802: Instruction that a computed field existed in a previous version.
 */
export interface ComputedFieldExistedInstruction extends HiddenFromChangelogMixin {
  kind: "computed_field_existed";
  schemaName: string;
  fieldName: string;
  compute: (data: any) => any;
}

/**
 * T-1802: Instruction that a computed field didn't exist in a previous version.
 */
export interface ComputedFieldDidntExistInstruction extends HiddenFromChangelogMixin {
  kind: "computed_field_didnt_exist";
  schemaName: string;
  fieldName: string;
}

/**
 * T-1802: Factory for creating computed field alteration instructions.
 */
export class AlterComputedFieldInstructionFactory {
  constructor(
    public readonly schemaName: string,
    public readonly fieldName: string,
    public readonly computeFn?: (data: any) => any,
  ) {}

  /**
   * Declares that this computed field existed in the previous version.
   * The compute function must have been provided via namedComputedField.
   */
  get existed(): ComputedFieldExistedInstruction {
    if (!this.computeFn) {
      throw new Error(
        `Cannot use .existed on computed field "${this.fieldName}" without a compute function. ` +
        "Use namedComputedField() to create a named computed field that can be re-added.",
      );
    }
    return {
      kind: "computed_field_existed",
      schemaName: this.schemaName,
      fieldName: this.fieldName,
      compute: this.computeFn,
      isHiddenFromChangelog: false,
    };
  }

  /**
   * Declares that this computed field didn't exist in the previous version.
   */
  get didntExist(): ComputedFieldDidntExistInstruction {
    return {
      kind: "computed_field_didnt_exist",
      schemaName: this.schemaName,
      fieldName: this.fieldName,
      isHiddenFromChangelog: false,
    };
  }
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
    const instruction: FieldHadInstruction = {
      kind: "field_had",
      schemaName: this.schemaName,
      fieldName: this.fieldName,
      oldName: options.name,
      oldType: options.type,
      isHiddenFromChangelog: false,
    };

    // T-104: Support all FieldHadInstruction constraint attributes
    if ("default" in options) {
      instruction.default = options.default;
      instruction.hasDefault = true;
    }
    if (options.optional !== undefined) instruction.optional = options.optional;
    if (options.nullable !== undefined) instruction.nullable = options.nullable;
    if (options.description !== undefined) instruction.description = options.description;
    if (options.min !== undefined) instruction.min = options.min;
    if (options.minLength !== undefined) instruction.minLength = options.minLength;
    if (options.max !== undefined) instruction.max = options.max;
    if (options.maxLength !== undefined) instruction.maxLength = options.maxLength;
    if (options.gt !== undefined) instruction.gt = options.gt;
    if (options.gte !== undefined) instruction.gte = options.gte;
    if (options.lt !== undefined) instruction.lt = options.lt;
    if (options.lte !== undefined) instruction.lte = options.lte;
    if (options.regex !== undefined) instruction.regex = options.regex;
    if (options.pattern !== undefined) instruction.pattern = options.pattern;
    if (options.multipleOf !== undefined) instruction.multipleOf = options.multipleOf;
    if (options.int !== undefined) instruction.int = options.int;

    // T-1800: Additional Zod-mappable attributes
    if (options.title !== undefined) instruction.title = options.title;
    if (options.examples !== undefined) instruction.examples = options.examples;
    if (options.discriminator !== undefined) instruction.discriminator = options.discriminator;
    if (options.json_schema_extra !== undefined) instruction.json_schema_extra = options.json_schema_extra;

    // N/A Pydantic-specific attributes are intentionally ignored at runtime.
    // They are accepted by the FieldHadOptions interface for API compatibility
    // with Python Tsadwyn but have no effect on Zod schemas.

    return instruction;
  }

  /**
   * Declares that this field didn't exist in the previous version.
   */
  get didntExist(): FieldDidntExistInstruction {
    return {
      kind: "field_didnt_exist",
      schemaName: this.schemaName,
      fieldName: this.fieldName,
      isHiddenFromChangelog: false,
    };
  }

  /**
   * Declares that this field existed in the previous version with a specific type.
   * Used when a field was removed in a newer version.
   */
  existedAs(options: FieldExistedAsOptions): FieldExistedAsInstruction {
    return {
      kind: "field_existed_as",
      schemaName: this.schemaName,
      fieldName: this.fieldName,
      type: options.type,
      isHiddenFromChangelog: false,
    };
  }

  /**
   * Declares that this field didn't have specific constraints in the previous version.
   * The constraints will be stripped from the field schema in older versions.
   */
  didntHave(...attributes: PossibleFieldConstraint[]): FieldDidntHaveInstruction {
    for (const attr of attributes) {
      if (!VALID_CONSTRAINTS.has(attr)) {
        throw new Error(
          `Unknown constraint "${attr}". Valid constraints are: ${[...VALID_CONSTRAINTS].join(", ")}`,
        );
      }
    }
    return {
      kind: "field_didnt_have",
      schemaName: this.schemaName,
      fieldName: this.fieldName,
      attributes,
      isHiddenFromChangelog: false,
    };
  }
}

/**
 * Factory for creating schema alteration instructions.
 */
export class AlterSchemaInstructionFactory {
  /** The original Zod schema object, stored for registry discovery. */
  readonly _zodSchema: ZodTypeAny;

  /**
   * T-2400: Global map of schema names to their Zod schema objects,
   * populated each time `schema()` is called. Used by route generation
   * to discover schemas referenced in instructions but not directly on routes.
   */
  static readonly _knownSchemas: Map<string, ZodTypeAny> = new Map();

  constructor(public readonly schemaName: string, zodSchema: ZodTypeAny) {
    this._zodSchema = zodSchema;
    AlterSchemaInstructionFactory._knownSchemas.set(schemaName, zodSchema);
  }

  /**
   * Target a specific field for alteration.
   */
  field(name: string): AlterFieldInstructionFactory {
    return new AlterFieldInstructionFactory(this.schemaName, name);
  }

  /**
   * Target a named validator for alteration.
   * The validatorName should match the name passed to namedRefine().
   */
  validator(validatorName: string): AlterValidatorInstructionFactory;
  /**
   * Target a named refinement object (created by namedRefine) for alteration.
   */
  validator(namedRefinementInfo: NamedRefinement): AlterValidatorInstructionFactory;
  validator(nameOrInfo: string | NamedRefinement): AlterValidatorInstructionFactory {
    if (typeof nameOrInfo === "string") {
      return new AlterValidatorInstructionFactory(this.schemaName, nameOrInfo);
    }
    return new AlterValidatorInstructionFactory(
      this.schemaName,
      nameOrInfo.name,
      nameOrInfo.fn,
      nameOrInfo.message,
    );
  }

  /**
   * T-1802: Target a computed field for alteration.
   * Can be called with a field name string or a NamedComputedField object.
   */
  computedField(fieldName: string): AlterComputedFieldInstructionFactory;
  computedField(namedField: NamedComputedField): AlterComputedFieldInstructionFactory;
  computedField(nameOrField: string | NamedComputedField): AlterComputedFieldInstructionFactory {
    if (typeof nameOrField === "string") {
      return new AlterComputedFieldInstructionFactory(this.schemaName, nameOrField);
    }
    return new AlterComputedFieldInstructionFactory(
      this.schemaName,
      nameOrField.name,
      nameOrField.compute,
    );
  }

  /**
   * Declares that the schema "had" different properties in a previous version.
   * Currently supports renaming: `schema(MySchema).had({ name: "OldName" })`.
   */
  had(options: { name: string }): SchemaHadInstruction {
    return {
      kind: "schema_had",
      schemaName: this.schemaName,
      oldSchemaName: options.name,
      isHiddenFromChangelog: false,
    };
  }
}

export type AlterSchemaSubInstruction =
  | FieldHadInstruction
  | FieldDidntExistInstruction
  | FieldExistedAsInstruction
  | FieldDidntHaveInstruction
  | SchemaHadInstruction
  | ValidatorExistedInstruction
  | ValidatorDidntExistInstruction
  | ComputedFieldExistedInstruction
  | ComputedFieldDidntExistInstruction;

/**
 * Takes an instruction or VersionChange class constructor and marks it as hidden from the changelog.
 *
 * When passed an instruction object, returns a copy with isHiddenFromChangelog set to true.
 * When passed a VersionChange class constructor, sets isHiddenFromChangelog on its prototype
 * so all instances of that class are hidden from the changelog.
 *
 * Usage:
 *   hidden(schema(MySchema).field("name").had({ name: "oldName" }))  // hide single instruction
 *   hidden(MyVersionChange)  // hide entire version change class
 */
export function hidden<T extends HiddenFromChangelogMixin>(instruction: T): T;
export function hidden<T extends { new(...args: any[]): any }>(ChangeClass: T): T;
export function hidden(instructionOrChangeClass: any): any {
  // Check if it's a class constructor (function with a prototype that has isHiddenFromChangelog)
  if (
    typeof instructionOrChangeClass === "function" &&
    instructionOrChangeClass.prototype &&
    "isHiddenFromChangelog" in instructionOrChangeClass.prototype
  ) {
    // It's a VersionChange class constructor - set the property on the prototype
    instructionOrChangeClass.prototype.isHiddenFromChangelog = true;
    return instructionOrChangeClass;
  }
  // It's an instruction object
  return { ...instructionOrChangeClass, isHiddenFromChangelog: true };
}

/**
 * Entry point for the schema alteration DSL.
 * Usage: `schema(MyZodSchema).field("name").had({ name: "oldName", type: z.string() })`
 */
export function schema(
  zodSchema: ZodTypeAny,
): AlterSchemaInstructionFactory {
  const name = _getSchemaName(zodSchema);
  if (!name) {
    throw new Error(
      "Schema must have a name. Use `.named('SchemaName')` on the Zod schema.",
    );
  }
  return new AlterSchemaInstructionFactory(name, zodSchema);
}
