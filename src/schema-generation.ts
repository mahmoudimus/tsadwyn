import {
  z,
  ZodObject,
  ZodTypeAny,
  ZodRawShape,
  ZodString,
  ZodNumber,
  ZodBigInt,
  ZodArray,
  ZodOptional,
  ZodNullable,
  ZodDefault,
  ZodEffects,
  ZodEnum,
  ZodNativeEnum,
  ZodUnion,
  ZodDiscriminatedUnion,
  ZodIntersection,
  ZodTuple,
  ZodRecord,
  ZodMap,
  ZodSet,
  ZodLazy,
  ZodPipeline,
} from "zod";
import type {
  AlterSchemaSubInstruction,
  FieldHadInstruction,
  FieldDidntExistInstruction,
  FieldExistedAsInstruction,
  FieldDidntHaveInstruction,
  SchemaHadInstruction,
  ValidatorExistedInstruction,
  ValidatorDidntExistInstruction,
  NamedRefinement,
  ComputedFieldExistedInstruction,
  ComputedFieldDidntExistInstruction,
  NamedComputedField,
} from "./structure/schemas.js";
import type {
  AlterEnumSubInstruction,
  EnumHadMembersInstruction,
  EnumDidntHaveMembersInstruction,
} from "./structure/enums.js";
import { InvalidGenerationInstructionError } from "./exceptions.js";
import type { VersionBundle } from "./structure/versions.js";
import { setSchemaName } from "./zod-extend.js";

/**
 * A named Zod schema entry in the registry.
 */
export interface NamedSchema {
  name: string;
  schema: ZodTypeAny;
  shape: Record<string, ZodTypeAny>;
  /** Named refinements attached to this schema */
  namedRefinements: NamedRefinement[];
  /** T-1802: Named computed fields attached to this schema */
  computedFields: NamedComputedField[];
}

/**
 * A named Zod enum entry in the registry.
 * Members maps member name to member value (for Zod enums, name === value typically).
 */
export interface NamedEnum {
  name: string;
  schema: ZodEnum<any> | ZodNativeEnum<any>;
  members: Record<string, string>;
}

/**
 * Registry that maps schema names to their Zod definitions.
 * Used for generating versioned copies of schemas.
 */
export class ZodSchemaRegistry {
  private schemas: Map<string, NamedSchema> = new Map();
  private enums: Map<string, NamedEnum> = new Map();

  register(name: string, schema: ZodTypeAny): void {
    // Extract named refinements from the schema if present
    const namedRefinements: NamedRefinement[] = (schema as any)._tsadwynNamedRefinements
      ? [...(schema as any)._tsadwynNamedRefinements]
      : [];

    // T-1802: Extract named computed fields from the schema if present
    const computedFields: NamedComputedField[] = (schema as any)._tsadwynComputedFields
      ? [...(schema as any)._tsadwynComputedFields]
      : [];

    if (schema instanceof ZodObject) {
      this.schemas.set(name, {
        name,
        schema,
        shape: { ...(schema as ZodObject<any>).shape },
        namedRefinements,
        computedFields,
      });
    } else {
      this.schemas.set(name, { name, schema, shape: {}, namedRefinements, computedFields });
    }
  }

  /**
   * Register a named Zod enum schema.
   */
  registerEnum(name: string, schema: ZodEnum<any> | ZodNativeEnum<any>): void {
    const members: Record<string, string> = {};
    if (schema instanceof ZodEnum) {
      for (const val of schema.options) {
        members[val] = val;
      }
    } else if (schema instanceof ZodNativeEnum) {
      const enumObj = schema.enum;
      for (const key of Object.keys(enumObj)) {
        // Skip reverse mappings in numeric enums
        if (typeof enumObj[enumObj[key]] !== "number") {
          members[key] = enumObj[key];
        }
      }
    }
    this.enums.set(name, { name, schema, members });
  }

  /**
   * Get a named enum from the registry.
   */
  getEnum(name: string): NamedEnum | undefined {
    return this.enums.get(name);
  }

  /**
   * Check if a named enum exists in the registry.
   */
  hasEnum(name: string): boolean {
    return this.enums.has(name);
  }

  get(name: string): NamedSchema | undefined {
    return this.schemas.get(name);
  }

  has(name: string): boolean {
    return this.schemas.has(name);
  }

  /** Iterate over all entries. */
  entries(): IterableIterator<[string, NamedSchema]> {
    return this.schemas.entries();
  }

  /**
   * T-505: Version-aware schema lookup.
   * Given an original schema (with _tsadwynName), returns the versioned copy
   * from this registry, or the original if not found.
   */
  getVersioned(originalSchema: ZodTypeAny): ZodTypeAny {
    const name = (originalSchema as any)._tsadwynName;
    if (!name) return originalSchema;
    const entry = this.schemas.get(name);
    if (!entry) return originalSchema;
    return entry.schema;
  }

