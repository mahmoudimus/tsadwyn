/**
 * `exceptionMap` — declarative exception→HttpError table with introspection.
 *
 * Replaces the if-chain form of `errorMapper` with a keyed-by-err.name map.
 * Keying by `err.name` string (rather than `instanceof`) survives module-
 * boundary identity traps (Jest `resetModules`, dual package installs,
 * ESM/CJS interop). The returned function is structurally compatible with
 * `TsadwynOptions.errorMapper`, and also carries introspection methods used
 * by the `tsadwyn exceptions` CLI subcommand and runtime audit tooling.
 */

import { HttpError, TsadwynStructureError } from "./exceptions.js";

export type ExceptionMapping =
  | ((err: Error) => HttpError)
  | { status: number; code: string; message?: string }
  | {
      status: number;
      code: string;
      transform: (err: Error) => Record<string, unknown>;
    };

export type ExceptionMapConfig = Record<string, ExceptionMapping>;

export interface ExceptionMapEntry {
  /** Error class name (the map key; also the value matched against err.name). */
  name: string;
  /** Kind of mapping; drives how status/code/hasTransform are rendered. */
  kind: "static" | "function" | "static-with-transform";
  /** Known statically, or null when the mapping is a plain function. */
  status: number | null;
  /** Known statically, or null when the mapping is a plain function. */
  code: string | null;
  /** True when the mapping computes body dynamically. */
  hasTransform: boolean;
}

export interface ExceptionMapFn {
  (err: unknown): HttpError | null;
  readonly registeredNames: readonly string[];
  has(name: string): boolean;
  lookup(name: string): ExceptionMapping | undefined;
  describe(): ReadonlyArray<ExceptionMapEntry>;
}

function isStaticMapping(m: ExceptionMapping): m is {
  status: number;
  code: string;
  message?: string;
} {
  return (
    typeof m === "object" &&
    m !== null &&
    "status" in m &&
    !("transform" in m)
  );
}

function isStaticWithTransform(
  m: ExceptionMapping,
): m is {
  status: number;
  code: string;
  transform: (err: Error) => Record<string, unknown>;
} {
  return (
    typeof m === "object" &&
    m !== null &&
    "status" in m &&
    "transform" in m
  );
}

function validateStatus(name: string, status: number): void {
  if (!Number.isInteger(status) || status < 400 || status >= 600) {
    throw new TsadwynStructureError(
      `exceptionMap: invalid status ${status} for "${name}". ` +
        "Static mappings must use a 4xx or 5xx HTTP status code.",
    );
  }
}

/**
 * Build an `errorMapper`-compatible function from a declarative config.
 */
export function exceptionMap(config: ExceptionMapConfig): ExceptionMapFn {
  // Validate static entries up-front.
  for (const [name, mapping] of Object.entries(config)) {
    if (isStaticMapping(mapping) || isStaticWithTransform(mapping)) {
      validateStatus(name, mapping.status);
    } else if (typeof mapping !== "function") {
      throw new TsadwynStructureError(
        `exceptionMap: mapping for "${name}" must be a function or an object with {status, code, ...}.`,
      );
    }
  }

  const map = new Map<string, ExceptionMapping>(Object.entries(config));

  const fn = function exceptionMapFn(err: unknown): HttpError | null {
    if (!(err instanceof Error)) return null;
    const mapping = map.get(err.name);
    if (!mapping) return null;

    if (typeof mapping === "function") {
      return mapping(err);
    }

    if (isStaticWithTransform(mapping)) {
      const body = { code: mapping.code, ...mapping.transform(err) };
      return new HttpError(mapping.status, body);
    }

    // Plain static form
    return new HttpError(mapping.status, {
      code: mapping.code,
      message: mapping.message ?? err.message,
    });
  } as ExceptionMapFn;

  Object.defineProperty(fn, "registeredNames", {
    get: () => Object.freeze([...map.keys()]),
    enumerable: true,
  });

  fn.has = (name: string): boolean => map.has(name);
  fn.lookup = (name: string): ExceptionMapping | undefined => map.get(name);

  fn.describe = (): ReadonlyArray<ExceptionMapEntry> => {
    const entries: ExceptionMapEntry[] = [];
    for (const [name, mapping] of map) {
      if (typeof mapping === "function") {
        entries.push({
          name,
          kind: "function",
          status: null,
          code: null,
          hasTransform: false,
        });
      } else if (isStaticWithTransform(mapping)) {
        entries.push({
          name,
          kind: "static-with-transform",
          status: mapping.status,
          code: mapping.code,
          hasTransform: true,
        });
      } else {
        entries.push({
          name,
          kind: "static",
          status: mapping.status,
          code: mapping.code,
          hasTransform: false,
        });
      }
    }
    return Object.freeze(entries);
  };

  return fn;
}

/**
 * Merge multiple exception-map configs. Throws on overlapping keys so
 * accidental duplicates don't silently overwrite earlier entries.
 */
exceptionMap.merge = function merge(
  ...configs: ExceptionMapConfig[]
): ExceptionMapConfig {
  const merged: ExceptionMapConfig = {};
  for (const config of configs) {
    for (const name of Object.keys(config)) {
      if (Object.prototype.hasOwnProperty.call(merged, name)) {
        throw new TsadwynStructureError(
          `exceptionMap.merge: duplicate key "${name}" — resolve the collision explicitly before merging.`,
        );
      }
      merged[name] = config[name];
    }
  }
  return merged;
};

/**
 * Check at runtime whether a value is an introspectable ExceptionMapFn
 * (i.e., produced by `exceptionMap()`). Used by the CLI and audit tooling
 * to decide whether to offer introspection.
 */
export function isExceptionMapFn(value: unknown): value is ExceptionMapFn {
  return (
    typeof value === "function" &&
    typeof (value as ExceptionMapFn).describe === "function" &&
    typeof (value as ExceptionMapFn).has === "function" &&
    typeof (value as ExceptionMapFn).lookup === "function"
  );
}
