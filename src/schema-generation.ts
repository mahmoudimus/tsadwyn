import { z, ZodObject, ZodTypeAny, ZodRawShape } from "zod";
import type { AlterSchemaSubInstruction, FieldHadInstruction, FieldDidntExistInstruction } from "./structure/schemas.js";
import type { VersionBundle } from "./structure/versions.js";

/**
 * A named Zod schema entry in the registry.
 */
export interface NamedSchema {
  name: string;
  schema: ZodTypeAny;
  shape: Record<string, ZodTypeAny>;
}

/**
 * Registry that maps schema names to their Zod definitions.
 * Used for generating versioned copies of schemas.
 */
export class ZodSchemaRegistry {
  private schemas: Map<string, NamedSchema> = new Map();

  register(name: string, schema: ZodTypeAny): void {
    if (schema instanceof ZodObject) {
      this.schemas.set(name, {
        name,
        schema,
        shape: { ...(schema as ZodObject<any>).shape },
      });
    } else {
      this.schemas.set(name, { name, schema, shape: {} });
    }
  }

  get(name: string): NamedSchema | undefined {
    return this.schemas.get(name);
  }

  has(name: string): boolean {
    return this.schemas.has(name);
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
      });
    }
    return cloned;
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

  for (const version of versions.versions) {
    // Apply schema alterations for this version to produce the *previous* version's schemas.
    // But first, store the current registry for THIS version.
    // The alterations on a version describe how to go from the current version to the previous one.
    // So for the latest version, no alterations have been applied yet (it IS the latest).
    // Then we apply the latest version's changes to get the second-latest, and so on.

    result.set(version.value, currentRegistry);

    // Now apply this version's schema changes to produce the registry for the next-older version.
    const nextRegistry = currentRegistry.clone();
    for (const change of version.changes) {
      for (const instruction of change._alterSchemaInstructions) {
        applySchemaInstruction(nextRegistry, instruction);
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
  const entry = registry.get(instruction.schemaName);
  if (!entry) {
    return; // Schema not registered; skip.
  }

  if (instruction.kind === "field_had") {
    applyFieldHad(entry, instruction);
  } else if (instruction.kind === "field_didnt_exist") {
    applyFieldDidntExist(entry, instruction);
  }

  // Rebuild the ZodObject with the modified shape
  if (entry.schema instanceof ZodObject) {
    entry.schema = z.object(entry.shape as ZodRawShape);
    // Preserve the name
    (entry.schema as any)._tsadwynName = entry.name;
  }
}

/**
 * A field "had" different properties in the previous version:
 * - If `oldName` is set, rename the field.
 * - If `oldType` is set, change the field's type.
 */
function applyFieldHad(entry: NamedSchema, instruction: FieldHadInstruction): void {
  const currentName = instruction.fieldName;
  const newName = instruction.oldName || currentName;
  const newType = instruction.oldType;

  if (newName !== currentName) {
    // Rename: remove the current field and add with the old name
    const existingType = entry.shape[currentName];
    delete entry.shape[currentName];
    entry.shape[newName] = newType || existingType;
  } else if (newType) {
    // Just change the type
    entry.shape[currentName] = newType;
  }
}

/**
 * A field didn't exist in the previous version - remove it.
 */
function applyFieldDidntExist(
  entry: NamedSchema,
  instruction: FieldDidntExistInstruction,
): void {
  delete entry.shape[instruction.fieldName];
}
