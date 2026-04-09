import { z } from "zod";

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
  z.ZodType.prototype.named = function (this: any, name: string) {
    this._tsadwynName = name;
    return this;
  };
  (z.ZodType.prototype as any)._tsadwynNamedPatched = true;
}

export {};
