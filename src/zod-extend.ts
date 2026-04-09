import { z } from "zod";

/**
 * WeakMap-based schema name registry.
 * Avoids prototype pollution by storing names externally rather than
 * on the schema instance directly.
 */
const schemaNameRegistry = new WeakMap<z.ZodTypeAny, string>();

/**
 * Get the tsadwyn name for a schema, if one has been set.
 */
export function getSchemaName(schema: z.ZodTypeAny | null | undefined): string | null {
  if (!schema) return null;
  // Check WeakMap first, fall back to legacy property for backward compat
  return schemaNameRegistry.get(schema) ?? (schema as any)._tsadwynName ?? null;
}

/**
 * Set the tsadwyn name for a schema in the WeakMap registry.
 */
export function setSchemaName(schema: z.ZodTypeAny, name: string): void {
  schemaNameRegistry.set(schema, name);
  // Also set the legacy property for backward compatibility with code
  // that reads ._tsadwynName directly
  (schema as any)._tsadwynName = name;
}

/**
 * Extend all ZodType instances with a `.named()` method that attaches
 * a name to the schema for use with tsadwyn's versioning system.
 *
 * This must be imported before using `.named()` on any Zod schema.
 */
declare module "zod" {
  interface ZodType<Output = any, Def extends z.ZodTypeDef = z.ZodTypeDef, Input = Output> {
    _tsadwynName?: string;
    named(name: string): this;
  }
}

// Patch the prototype once
if (!(z.ZodType.prototype as any)._tsadwynNamedPatched) {
  z.ZodType.prototype.named = function (this: z.ZodTypeAny, name: string) {
    setSchemaName(this, name);
    return this;
  };
  (z.ZodType.prototype as any)._tsadwynNamedPatched = true;
}

export {};
