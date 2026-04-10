import type { VersionBundle, VersionChange } from "./structure/versions.js";
import { VersionChangeWithSideEffects } from "./structure/versions.js";
import type { AlterSchemaSubInstruction, HiddenFromChangelogMixin } from "./structure/schemas.js";
import { AlterSchemaInstructionFactory } from "./structure/schemas.js";
import type { AlterEndpointSubInstruction } from "./structure/endpoints.js";
import type { AlterEnumSubInstruction } from "./structure/enums.js";
import { ZodObject } from "zod";
import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Look up the current (head version) Zod type of a named schema's field.
 */
function _getCurrentFieldType(schemaName: string, fieldName: string): ZodTypeAny | null {
  const zodSchema = AlterSchemaInstructionFactory._knownSchemas.get(schemaName);
  if (!zodSchema || !(zodSchema instanceof ZodObject)) return null;
  const shape = (zodSchema as ZodObject<any>).shape;
  return (shape?.[fieldName] as ZodTypeAny | undefined) ?? null;
}

// ── Changelog resource types ────────────────────────────────────────────────

export interface ChangelogAttributeChange {
  name: string;
  status: "added" | "changed" | "removed";
  oldValue: any;
  newValue: any;
}

export interface ChangelogEndpointAttributeChange {
  name: string;
  newValue: any;
}

/**
 * A single changelog instruction representing one schema, endpoint, or enum change.
 */
export type ChangelogInstruction =
  | {
      type: "endpoint.added";
      path: string;
      methods: string[];
    }
  | {
      type: "endpoint.removed";
      path: string;
      methods: string[];
    }
  | {
      type: "endpoint.changed";
      path: string;
      methods: string[];
      changes: ChangelogEndpointAttributeChange[];
    }
  | {
      type: "schema.changed";
      schema: string;
      modifiedAttributes: { name: string | null };
    }
  | {
      type: "schema.field.added";
      schema: string;
      field: string;
    }
  | {
      type: "schema.field.removed";
      schema: string;
      field: string;
    }
  | {
      type: "schema.field.attributes.changed";
      schema: string;
      field: string;
      attributeChanges: ChangelogAttributeChange[];
    }
  | {
      type: "enum.members.added";
      enum: string;
      members: string[];
    }
  | {
      type: "enum.members.removed";
      enum: string;
      members: Record<string, unknown>;
    };

export interface ChangelogVersionChange {
  description: string;
  sideEffects: boolean;
  instructions: ChangelogInstruction[];
}

export interface ChangelogVersion {
  value: string;
  changes: ChangelogVersionChange[];
}

export interface ChangelogResource {
  versions: ChangelogVersion[];
}

/**
 * Check if an instruction has the isHiddenFromChangelog flag.
 */
function isHiddenFromChangelog(instruction: any): boolean {
  return instruction && typeof instruction === "object" && instruction.isHiddenFromChangelog === true;
}

/**
 * Convert a schema alteration instruction to a changelog entry.
 */
