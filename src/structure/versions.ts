import type { AlterSchemaSubInstruction } from "./schemas.js";
import type { AlterEndpointSubInstruction } from "./endpoints.js";
import type { AlterEnumSubInstruction } from "./enums.js";
import type {
  AlterRequestBySchemaInstruction,
  AlterResponseBySchemaInstruction,
  AlterRequestByPathInstruction,
  AlterResponseByPathInstruction,
} from "./data.js";
import { TsadwynError, TsadwynStructureError } from "../exceptions.js";
import { apiVersionStorage } from "../middleware.js";

export type PossibleInstruction =
  | AlterSchemaSubInstruction
  | AlterEndpointSubInstruction
  | AlterEnumSubInstruction;

/** Set of all known instruction `kind` values for validation. */
const KNOWN_INSTRUCTION_KINDS = new Set([
  "field_had",
  "field_didnt_exist",
  "field_existed_as",
  "field_didnt_have",
  "schema_had",
  "validator_existed",
  "validator_didnt_exist",
  "endpoint_didnt_exist",
  "endpoint_existed",
  "endpoint_had",
  "enum_had_members",
  "enum_didnt_have_members",
  // T-1802: Computed field instructions
  "computed_field_existed",
  "computed_field_didnt_exist",
]);

/** Set of kind values for migration instructions (found as own-properties on VersionChange instances). */
const KNOWN_MIGRATION_INSTRUCTION_KINDS = new Set([
  "alter_request_by_schema",
  "alter_response_by_schema",
  "alter_request_by_path",
  "alter_response_by_path",
]);

/** Set of allowed own-property names on a VersionChange instance. */
const ALLOWED_VERSION_CHANGE_PROPERTIES = new Set([
  "description",
  "instructions",
  "isHiddenFromChangelog",
  // Internal categorized instruction arrays
  "_alterSchemaInstructions",
  "_alterEndpointInstructions",
  "_alterEnumInstructions",
  "_alterRequestBySchemaInstructions",
  "_alterResponseBySchemaInstructions",
  "_alterRequestByPathInstructions",
  "_alterResponseByPathInstructions",
]);

/**
 * Base class for version changes. Subclasses describe what changed
 * between two adjacent API versions.
 *
 * In the Python version this is a metaclass-based approach with ClassVars.
 * In TypeScript we use a conventional class with static-like semantics
 * obtained through instance properties set in the constructor or via
 * decorators.
 *
 * NOTE: VersionChange is not meant to be used directly. Always create a
 * subclass that sets `description` and `instructions`.
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
  _alterEnumInstructions: AlterEnumSubInstruction[] = [];
  _alterRequestBySchemaInstructions: Map<string, AlterRequestBySchemaInstruction[]> = new Map();
  _alterResponseBySchemaInstructions: Map<string, AlterResponseBySchemaInstruction[]> = new Map();
  _alterRequestByPathInstructions: Map<string, AlterRequestByPathInstruction[]> = new Map();
  _alterResponseByPathInstructions: Map<string, AlterResponseByPathInstruction[]> = new Map();

  /**
   * Tracks which VersionBundle this change has been bound to.
   * Used to prevent double-binding and to support `VersionChangeWithSideEffects.isApplied`.
   */
  static _boundToBundle: VersionBundle | null = null;

  /**
   * The version value this change is associated with (set during VersionBundle construction).
   */
  static _boundVersion: string | null = null;

  /**
   * T-1608: Flag set by Version/HeadVersion constructors to permit instantiation.
   * VersionChange cannot be instantiated directly by users.
   */
  static _constructing: boolean = false;

  constructor() {
    // T-1608: Prevent direct instantiation by users.
    // Only Version and HeadVersion constructors may instantiate VersionChange subclasses.
    if (!VersionChange._constructing) {
      throw new TypeError(
        `Can't instantiate ${this.constructor.name} as it was never meant to be instantiated.`,
      );
    }
  }
}

