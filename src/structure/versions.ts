import type { AlterSchemaSubInstruction } from "./schemas.js";
import type { AlterEndpointSubInstruction } from "./endpoints.js";
import type {
  AlterRequestBySchemaInstruction,
  AlterResponseBySchemaInstruction,
} from "./data.js";

export type PossibleInstruction =
  | AlterSchemaSubInstruction
  | AlterEndpointSubInstruction;

/**
 * Base class for version changes. Subclasses describe what changed
 * between two adjacent API versions.
 *
 * In the Python version this is a metaclass-based approach with ClassVars.
 * In TypeScript we use a conventional class with static-like semantics
 * obtained through instance properties set in the constructor or via
 * decorators.
 */
export class VersionChange {
  /** Human-readable description of what changed. */
  description: string = "";

  /**
   * Schema/endpoint alteration instructions that describe how to
   * migrate the schema/endpoint definitions to the *previous* version.
   */
  instructions: PossibleInstruction[] = [];

  // These are populated by _extractInstructions after construction.
  _alterSchemaInstructions: AlterSchemaSubInstruction[] = [];
  _alterEndpointInstructions: AlterEndpointSubInstruction[] = [];
  _alterRequestBySchemaInstructions: Map<string, AlterRequestBySchemaInstruction[]> = new Map();
  _alterResponseBySchemaInstructions: Map<string, AlterResponseBySchemaInstruction[]> = new Map();
}

/**
 * Extract and categorize instructions + migration decorators from a VersionChange instance.
 */
export function _extractInstructions(change: VersionChange): void {
  // Categorize list instructions
  for (const instruction of change.instructions) {
    if (
      instruction.kind === "field_had" ||
      instruction.kind === "field_didnt_exist"
    ) {
      change._alterSchemaInstructions.push(instruction);
    } else if (
      instruction.kind === "endpoint_didnt_exist" ||
      instruction.kind === "endpoint_existed" ||
      instruction.kind === "endpoint_had"
    ) {
      change._alterEndpointInstructions.push(instruction);
    }
  }

  // Extract body migration instructions from decorated methods.
  // When a TypeScript decorator rewrites a method value to an instruction object,
  // we find those objects by iterating over own property names.
  const proto = Object.getPrototypeOf(change);
  const propertyNames = Object.getOwnPropertyNames(proto).filter(
    (k) => k !== "constructor",
  );

  for (const key of propertyNames) {
    const value = (proto as any)[key];
    if (value && typeof value === "object") {
      if (value.kind === "alter_request_by_schema") {
        const instr = value as AlterRequestBySchemaInstruction;
        for (const schemaName of instr.schemaNames) {
          if (!change._alterRequestBySchemaInstructions.has(schemaName)) {
            change._alterRequestBySchemaInstructions.set(schemaName, []);
          }
          change._alterRequestBySchemaInstructions.get(schemaName)!.push(instr);
        }
      } else if (value.kind === "alter_response_by_schema") {
        const instr = value as AlterResponseBySchemaInstruction;
        for (const schemaName of instr.schemaNames) {
          if (!change._alterResponseBySchemaInstructions.has(schemaName)) {
            change._alterResponseBySchemaInstructions.set(schemaName, []);
          }
          change._alterResponseBySchemaInstructions.get(schemaName)!.push(instr);
        }
      }
    }
  }
}

/**
 * Represents a single API version. Optionally carries version changes
 * that describe how this version differs from the one before it.
 */
export class Version {
  value: string;
  changes: VersionChange[];

  constructor(value: string, ...ChangeClasses: Array<new () => VersionChange>) {
    this.value = value;
    this.changes = ChangeClasses.map((Cls) => {
      const instance = new Cls();
      _extractInstructions(instance);
      return instance;
    });
  }
}

/**
 * A bundle of all API versions, ordered from latest to oldest.
 */
export class VersionBundle {
  versions: Version[];
  reversedVersions: Version[];
  versionValues: string[];
  reversedVersionValues: string[];

  constructor(...versions: Version[]) {
    if (versions.length === 0) {
      throw new Error("You must define at least one version in a VersionBundle.");
    }

    // Validate: last version (oldest) must not have changes
    const oldest = versions[versions.length - 1];
    if (oldest.changes.length > 0) {
      throw new Error(
        `The first (oldest) version "${oldest.value}" cannot have any version changes. ` +
        "Version changes describe how to migrate to/from a previous version, " +
        "so the very first version cannot have any.",
      );
    }

    // Validate: no duplicate version values
    const seen = new Set<string>();
    for (const v of versions) {
      if (seen.has(v.value)) {
        throw new Error(
          `Duplicate version value "${v.value}" in VersionBundle.`,
        );
      }
      seen.add(v.value);
    }

    this.versions = versions;
    this.reversedVersions = [...versions].reverse();
    this.versionValues = versions.map((v) => v.value);
    this.reversedVersionValues = [...this.versionValues].reverse();
  }
}