  /**
   * Rename a schema in the registry (used for schema().had({ name: "..." })).
   */
  rename(oldName: string, newName: string): void {
    const entry = this.schemas.get(oldName);
    if (entry) {
      this.schemas.delete(oldName);
      entry.name = newName;
      this.schemas.set(newName, entry);
    }
  }

  /**
   * Deep-clone the registry so each version gets its own copy.
   */
  clone(): ZodSchemaRegistry {
    const cloned = new ZodSchemaRegistry();
    for (const [name, entry] of this.schemas) {
      cloned.schemas.set(name, {
        name: entry.name,
        schema: entry.schema,
        shape: { ...entry.shape },
        namedRefinements: [...entry.namedRefinements],
        computedFields: [...entry.computedFields],
      });
    }
    for (const [name, entry] of this.enums) {
      cloned.enums.set(name, {
        name: entry.name,
        schema: entry.schema,
        members: { ...entry.members },
      });
    }
    return cloned;
  }
}

/**
 * T-504: Recursively walk a Zod schema tree and replace named schema references
 * with their versioned copies from the given registry.
 *
 * Handles ZodObject, ZodArray, ZodOptional, ZodNullable, ZodDefault,
 * ZodUnion, ZodDiscriminatedUnion, ZodIntersection, ZodTuple, ZodRecord,
 * ZodMap, ZodSet, ZodLazy, ZodEffects, ZodPipeline.
 */