/**
 * T-2103: Set isHiddenFromChangelog on the prototype so it can be overridden
 * by subclass prototypes via hidden() without being shadowed by own-property initialization.
 * We use prototype assignment rather than a class property initializer because TypeScript
 * class property initializers create own properties on each instance, which would shadow
 * any prototype-level value set by hidden(MyVersionChange).
 */
(VersionChange.prototype as any).isHiddenFromChangelog = false;

/**
 * Extract and categorize instructions + migration decorators from a VersionChange instance.
 */
export function _extractInstructions(change: VersionChange): void {
  // Categorize list instructions
  for (const instruction of change.instructions) {
    if (
      instruction.kind === "field_had" ||
      instruction.kind === "field_didnt_exist" ||
      instruction.kind === "field_existed_as" ||
      instruction.kind === "field_didnt_have" ||
      instruction.kind === "schema_had" ||
      instruction.kind === "validator_existed" ||
      instruction.kind === "validator_didnt_exist" ||
      instruction.kind === "computed_field_existed" ||
      instruction.kind === "computed_field_didnt_exist"
    ) {
      change._alterSchemaInstructions.push(instruction);
    } else if (
      instruction.kind === "endpoint_didnt_exist" ||
      instruction.kind === "endpoint_existed" ||
      instruction.kind === "endpoint_had"
    ) {
      change._alterEndpointInstructions.push(instruction);
    } else if (
      instruction.kind === "enum_had_members" ||
      instruction.kind === "enum_didnt_have_members"
    ) {
      change._alterEnumInstructions.push(instruction as AlterEnumSubInstruction);
    }
  }

  // Extract body migration instructions from decorated methods or function-wrapper properties.
  // Decorator mode: rewrites a prototype method's value to an instruction object.
  // Function-wrapper mode: assigns instruction objects as instance properties.
  // We scan both the prototype and the instance's own properties.
  const proto = Object.getPrototypeOf(change);
  const protoKeys = Object.getOwnPropertyNames(proto).filter(
    (k) => k !== "constructor",
  );
  const instanceKeys = Object.getOwnPropertyNames(change).filter(
    (k) =>
      k !== "constructor" &&
      k !== "description" &&
      k !== "instructions" &&
      !k.startsWith("_alter"),
  );
  const allKeys = [...new Set([...protoKeys, ...instanceKeys])];

  for (const key of allKeys) {
    const value = (change as any)[key] ?? (proto as any)[key];
    if (value && typeof value === "object" && typeof value.kind === "string") {
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
      } else if (value.kind === "alter_request_by_path") {
        const instr = value as AlterRequestByPathInstruction;
        if (!change._alterRequestByPathInstructions.has(instr.path)) {
          change._alterRequestByPathInstructions.set(instr.path, []);
        }
        change._alterRequestByPathInstructions.get(instr.path)!.push(instr);
      } else if (value.kind === "alter_response_by_path") {
        const instr = value as AlterResponseByPathInstruction;
        if (!change._alterResponseByPathInstructions.has(instr.path)) {
          change._alterResponseByPathInstructions.set(instr.path, []);
        }
        change._alterResponseByPathInstructions.get(instr.path)!.push(instr);
      }
    }
  }
}

/**
 * Validate a VersionChange instance when it is processed by a Version constructor.
 * This performs the runtime checks that Python's `__init_subclass__` handles.
 */
