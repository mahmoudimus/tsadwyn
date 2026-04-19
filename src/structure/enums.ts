import type { HiddenFromChangelogMixin } from "./schemas.js";
import { z, ZodEnum, ZodNativeEnum } from "zod";
import { getSchemaName } from "../zod-extend.js";

/**
 * A named Zod enum schema reference.
 * We track the schema itself plus a name for registry lookup.
 */
export interface NamedZodEnum {
  schema: ZodEnum<any> | ZodNativeEnum<any>;
  name: string;
}

/**
 * Instruction that an enum had different members in a previous version.
 * Members maps member names to their values.
 */
export interface EnumHadMembersInstruction extends HiddenFromChangelogMixin {
  kind: "enum_had_members";
  enumName: string;
  enumSchema: ZodEnum<any> | ZodNativeEnum<any>;
  members: Record<string, string>;
}

/**
 * Instruction that an enum didn't have certain members in a previous version.
 * Members is an array of member names to remove.
 */
export interface EnumDidntHaveMembersInstruction extends HiddenFromChangelogMixin {
  kind: "enum_didnt_have_members";
  enumName: string;
  enumSchema: ZodEnum<any> | ZodNativeEnum<any>;
  members: string[];
}

export type AlterEnumSubInstruction =
  | EnumHadMembersInstruction
  | EnumDidntHaveMembersInstruction;

/**
 * Factory for creating enum alteration instructions.
 */
export class EnumInstructionFactory {
  constructor(
    public readonly enumSchema: ZodEnum<any> | ZodNativeEnum<any>,
    public readonly enumName: string,
  ) {}

  /**
   * Declares that this enum "had" different/additional members in the previous version.
   * Pass an object mapping member name to member value.
   *
   * Usage: `enum_(MyEnum).had({ memberName: "value" })`
   */
  had(memberToValueMapping: Record<string, string>): EnumHadMembersInstruction {
    return {
      kind: "enum_had_members",
      enumName: this.enumName,
      enumSchema: this.enumSchema,
      members: memberToValueMapping,
      isHiddenFromChangelog: false,
    };
  }

  /**
   * Declares that this enum didn't have certain members in the previous version.
   * Pass member names as arguments.
   *
   * Usage: `enum_(MyEnum).didntHave("memberName")`
   */
  didntHave(...memberNames: string[]): EnumDidntHaveMembersInstruction {
    return {
      kind: "enum_didnt_have_members",
      enumName: this.enumName,
      enumSchema: this.enumSchema,
      members: memberNames,
      isHiddenFromChangelog: false,
    };
  }
}

/**
 * Entry point for the enum alteration DSL.
 * Takes a named Zod enum schema (created with z.enum([...]).named("EnumName")).
 *
 * Usage:
 * ```typescript
 * const MyEnum = z.enum(["A", "B", "C"]).named("MyEnum");
 * enum_(MyEnum).had({ D: "D" })       // D existed in older version
 * enum_(MyEnum).didntHave("C")        // C didn't exist in older version
 * ```
 */
export function enum_(
  zodEnum: (ZodEnum<any> | ZodNativeEnum<any>) & { _tsadwynName?: string },
): EnumInstructionFactory {
  const name = getSchemaName(zodEnum);
  if (!name) {
    throw new Error(
      "Enum schema must have a name. Use `.named('EnumName')` on the Zod enum schema.",
    );
  }
  return new EnumInstructionFactory(zodEnum, name);
}

/**
 * Alias for `enum_` for those who prefer avoiding the underscore.
 */
export const enumeration = enum_;