function convertSchemaInstruction(instruction: AlterSchemaSubInstruction): ChangelogInstruction | null {
  // Skip validator instructions (they are internal details)
  if (instruction.kind === "validator_existed" || instruction.kind === "validator_didnt_exist") {
    return null;
  }

  if (instruction.kind === "field_didnt_exist") {
    return {
      type: "schema.field.added",
      schema: instruction.schemaName,
      field: instruction.fieldName,
    };
  }

  if (instruction.kind === "field_existed_as") {
    return {
      type: "schema.field.removed",
      schema: instruction.schemaName,
      field: instruction.fieldName,
    };
  }

  if (instruction.kind === "field_had") {
    const changes: ChangelogAttributeChange[] = [];

    if (instruction.oldName) {
      changes.push({
        name: "name",
        status: "changed",
        oldValue: instruction.oldName,
        newValue: instruction.fieldName,
      });
    }
    if (instruction.oldType) {
      // Convert Zod types to JSON Schema for before/after diffs
      let oldJsonSchema: any = null;
      let newJsonSchema: any = null;
      try {
        oldJsonSchema = zodToJsonSchema(instruction.oldType, { target: "openApi3" });
        delete oldJsonSchema["$schema"];
      } catch {
        // fall back to null
      }
      // Look up the current type from the head schema registry
      const currentType = _getCurrentFieldType(instruction.schemaName, instruction.fieldName);
      if (currentType) {
        try {
          newJsonSchema = zodToJsonSchema(currentType, { target: "openApi3" });
          delete newJsonSchema["$schema"];
        } catch {
          // fall back to null
        }
      }
      changes.push({
        name: "type",
        status: "changed",
        oldValue: oldJsonSchema,
        newValue: newJsonSchema,
      });
    }
    if (instruction.hasDefault) {
      changes.push({
        name: "default",
        status: "changed",
        oldValue: instruction.default,
        newValue: null,
      });
    }
    if (instruction.optional !== undefined) {
      changes.push({
        name: "optional",
        status: "changed",
        oldValue: instruction.optional,
        newValue: null,
      });
    }
    if (instruction.nullable !== undefined) {
      changes.push({
        name: "nullable",
        status: "changed",
        oldValue: instruction.nullable,
        newValue: null,
      });
    }
    if (instruction.description !== undefined) {
      changes.push({
        name: "description",
        status: "changed",
        oldValue: instruction.description,
        newValue: null,
      });
    }
    // Constraint changes with actual values
    if (instruction.min !== undefined) {
      changes.push({
        name: "min",
        status: "changed",
        oldValue: instruction.min,
        newValue: null,
      });
    }
    if (instruction.minLength !== undefined) {
      changes.push({
        name: "minLength",
        status: "changed",
        oldValue: instruction.minLength,
        newValue: null,
      });
    }
    if (instruction.max !== undefined) {
      changes.push({
        name: "max",
        status: "changed",
        oldValue: instruction.max,
        newValue: null,
      });
    }
    if (instruction.maxLength !== undefined) {
      changes.push({
        name: "maxLength",
        status: "changed",
        oldValue: instruction.maxLength,
        newValue: null,
      });
    }
    if (instruction.gt !== undefined) {
      changes.push({
        name: "gt",
        status: "changed",
        oldValue: instruction.gt,
        newValue: null,
      });
    }
    if (instruction.gte !== undefined) {
      changes.push({
        name: "gte",
        status: "changed",
        oldValue: instruction.gte,
        newValue: null,
      });
    }
    if (instruction.lt !== undefined) {
      changes.push({
        name: "lt",
        status: "changed",
        oldValue: instruction.lt,
        newValue: null,
      });
    }
    if (instruction.lte !== undefined) {
      changes.push({
        name: "lte",
        status: "changed",
        oldValue: instruction.lte,
        newValue: null,
      });
    }
    if (instruction.regex !== undefined) {
      changes.push({
        name: "regex",
        status: "changed",
        oldValue: instruction.regex.source,
        newValue: null,
      });
    }
    if (instruction.pattern !== undefined) {
      changes.push({
        name: "pattern",
        status: "changed",
        oldValue: instruction.pattern.source,
        newValue: null,
      });
    }
    if (instruction.multipleOf !== undefined) {
      changes.push({
        name: "multipleOf",
        status: "changed",
        oldValue: instruction.multipleOf,
        newValue: null,
      });
    }
    if (instruction.int !== undefined) {
      changes.push({
        name: "int",
        status: "changed",
        oldValue: instruction.int,
        newValue: null,
      });
    }

    return {
      type: "schema.field.attributes.changed",
      schema: instruction.schemaName,
      field: instruction.oldName || instruction.fieldName,
      attributeChanges: changes,
    };
  }

  if (instruction.kind === "field_didnt_have") {
    const changes: ChangelogAttributeChange[] = instruction.attributes.map((attr) => ({
      name: attr,
      status: "added" as const,
      oldValue: null,
      newValue: null,
    }));

    return {
      type: "schema.field.attributes.changed",
      schema: instruction.schemaName,
      field: instruction.fieldName,
      attributeChanges: changes,
    };
  }

  if (instruction.kind === "schema_had") {
    return {
      type: "schema.changed",
      schema: instruction.oldSchemaName,
      modifiedAttributes: { name: instruction.schemaName },
    };
  }

  return null;
}

/**
 * Convert an endpoint alteration instruction to a changelog entry.
 */