function _validateVersionChange(change: VersionChange, className: string): void {
  // 1. Check if the base VersionChange class is used directly (not subclassed)
  const proto = Object.getPrototypeOf(change);
  if (proto.constructor === VersionChange) {
    throw new TsadwynStructureError(
      "'VersionChange' was used directly instead of being subclassed. " +
      "Create a subclass of VersionChange that sets 'description' and 'instructions'.",
    );
  }

  // 2. description must be set and non-empty
  if (!change.description || change.description.trim() === "") {
    throw new TsadwynStructureError(
      `Version change description is not set on '${className}' but is required.`,
    );
  }

  // 3. instructions must be an array
  if (!Array.isArray(change.instructions)) {
    throw new TsadwynStructureError(
      `Attribute 'instructions' must be an array in '${className}'.`,
    );
  }

  // 4. Each instruction must be a known type (have a recognized `kind`)
  for (const instruction of change.instructions) {
    if (
      !instruction ||
      typeof instruction !== "object" ||
      !("kind" in instruction) ||
      !KNOWN_INSTRUCTION_KINDS.has((instruction as any).kind)
    ) {
      throw new TsadwynStructureError(
        `Instruction '${JSON.stringify(instruction)}' in '${className}' is not a recognized instruction type. ` +
        "Please use the correct instruction types (schema().field().had(), endpoint().didntExist, etc.).",
      );
    }
  }

  // T-1606: Attribute allowlist - scan own-property names of the instance
  // Allow: known property names, and properties whose value is a migration instruction object
  for (const attrName of Object.getOwnPropertyNames(change)) {
    if (ALLOWED_VERSION_CHANGE_PROPERTIES.has(attrName)) {
      continue;
    }
    const attrValue = (change as any)[attrName];
    // Allow migration instruction objects (these get extracted later)
    if (
      attrValue &&
      typeof attrValue === "object" &&
      typeof attrValue.kind === "string" &&
      KNOWN_MIGRATION_INSTRUCTION_KINDS.has(attrValue.kind)
    ) {
      continue;
    }
    throw new TsadwynStructureError(
      `Found: '${attrName}' attribute of type '${typeof attrValue}' in '${className}'. ` +
      "Only migration instructions and schema properties are allowed in version change class body.",
    );
  }
}

/**
 * T-1607: Check that a VersionChange subclass has not been further subclassed.
 * Only one level of subclassing from VersionChange or VersionChangeWithSideEffects is allowed.
 */
function _checkNoSubclassing(Cls: new () => VersionChange): void {
  // Walk the prototype chain to count user-defined classes between Cls and VersionChange/VersionChangeWithSideEffects
  let current = Cls;
  let depth = 0;

  while (current && current !== VersionChange && current !== (VersionChangeWithSideEffects as any)) {
    depth++;
    const parent = Object.getPrototypeOf(current);
    if (parent === current) break;
    current = parent;
  }

  // For a direct subclass of VersionChange, depth should be 1
  // For a direct subclass of VersionChangeWithSideEffects, depth should be 1
  // If depth > 1, it means the class was further subclassed
  if (depth > 1) {
    throw new TypeError(
      `VersionChange subclasses cannot be further subclassed. "${Cls.name}" has too many levels of inheritance.`,
    );
  }
}

/**
 * Represents schema changes applied to the "head" (latest, unreleased) version.
 * HeadVersion changes are applied before any versioned changes during schema generation.
 *
 * HeadVersion does NOT support request or response migration instructions,
 * since it operates outside the versioned request/response lifecycle.
 * It only supports schema/endpoint/enum alteration instructions.
 */
export class HeadVersion {
  changes: VersionChange[];

  /**
   * The raw ChangeClass constructors, stored for binding.
   */
  _changeClasses: Array<new () => VersionChange>;

  constructor(...ChangeClasses: Array<new () => VersionChange>) {
    this._changeClasses = ChangeClasses;
    this.changes = ChangeClasses.map((Cls) => {
      // T-1607: Check for disallowed subclassing depth
      _checkNoSubclassing(Cls);

      // T-1608: Set the constructing flag to permit instantiation
      VersionChange._constructing = true;
      let instance: VersionChange;
      try {
        instance = new Cls();
      } finally {
        VersionChange._constructing = false;
      }
      _validateVersionChange(instance, Cls.name || "AnonymousVersionChange");
      _extractInstructions(instance);

      // Validate: HeadVersion does not support request/response migrations
      if (
        instance._alterRequestBySchemaInstructions.size > 0 ||
        instance._alterResponseBySchemaInstructions.size > 0 ||
        instance._alterRequestByPathInstructions.size > 0 ||
        instance._alterResponseByPathInstructions.size > 0
      ) {
        throw new TsadwynStructureError(
          `HeadVersion does not support request or response migrations but "${Cls.name || "AnonymousVersionChange"}" contained one.`,
        );
      }

      return instance;
    });
  }
}