export function transformSchemaReferences(
  schema: ZodTypeAny,
  registry: ZodSchemaRegistry,
): ZodTypeAny {
  // If this schema itself is named and has a versioned copy, return it
  const name = (schema as any)._tsadwynName;
  if (name && registry.has(name)) {
    return registry.get(name)!.schema;
  }

  if (schema instanceof ZodObject) {
    const currentShape = (schema as ZodObject<any>).shape;
    const newShape: Record<string, ZodTypeAny> = {};
    let changed = false;
    for (const [key, value] of Object.entries(currentShape)) {
      const transformed = transformSchemaReferences(value as ZodTypeAny, registry);
      newShape[key] = transformed;
      if (transformed !== value) changed = true;
    }
    if (!changed) return schema;
    const rebuilt = z.object(newShape as ZodRawShape);
    _copyZodObjectModifiers(schema, rebuilt);
    return rebuilt;
  }

  if (schema instanceof ZodArray) {
    const inner = (schema._def as any).type as ZodTypeAny;
    const transformed = transformSchemaReferences(inner, registry);
    if (transformed === inner) return schema;
    return z.array(transformed);
  }

  if (schema instanceof ZodOptional) {
    const inner = (schema._def as any).innerType as ZodTypeAny;
    const transformed = transformSchemaReferences(inner, registry);
    if (transformed === inner) return schema;
    return transformed.optional();
  }

  if (schema instanceof ZodNullable) {
    const inner = (schema._def as any).innerType as ZodTypeAny;
    const transformed = transformSchemaReferences(inner, registry);
    if (transformed === inner) return schema;
    return transformed.nullable();
  }

  if (schema instanceof ZodDefault) {
    const inner = (schema._def as any).innerType as ZodTypeAny;
    const transformed = transformSchemaReferences(inner, registry);
    if (transformed === inner) return schema;
    return transformed.default((schema._def as any).defaultValue());
  }

  // T-502: ZodUnion
  if (schema instanceof ZodUnion) {
    const options = (schema._def as any).options as ZodTypeAny[];
    let changed = false;
    const newOptions = options.map((opt: ZodTypeAny) => {
      const t = transformSchemaReferences(opt, registry);
      if (t !== opt) changed = true;
      return t;
    });
    if (!changed) return schema;
    return z.union(newOptions as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
  }

  // T-502: ZodDiscriminatedUnion
  if (schema instanceof ZodDiscriminatedUnion) {
    const options = (schema._def as any).options as ZodTypeAny[];
    const discriminator = (schema._def as any).discriminator as string;
    let changed = false;
    const newOptions = options.map((opt: ZodTypeAny) => {
      const t = transformSchemaReferences(opt, registry);
      if (t !== opt) changed = true;
      return t;
    });
    if (!changed) return schema;
    return z.discriminatedUnion(discriminator, newOptions as [ZodObject<any>, ...ZodObject<any>[]]);
  }

  // T-501: ZodIntersection (.and())
  if (schema instanceof ZodIntersection) {
    const left = (schema._def as any).left as ZodTypeAny;
    const right = (schema._def as any).right as ZodTypeAny;
    const tLeft = transformSchemaReferences(left, registry);
    const tRight = transformSchemaReferences(right, registry);
    if (tLeft === left && tRight === right) return schema;
    return z.intersection(tLeft, tRight);
  }

  if (schema instanceof ZodTuple) {
    const items = (schema._def as any).items as ZodTypeAny[];
    let changed = false;
    const newItems = items.map((item: ZodTypeAny) => {
      const t = transformSchemaReferences(item, registry);
      if (t !== item) changed = true;
      return t;
    });
    if (!changed) return schema;
    return z.tuple(newItems as [ZodTypeAny, ...ZodTypeAny[]]);
  }

  if (schema instanceof ZodRecord) {
    const valueType = (schema._def as any).valueType as ZodTypeAny;
    const transformed = transformSchemaReferences(valueType, registry);
    if (transformed === valueType) return schema;
    const keyType = (schema._def as any).keyType;
    return z.record(keyType, transformed);
  }

  if (schema instanceof ZodMap) {
    const keyType = (schema._def as any).keyType as ZodTypeAny;
    const valueType = (schema._def as any).valueType as ZodTypeAny;
    const tKey = transformSchemaReferences(keyType, registry);
    const tVal = transformSchemaReferences(valueType, registry);
    if (tKey === keyType && tVal === valueType) return schema;
    return z.map(tKey, tVal);
  }

  if (schema instanceof ZodSet) {
    const valueType = (schema._def as any).valueType as ZodTypeAny;
    const transformed = transformSchemaReferences(valueType, registry);
    if (transformed === valueType) return schema;
    return z.set(transformed);
  }

  if (schema instanceof ZodLazy) {
    const getter = (schema._def as any).getter as () => ZodTypeAny;
    return z.lazy(() => transformSchemaReferences(getter(), registry));
  }

  if (schema instanceof ZodEffects) {
    const inner = (schema._def as any).schema as ZodTypeAny;
    const transformed = transformSchemaReferences(inner, registry);
    if (transformed === inner) return schema;
    const def = { ...(schema._def as any), schema: transformed };
    return new ZodEffects(def);
  }

  // T-501: ZodPipeline (.pipe())
  if (schema instanceof ZodPipeline) {
    const inSchema = (schema._def as any).in as ZodTypeAny;
    const outSchema = (schema._def as any).out as ZodTypeAny;
    const tIn = transformSchemaReferences(inSchema, registry);
    const tOut = transformSchemaReferences(outSchema, registry);
    if (tIn === inSchema && tOut === outSchema) return schema;
    return tIn.pipe(tOut);
  }

  return schema;
}

/**
 * T-503: Copy ZodObject modifier properties (_def) from source to target.
 * Preserves unknownKeys (strict/strip/passthrough), catchall, and description.
 */
function _copyZodObjectModifiers(source: ZodObject<any>, target: ZodObject<any>): void {
  const srcDef = source._def as any;
  const tgtDef = target._def as any;

  if (srcDef.unknownKeys !== undefined) {
    tgtDef.unknownKeys = srcDef.unknownKeys;
  }
  if (srcDef.catchall !== undefined) {
    tgtDef.catchall = srcDef.catchall;
  }
  if (srcDef.description !== undefined) {
    tgtDef.description = srcDef.description;
  }
}

/**
 * T-500: Walk all schemas in a registry and replace named schema references
 * in each schema's shape with the versioned counterparts from the same registry.
 */
function _transformAllReferencesInRegistry(registry: ZodSchemaRegistry): void {
  for (const [_name, entry] of registry.entries()) {
    if (entry.schema instanceof ZodObject) {
      let changed = false;
      const newShape: Record<string, ZodTypeAny> = {};
      for (const [key, value] of Object.entries(entry.shape)) {
        const transformed = transformSchemaReferences(value as ZodTypeAny, registry);
        newShape[key] = transformed;
        if (transformed !== value) changed = true;
      }
      if (changed) {
        entry.shape = newShape;
        const rebuilt = z.object(newShape as ZodRawShape);
        _copyZodObjectModifiers(entry.schema as ZodObject<any>, rebuilt);
        setSchemaName(rebuilt, entry.name);
        entry.schema = rebuilt;
      }
    } else {
      const transformed = transformSchemaReferences(entry.schema, registry);
      if (transformed !== entry.schema) {
        setSchemaName(transformed, entry.name);
        entry.schema = transformed;
      }
    }
  }
}

/**
 * Given a base registry of schemas (representing the latest/head version),
 * generate a map of version -> registry with alterations applied per version.
 *
 * Versions are iterated from latest to oldest, and schema alterations are
 * applied to transform the latest schemas into older version shapes.
 */
export function generateVersionedSchemas(
  versions: VersionBundle,
  baseRegistry: ZodSchemaRegistry,
): Map<string, ZodSchemaRegistry> {
  const result = new Map<string, ZodSchemaRegistry>();
  let currentRegistry = baseRegistry.clone();

  // T-1700: HeadVersion schema changes represent unreleased modifications.
  // They are NOT applied to the released version registries. HeadVersion changes
  // describe how to go from the "head" (unreleased) state to the latest released state.
  // The released versions are generated from the base registry as-is.
  // HeadVersion changes are stored on the VersionBundle for use by tools that need
  // the unreleased schema state (e.g., the OpenAPI generator for preview mode).

  for (const version of versions.versions) {
    // T-500/T-504: Walk each schema and replace named references with versioned copies
    _transformAllReferencesInRegistry(currentRegistry);

    result.set(version.value, currentRegistry);

    // Now apply this version's schema changes to produce the registry for the next-older version.
    const nextRegistry = currentRegistry.clone();
    for (const change of version.changes) {
      for (const instruction of change._alterSchemaInstructions) {
        applySchemaInstruction(nextRegistry, instruction);
      }
      // Process enum instructions
      for (const instruction of change._alterEnumInstructions) {
        applyEnumInstruction(nextRegistry, instruction);
      }
    }
    currentRegistry = nextRegistry;
  }

  return result;
}

/**
 * Apply a single schema alteration instruction to a registry.
 */
function applySchemaInstruction(
  registry: ZodSchemaRegistry,
  instruction: AlterSchemaSubInstruction,
): void {
  // Schema-level instructions (renaming) don't need the entry to exist in the same way
  if (instruction.kind === "schema_had") {
    applySchemaHad(registry, instruction);
    return;
  }

  const entry = registry.get(instruction.schemaName);
  if (!entry) {
    throw new InvalidGenerationInstructionError(
      `Schema "${instruction.schemaName}" is not registered in the schema registry. ` +
      "Cannot apply instruction to an unregistered schema.",
    );
  }

  if (instruction.kind === "field_had") {
    applyFieldHad(entry, instruction);
  } else if (instruction.kind === "field_didnt_exist") {
    applyFieldDidntExist(entry, instruction);
  } else if (instruction.kind === "field_existed_as") {
    applyFieldExistedAs(entry, instruction);
  } else if (instruction.kind === "field_didnt_have") {
    applyFieldDidntHave(entry, instruction);
  } else if (instruction.kind === "validator_existed") {
    applyValidatorExisted(entry, instruction);
  } else if (instruction.kind === "validator_didnt_exist") {
    applyValidatorDidntExist(entry, instruction);
  } else if (instruction.kind === "computed_field_existed") {
    applyComputedFieldExisted(entry, instruction);
  } else if (instruction.kind === "computed_field_didnt_exist") {
    applyComputedFieldDidntExist(entry, instruction);
  }

  // Rebuild the ZodObject with the modified shape
  if (entry.schema instanceof ZodObject) {
    // T-503: Preserve modifiers when rebuilding
    const oldSchema = entry.schema;
    let rebuilt: ZodTypeAny = z.object(entry.shape as ZodRawShape);
    _copyZodObjectModifiers(oldSchema as ZodObject<any>, rebuilt as ZodObject<any>);
    // Re-apply named refinements
    for (const ref of entry.namedRefinements) {
      rebuilt = rebuilt.refine(ref.fn, ref.message ? { message: ref.message } : undefined);
      if (!(rebuilt as any)._tsadwynNamedRefinements) {
        (rebuilt as any)._tsadwynNamedRefinements = [];
      }
      (rebuilt as any)._tsadwynNamedRefinements.push(ref);
    }
    // T-1802: Re-apply computed fields as .transform() calls
    for (const cf of entry.computedFields) {
      rebuilt = (rebuilt as ZodEffects<any>).transform((data: any) => ({
        ...data,
        [cf.name]: cf.compute(data),
      }));
      if (!(rebuilt as any)._tsadwynComputedFields) {
        (rebuilt as any)._tsadwynComputedFields = [];
      }
      (rebuilt as any)._tsadwynComputedFields.push(cf);
    }
    entry.schema = rebuilt;
    // Preserve the name using the WeakMap registry
    setSchemaName(entry.schema, entry.name);
  }
}

/**
 * A field "had" different properties in the previous version:
 * - If `oldName` is set, rename the field.
 * - If `oldType` is set, change the field's type.
 * - If constraint attributes are set, apply them.
 */
function applyFieldHad(entry: NamedSchema, instruction: FieldHadInstruction): void {
  const currentName = instruction.fieldName;
  const newName = instruction.oldName || currentName;
  const newType = instruction.oldType;

  // T-106: Validate no-op for field renaming
  if (instruction.oldName !== undefined && instruction.oldName === currentName) {
    // Check if there are any other changes besides name
    const hasOtherChanges = instruction.oldType !== undefined ||
      instruction.hasDefault ||
      instruction.optional !== undefined ||
      instruction.nullable !== undefined ||
      instruction.description !== undefined ||
      instruction.min !== undefined ||
      instruction.minLength !== undefined ||
      instruction.max !== undefined ||
      instruction.maxLength !== undefined ||
      instruction.gt !== undefined ||
      instruction.gte !== undefined ||
      instruction.lt !== undefined ||
      instruction.lte !== undefined ||
      instruction.regex !== undefined ||
      instruction.pattern !== undefined ||
      instruction.multipleOf !== undefined ||
      instruction.int !== undefined ||
      instruction.title !== undefined ||
      instruction.examples !== undefined ||
      instruction.discriminator !== undefined ||
      instruction.json_schema_extra !== undefined;

    if (!hasOtherChanges) {
      throw new InvalidGenerationInstructionError(
        `Field "${currentName}" on schema "${instruction.schemaName}" is being renamed to its current name "${instruction.oldName}". This is a no-op.`,
      );
    }
  }

  // T-106: Validate no-op: if only type is set and it's the same
  if (
    instruction.oldType !== undefined &&
    instruction.oldName === undefined &&
    !instruction.hasDefault &&
    instruction.optional === undefined &&
    instruction.nullable === undefined &&
    instruction.description === undefined &&
    instruction.min === undefined &&
    instruction.minLength === undefined &&
    instruction.max === undefined &&
    instruction.maxLength === undefined &&
    instruction.gt === undefined &&
    instruction.gte === undefined &&
    instruction.lt === undefined &&
    instruction.lte === undefined &&
    instruction.regex === undefined &&
    instruction.pattern === undefined &&
    instruction.multipleOf === undefined &&
    instruction.int === undefined &&
    instruction.title === undefined &&
    instruction.examples === undefined &&
    instruction.discriminator === undefined &&
    instruction.json_schema_extra === undefined
  ) {
    const existingType = entry.shape[currentName];
    if (existingType && existingType === instruction.oldType) {
      throw new InvalidGenerationInstructionError(
        `Field "${currentName}" on schema "${instruction.schemaName}" type is being set to the same type. This is a no-op.`,
      );
    }
  }

  if (newName !== currentName) {
    // Rename: remove the current field and add with the old name
    const existingType = entry.shape[currentName];
    if (existingType === undefined) {
      throw new InvalidGenerationInstructionError(
        `Field "${currentName}" does not exist on schema "${instruction.schemaName}". Cannot apply field_had instruction.`,
      );
    }
    delete entry.shape[currentName];
    let fieldType = newType || existingType;
    fieldType = applyFieldConstraints(fieldType, instruction);
    entry.shape[newName] = fieldType;
  } else if (newType) {
    // Change the type and apply constraints
    let fieldType = newType;
    fieldType = applyFieldConstraints(fieldType, instruction);
    entry.shape[currentName] = fieldType;
  } else {
    // Only constraint changes, no type or name change
    const existingType = entry.shape[currentName];
    if (existingType === undefined) {
      throw new InvalidGenerationInstructionError(
        `Field "${currentName}" does not exist on schema "${instruction.schemaName}". Cannot apply field_had instruction.`,
      );
    }
    const modified = applyFieldConstraints(existingType, instruction);
    entry.shape[currentName] = modified;
  }
}

/**
 * Apply constraint attributes from a FieldHadInstruction to a Zod type.
 * Returns the modified Zod type (Zod types are immutable, so a new one is returned).
 */
function applyFieldConstraints(fieldType: ZodTypeAny, instruction: FieldHadInstruction): ZodTypeAny {
  let result = fieldType;

  // description
  if (instruction.description !== undefined) {
    result = result.describe(instruction.description);
  }

  // min / minLength
  if (instruction.min !== undefined) {
    if (result instanceof ZodString) {
      result = result.min(instruction.min);
    } else if (result instanceof ZodNumber) {
      result = result.gte(instruction.min);
    } else if (result instanceof ZodArray) {
      result = result.min(instruction.min);
    }
  }
  if (instruction.minLength !== undefined) {
    if (result instanceof ZodString) {
      result = result.min(instruction.minLength);
    } else if (result instanceof ZodArray) {
      result = result.min(instruction.minLength);
    }
  }

  // max / maxLength
  if (instruction.max !== undefined) {
    if (result instanceof ZodString) {
      result = result.max(instruction.max);
    } else if (result instanceof ZodNumber) {
      result = result.lte(instruction.max);
    } else if (result instanceof ZodArray) {
      result = result.max(instruction.max);
    }
  }
  if (instruction.maxLength !== undefined) {
    if (result instanceof ZodString) {
      result = result.max(instruction.maxLength);
    } else if (result instanceof ZodArray) {
      result = result.max(instruction.maxLength);
    }
  }

  // gt, gte, lt, lte (numeric constraints)
  if (instruction.gt !== undefined && result instanceof ZodNumber) {
    result = result.gt(instruction.gt);
  }
  if (instruction.gte !== undefined && result instanceof ZodNumber) {
    result = result.gte(instruction.gte);
  }
  if (instruction.lt !== undefined && result instanceof ZodNumber) {
    result = result.lt(instruction.lt);
  }
  if (instruction.lte !== undefined && result instanceof ZodNumber) {
    result = result.lte(instruction.lte);
  }

  // regex / pattern
  if (instruction.regex !== undefined && result instanceof ZodString) {
    result = result.regex(instruction.regex);
  }
  if (instruction.pattern !== undefined && result instanceof ZodString) {
    result = result.regex(instruction.pattern);
  }

  // multipleOf
  if (instruction.multipleOf !== undefined && result instanceof ZodNumber) {
    result = result.multipleOf(instruction.multipleOf);
  }

  // int
  if (instruction.int === true && result instanceof ZodNumber) {
    result = result.int();
  }

  // nullable
  if (instruction.nullable === true) {
    result = result.nullable();
  }

  // optional
  if (instruction.optional === true) {
    result = result.optional();
  }

  // default
  if (instruction.hasDefault) {
    result = result.default(instruction.default);
  }

  // T-1800: title - stored as custom metadata via _tsadwynTitle
  if (instruction.title !== undefined) {
    (result as any)._tsadwynTitle = instruction.title;
  }

  // T-1800: examples - stored as custom metadata via _tsadwynExamples
  if (instruction.examples !== undefined) {
    (result as any)._tsadwynExamples = instruction.examples;
  }

  // T-1800: discriminator - stored as custom metadata via _tsadwynDiscriminator
  if (instruction.discriminator !== undefined) {
    (result as any)._tsadwynDiscriminator = instruction.discriminator;
  }

  // T-1800: json_schema_extra - stored as custom metadata via _tsadwynJsonSchemaExtra
  if (instruction.json_schema_extra !== undefined) {
    (result as any)._tsadwynJsonSchemaExtra = instruction.json_schema_extra;
  }

  return result;
}

/**
 * A field didn't exist in the previous version - remove it.
 */
function applyFieldDidntExist(
  entry: NamedSchema,
  instruction: FieldDidntExistInstruction,
): void {
  // T-106: Validate no-op: field already doesn't exist
  if (!(instruction.fieldName in entry.shape)) {
    throw new InvalidGenerationInstructionError(
      `Field "${instruction.fieldName}" does not exist on schema "${instruction.schemaName}". ` +
      "Cannot remove a field that doesn't exist. This is a no-op.",
    );
  }
  delete entry.shape[instruction.fieldName];
}

/**
 * A field existed as a specific type in the previous version - add it.
 */
function applyFieldExistedAs(
  entry: NamedSchema,
  instruction: FieldExistedAsInstruction,
): void {
  // T-106: Validate no-op: field already exists with the same type
  if (instruction.fieldName in entry.shape && entry.shape[instruction.fieldName] === instruction.type) {
    throw new InvalidGenerationInstructionError(
      `Field "${instruction.fieldName}" on schema "${instruction.schemaName}" already exists with the same type. This is a no-op.`,
    );
  }
  entry.shape[instruction.fieldName] = instruction.type;
}

/**
 * A field didn't have certain constraints in the previous version - strip them.
 * Since Zod schemas are immutable, we rebuild the field schema without the specified checks.
 */
function applyFieldDidntHave(
  entry: NamedSchema,
  instruction: FieldDidntHaveInstruction,
): void {
  const fieldType = entry.shape[instruction.fieldName];
  if (!fieldType) {
    throw new InvalidGenerationInstructionError(
      `Field "${instruction.fieldName}" does not exist on schema "${instruction.schemaName}". ` +
      "Cannot remove constraints from a field that doesn't exist.",
    );
  }

  let result = fieldType;

  for (const attr of instruction.attributes) {
    result = removeConstraint(result, attr);
  }

  entry.shape[instruction.fieldName] = result;
}

/**
 * Remove a specific constraint from a Zod type.
 * Works by filtering the internal _def.checks array for string/number types.
 */
function removeConstraint(schema: ZodTypeAny, constraint: string): ZodTypeAny {
  // Handle wrapper types (optional, nullable, default) that delegate to an inner type
  if (constraint === "optional" && schema instanceof ZodOptional) {
    return schema.unwrap();
  }
  if (constraint === "nullable" && schema instanceof ZodNullable) {
    return schema.unwrap();
  }
  if (constraint === "default" && schema instanceof ZodDefault) {
    return schema._def.innerType;
  }
  if (constraint === "description") {
    // Create a copy without the description
    const newSchema = schema.describe(undefined as any);
    // Zod's describe returns a clone with the description set.
    // We need to actually remove it.
    if (newSchema._def.description !== undefined) {
      delete (newSchema._def as any).description;
    }
    return newSchema;
  }

  // T-1800/T-1801: Remove custom metadata constraints
  if (constraint === "title") {
    delete (schema as any)._tsadwynTitle;
    return schema;
  }
  if (constraint === "examples") {
    delete (schema as any)._tsadwynExamples;
    return schema;
  }
  if (constraint === "discriminator") {
    delete (schema as any)._tsadwynDiscriminator;
    return schema;
  }
  if (constraint === "json_schema_extra") {
    delete (schema as any)._tsadwynJsonSchemaExtra;
    return schema;
  }

  // For string checks
  if (schema instanceof ZodString) {
    const checkKindMap: Record<string, string> = {
      min: "min",
      minLength: "min",
      max: "max",
      maxLength: "max",
      regex: "regex",
      pattern: "regex",
    };
    const checkKind = checkKindMap[constraint];
    if (checkKind && schema._def.checks) {
      const newChecks = schema._def.checks.filter(
        (c: any) => c.kind !== checkKind,
      );
      const newSchema = z.string();
      (newSchema._def as any).checks = newChecks;
      // Copy over any remaining properties
      if (schema._def.description) {
        return newSchema.describe(schema._def.description);
      }
      return newSchema;
    }
  }

  // For number checks
  if (schema instanceof ZodNumber) {
    const checkKindMap: Record<string, string> = {
      min: "min",
      max: "max",
      gt: "min", // gt is stored as min with inclusive=false
      gte: "min", // gte is stored as min with inclusive=true
      lt: "max",  // lt is stored as max with inclusive=false
      lte: "max", // lte is stored as max with inclusive=true
      int: "int",
      multipleOf: "multipleOf",
    };
    const checkKind = checkKindMap[constraint];
    if (checkKind && schema._def.checks) {
      let newChecks: any[];
      if (constraint === "gt") {
        newChecks = schema._def.checks.filter(
          (c: any) => !(c.kind === "min" && c.inclusive === false),
        );
      } else if (constraint === "gte" || constraint === "min") {
        newChecks = schema._def.checks.filter(
          (c: any) => !(c.kind === "min" && c.inclusive === true),
        );
      } else if (constraint === "lt") {
        newChecks = schema._def.checks.filter(
          (c: any) => !(c.kind === "max" && c.inclusive === false),
        );
      } else if (constraint === "lte" || constraint === "max") {
        newChecks = schema._def.checks.filter(
          (c: any) => !(c.kind === "max" && c.inclusive === true),
        );
      } else {
        newChecks = schema._def.checks.filter(
          (c: any) => c.kind !== checkKind,
        );
      }
      const newSchema = z.number();
      (newSchema._def as any).checks = newChecks;
      if (schema._def.description) {
        return newSchema.describe(schema._def.description);
      }
      return newSchema;
    }
  }

  // For array checks
  if (schema instanceof ZodArray) {
    const checkKindMap: Record<string, string> = {
      min: "min",
      minLength: "min",
      max: "max",
      maxLength: "max",
    };
    const fieldName = checkKindMap[constraint];
    if (fieldName) {
      // ZodArray uses _def.minLength and _def.maxLength (or exactLength)
      if (fieldName === "min" && schema._def.minLength !== null) {
        const newSchema = z.array(schema._def.type);
        if (schema._def.maxLength !== null) {
          (newSchema._def as any).maxLength = schema._def.maxLength;
        }
        if (schema._def.description) {
          return newSchema.describe(schema._def.description);
        }
        return newSchema;
      }
      if (fieldName === "max" && schema._def.maxLength !== null) {
        const newSchema = z.array(schema._def.type);
        if (schema._def.minLength !== null) {
          (newSchema._def as any).minLength = schema._def.minLength;
        }
        if (schema._def.description) {
          return newSchema.describe(schema._def.description);
        }
        return newSchema;
      }
    }
  }

  return schema;
}

/**
 * Rename a schema in the registry.
 */
function applySchemaHad(
  registry: ZodSchemaRegistry,
  instruction: SchemaHadInstruction,
): void {
  // T-106: Validate no-op: renaming to the same name
  if (instruction.oldSchemaName === instruction.schemaName) {
    throw new InvalidGenerationInstructionError(
      `Schema "${instruction.schemaName}" is being renamed to its current name. This is a no-op.`,
    );
  }

  const entry = registry.get(instruction.schemaName);
  if (!entry) {
    throw new InvalidGenerationInstructionError(
      `Schema "${instruction.schemaName}" is not registered in the schema registry. ` +
      "Cannot rename an unregistered schema.",
    );
  }

  registry.rename(instruction.schemaName, instruction.oldSchemaName);
  // Update the tsadwyn name on the schema object itself using the WeakMap registry
  setSchemaName(entry.schema, instruction.oldSchemaName);
}

/**
 * A validator existed in the previous version - re-add it.
 */
function applyValidatorExisted(
  entry: NamedSchema,
  instruction: ValidatorExistedInstruction,
): void {
  // T-106: Validate no-op: validator already exists
  if (entry.namedRefinements.some(r => r.name === instruction.validatorName)) {
    throw new InvalidGenerationInstructionError(
      `Validator "${instruction.validatorName}" already exists on schema "${instruction.schemaName}". This is a no-op.`,
    );
  }

  entry.namedRefinements.push({
    name: instruction.validatorName,
    fn: instruction.validatorFn,
    message: instruction.message,
  });
}

/**
 * A validator didn't exist in the previous version - remove it.
 */
function applyValidatorDidntExist(
  entry: NamedSchema,
  instruction: ValidatorDidntExistInstruction,
): void {
  // T-106: Validate no-op: validator doesn't exist
  const idx = entry.namedRefinements.findIndex(r => r.name === instruction.validatorName);
  if (idx === -1) {
    throw new InvalidGenerationInstructionError(
      `Validator "${instruction.validatorName}" does not exist on schema "${instruction.schemaName}". ` +
      "Cannot remove a validator that doesn't exist. This is a no-op.",
    );
  }

  entry.namedRefinements.splice(idx, 1);
}

/**
 * T-1802: A computed field existed in the previous version - re-add it.
 */
function applyComputedFieldExisted(
  entry: NamedSchema,
  instruction: ComputedFieldExistedInstruction,
): void {
  // Validate no-op: computed field already exists
  if (entry.computedFields.some(cf => cf.name === instruction.fieldName)) {
    throw new InvalidGenerationInstructionError(
      `Computed field "${instruction.fieldName}" already exists on schema "${instruction.schemaName}". This is a no-op.`,
    );
  }

  entry.computedFields.push({
    name: instruction.fieldName,
    compute: instruction.compute,
  });
}

/**
 * T-1802: A computed field didn't exist in the previous version - remove it.
 */
function applyComputedFieldDidntExist(
  entry: NamedSchema,
  instruction: ComputedFieldDidntExistInstruction,
): void {
  const idx = entry.computedFields.findIndex(cf => cf.name === instruction.fieldName);
  if (idx === -1) {
    throw new InvalidGenerationInstructionError(
      `Computed field "${instruction.fieldName}" does not exist on schema "${instruction.schemaName}". ` +
      "Cannot remove a computed field that doesn't exist. This is a no-op.",
    );
  }

  entry.computedFields.splice(idx, 1);
}

/**
 * Apply a single enum alteration instruction to a registry.
 */
function applyEnumInstruction(
  registry: ZodSchemaRegistry,
  instruction: AlterEnumSubInstruction,
): void {
  const enumName = instruction.enumName;
  let entry = registry.getEnum(enumName);

  // If the enum isn't registered yet, auto-register it from the instruction's schema
  if (!entry) {
    registry.registerEnum(enumName, instruction.enumSchema);
    entry = registry.getEnum(enumName)!;
  }

  if (instruction.kind === "enum_had_members") {
    // Add or change enum members in the older version
    for (const [memberName, memberValue] of Object.entries(instruction.members)) {
      if (memberName in entry.members && entry.members[memberName] === memberValue) {
        throw new InvalidGenerationInstructionError(
          `You tried to add a member "${memberName}" to enum "${enumName}" ` +
          `but there is already a member with that name and value.`,
        );
      }
      entry.members[memberName] = memberValue;
    }
  } else if (instruction.kind === "enum_didnt_have_members") {
    // Remove enum members that didn't exist in the older version
    for (const memberName of instruction.members) {
      if (!(memberName in entry.members)) {
        throw new InvalidGenerationInstructionError(
          `You tried to delete a member "${memberName}" from enum "${enumName}" ` +
          `but it doesn't have such a member.`,
        );
      }
      delete entry.members[memberName];
    }
  }

  // Rebuild the Zod enum schema from the modified members
  const memberValues = Object.values(entry.members);
  if (memberValues.length > 0) {
    const newSchema = z.enum(memberValues as [string, ...string[]]);
    setSchemaName(newSchema, enumName);
    entry.schema = newSchema;
  }
}