function convertEndpointInstruction(instruction: AlterEndpointSubInstruction): ChangelogInstruction | null {
  if (instruction.kind === "endpoint_didnt_exist") {
    return {
      type: "endpoint.added",
      path: instruction.path,
      methods: instruction.methods,
    };
  }

  if (instruction.kind === "endpoint_existed") {
    return {
      type: "endpoint.removed",
      path: instruction.path,
      methods: instruction.methods,
    };
  }

  if (instruction.kind === "endpoint_had") {
    const changes: ChangelogEndpointAttributeChange[] = [];
    const attrs = instruction.attributes;

    if (attrs.path !== undefined) {
      changes.push({ name: "path", newValue: attrs.path });
    }
    if (attrs.methods !== undefined) {
      changes.push({ name: "methods", newValue: attrs.methods });
    }
    if (attrs.statusCode !== undefined) {
      changes.push({ name: "statusCode", newValue: attrs.statusCode });
    }
    if (attrs.deprecated !== undefined) {
      changes.push({ name: "deprecated", newValue: attrs.deprecated });
    }
    if (attrs.summary !== undefined) {
      changes.push({ name: "summary", newValue: attrs.summary });
    }
    if (attrs.description !== undefined) {
      changes.push({ name: "description", newValue: attrs.description });
    }
    if (attrs.tags !== undefined) {
      changes.push({ name: "tags", newValue: attrs.tags });
    }
    if (attrs.operationId !== undefined) {
      changes.push({ name: "operationId", newValue: attrs.operationId });
    }

    return {
      type: "endpoint.changed",
      path: instruction.path,
      methods: instruction.methods,
      changes,
    };
  }

  return null;
}

/**
 * Convert an enum alteration instruction to a changelog entry.
 */
function convertEnumInstruction(instruction: AlterEnumSubInstruction): ChangelogInstruction | null {
  // `enum().had({member: value})` means the OLD version had this member.
  // Going old -> new, the member was REMOVED in the new version.
  if (instruction.kind === "enum_had_members") {
    return {
      type: "enum.members.removed",
      enum: instruction.enumName,
      members: instruction.members,
    };
  }

  // `enum().didntHave("member")` means the OLD version didn't have this member.
  // Going old -> new, the member was ADDED in the new version.
  if (instruction.kind === "enum_didnt_have_members") {
    return {
      type: "enum.members.added",
      enum: instruction.enumName,
      members: instruction.members,
    };
  }

  return null;
}

/**
 * Generate a structured changelog from the VersionBundle.
 *
 * Iterates through all versions (except the oldest, which has no changes)
 * and their VersionChange classes, collecting schema and endpoint changes.
 *
 * Instructions where isHiddenFromChangelog === true are skipped.
 * VersionChanges that are entirely hidden are also skipped.
 */
export function generateChangelog(versions: VersionBundle): ChangelogResource {
  const changelog: ChangelogResource = { versions: [] };

  // Iterate all versions except the oldest (which has no changes)
  for (const version of versions.versions) {
    if (version.changes.length === 0) continue;

    const versionEntry: ChangelogVersion = {
      value: version.value,
      changes: [],
    };

    for (const change of version.changes) {
      // T-2103: Check if the entire VersionChange is hidden
      if ((change as any).isHiddenFromChangelog === true) {
        continue;
      }

      // T-2101: Check if this change is a VersionChangeWithSideEffects instance
      const hasSideEffects = change instanceof VersionChangeWithSideEffects;

      const versionChange: ChangelogVersionChange = {
        description: change.description,
        sideEffects: hasSideEffects,
        instructions: [],
      };

      // Process schema instructions
      for (const instruction of change._alterSchemaInstructions) {
        if (isHiddenFromChangelog(instruction)) continue;

        const entry = convertSchemaInstruction(instruction);
        if (entry) {
          versionChange.instructions.push(entry);
        }
      }

      // Process endpoint instructions
      for (const instruction of change._alterEndpointInstructions) {
        if (isHiddenFromChangelog(instruction as any)) continue;

        const entry = convertEndpointInstruction(instruction);
        if (entry) {
          versionChange.instructions.push(entry);
        }
      }

      // T-2100: Process enum instructions
      for (const instruction of change._alterEnumInstructions) {
        if (isHiddenFromChangelog(instruction as any)) continue;

        const entry = convertEnumInstruction(instruction);
        if (entry) {
          versionChange.instructions.push(entry);
        }
      }

      versionEntry.changes.push(versionChange);
    }

    changelog.versions.push(versionEntry);
  }

  return changelog;
}