/**
 * Represents a single API version. Optionally carries version changes
 * that describe how this version differs from the one before it.
 */
export class Version {
  value: string;
  changes: VersionChange[];

  /**
   * The raw ChangeClass constructors, stored for VersionBundle binding.
   */
  _changeClasses: Array<new () => VersionChange>;

  constructor(value: string, ...ChangeClasses: Array<new () => VersionChange>) {
    this.value = value;
    this._changeClasses = ChangeClasses;
    this.changes = ChangeClasses.map((Cls) => {
      // T-1607: Check for disallowed subclassing depth
      _checkNoSubclassing(Cls);

      // T-1608: Set the constructing flag to permit instantiation
      VersionChange._constructing = true;
      let instance: VersionChange;
      try {
        instance = new Cls();
      } finally {
        VersionChange._constructing = false;
      }
      _validateVersionChange(instance, Cls.name || "AnonymousVersionChange");
      _extractInstructions(instance);
      return instance;
    });
  }
}

/**
 * Regex for validating ISO date strings (YYYY-MM-DD).
 */
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Check if a string is a valid ISO date (YYYY-MM-DD) that represents a real calendar date.
 */
function isValidISODate(value: string): boolean {
  if (!ISO_DATE_REGEX.test(value)) {
    return false;
  }
  const parsed = new Date(value + "T00:00:00Z");
  if (isNaN(parsed.getTime())) {
    return false;
  }
  // Verify the parsed date matches the input (catches e.g. "2024-02-30")
  const [y, m, d] = value.split("-").map(Number);
  return (
    parsed.getUTCFullYear() === y &&
    parsed.getUTCMonth() + 1 === m &&
    parsed.getUTCDate() === d
  );
}

export type ApiVersionFormat = "date" | "string";

/**
 * A bundle of all API versions, ordered from latest to oldest.
 * Optionally accepts a HeadVersion as the first argument.
 */
export class VersionBundle {
  versions: Version[];
  reversedVersions: Version[];
  versionValues: string[];
  reversedVersionValues: string[];

  /**
   * Head version changes applied before any versioned changes.
   * If no HeadVersion is provided, this is an empty HeadVersion.
   */
  headVersion: HeadVersion;

  /**
   * Internal mapping from VersionChange constructor to its version value.
   * Used by VersionChangeWithSideEffects.isApplied.
   */
  _versionChangesToVersionMapping: Map<new () => VersionChange, string> = new Map();

  constructor(...args: Array<HeadVersion | Version | { apiVersionFormat?: ApiVersionFormat }>) {
    // Parse out optional HeadVersion from the beginning and options object from the end
    let headVersion: HeadVersion | null = null;
    let versions: Version[];
    let apiVersionFormat: ApiVersionFormat | undefined;

    // Collect all arguments, separating HeadVersion, Version[], and options
    const allArgs = [...args];

    // Check if first arg is a HeadVersion
    if (allArgs.length > 0 && allArgs[0] instanceof HeadVersion) {
      headVersion = allArgs.shift() as HeadVersion;
    }

    // Check if last remaining arg is an options object
    if (
      allArgs.length > 0 &&
      allArgs[allArgs.length - 1] !== null &&
      typeof allArgs[allArgs.length - 1] === "object" &&
      !(allArgs[allArgs.length - 1] instanceof Version) &&
      !(allArgs[allArgs.length - 1] instanceof HeadVersion)
    ) {
      const options = allArgs.pop() as { apiVersionFormat?: ApiVersionFormat };
      apiVersionFormat = options.apiVersionFormat;
    }

    versions = allArgs as Version[];
    this.headVersion = headVersion ?? new HeadVersion();

    if (versions.length === 0) {
      throw new TsadwynStructureError("You must define at least one version in a VersionBundle.");
    }

    // Validate: last version (oldest) must not have changes
    const oldest = versions[versions.length - 1];
    if (oldest.changes.length > 0) {
      throw new TsadwynStructureError(
        `The first (oldest) version "${oldest.value}" cannot have any version changes. ` +
        "Version changes describe how to migrate to/from a previous version, " +
        "so the very first version cannot have any.",
      );
    }

    // Validate: no duplicate version values (before sort validation for better error messages)
    const seen = new Set<string>();
    for (const v of versions) {
      if (seen.has(v.value)) {
        throw new TsadwynStructureError(
          `Duplicate version value "${v.value}" in VersionBundle.`,
        );
      }
      seen.add(v.value);
    }

    // T-1003: Validate version format (only when explicitly requested)
    if (apiVersionFormat === "date") {
      for (const v of versions) {
        if (!isValidISODate(v.value)) {
          throw new TsadwynStructureError(
            `Version value "${v.value}" is not a valid ISO date (YYYY-MM-DD).`,
          );
        }
      }

      // Validate versions are sorted newest-first
      for (let i = 0; i < versions.length - 1; i++) {
        if (versions[i].value <= versions[i + 1].value) {
          throw new TsadwynStructureError(
            `Versions must be sorted from newest to oldest, but "${versions[i].value}" ` +
            `is not newer than "${versions[i + 1].value}".`,
          );
        }
      }
    }

    // T-1002: Bind VersionChange classes to this bundle.
    // T-1602: Prevent double-binding to a different bundle.
    for (const version of versions) {
      for (const Cls of version._changeClasses) {
        const clsAny = Cls as any;
        if (clsAny._boundToBundle !== null && clsAny._boundToBundle !== this) {
          throw new TsadwynStructureError(
            `VersionChange "${Cls.name}" is already bound to a different VersionBundle. ` +
            "A VersionChange can only belong to one VersionBundle.",
          );
        }
        // Bind to this bundle
        clsAny._boundToBundle = this;
        clsAny._boundVersion = version.value;

        // Track mapping from change class to version value
        this._versionChangesToVersionMapping.set(Cls, version.value);
      }
    }

    this.versions = versions;
    this.reversedVersions = [...versions].reverse();
    this.versionValues = versions.map((v) => v.value);
    this.reversedVersionValues = [...this.versionValues].reverse();
  }
}

/**
 * A VersionChange subclass that supports checking whether the change
 * is "applied" (active) for the current request's API version.
 *
 * Use this when you need conditional behavior in your application code
 * based on which version the client is requesting.
 *
 * The `isApplied` static getter reads the current API version from
 * AsyncLocalStorage and compares it to the version this change belongs to.
 */
export class VersionChangeWithSideEffects extends VersionChange {
  /**
   * Returns true if this version change is active for the current request.
   *
   * - Returns true if no version is set (unversioned/internal request).
   * - Returns true if the change's version >= current request version
   *   (meaning the change has been applied for this version).
   * - Throws TsadwynError if this change hasn't been bound to a VersionBundle.
   */
  static get isApplied(): boolean {
    const clsAny = this as any;

    if (!clsAny._boundToBundle || !clsAny._boundVersion) {
      throw new TsadwynError(
        `You tried to check whether '${this.name}' is active but it was never bound to any version. ` +
        "Make sure this VersionChange is included in a VersionBundle.",
      );
    }

    const currentVersion = apiVersionStorage.getStore();

    // If no version is set (unversioned request), side effects are always applied
    if (currentVersion === undefined || currentVersion === null) {
      return true;
    }

    // The change is applied if its version >= the current request version
    // (versions are strings that compare lexicographically, which works for ISO dates)
    return clsAny._boundVersion >= currentVersion;
  }
}
