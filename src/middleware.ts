import type { Request, Response, NextFunction } from "express";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * AsyncLocalStorage instance that holds the current API version string
 * for the duration of a request.
 */
export const apiVersionStorage = new AsyncLocalStorage<string | null>();

/**
 * Location from which the API version is extracted.
 * - "custom_header": version comes from a request header (default)
 * - "path": version comes from the URL path (e.g., /2024-01-01/users)
 */
export type APIVersionLocation = "custom_header" | "path";

/**
 * Format validation for version strings.
 * - "date": versions must be valid ISO date strings (YYYY-MM-DD)
 * - "string": any string is accepted
 */
export type APIVersionFormat = "date" | "string";

/**
 * Options for the version picking middleware.
 */
export interface VersionPickingOptions {
  headerName: string;
  apiVersionLocation: APIVersionLocation;
  apiVersionDefaultValue: string | ((req: Request) => string | Promise<string>) | null;
  versionValues: string[];
}

/**
 * Extract the version from a request header.
 */
function getVersionFromHeader(req: Request, headerName: string): string | undefined {
  return req.headers[headerName.toLowerCase()] as string | undefined;
}

/**
 * Extract the version from the URL path by matching against known version values.
 */
function getVersionFromPath(req: Request, versionRegex: RegExp): string | undefined {
  const match = versionRegex.exec(req.path);
  if (match) {
    return match[1];
  }
  return undefined;
}

/**
 * Creates Express middleware that extracts the API version from a header or path
 * and stores it in AsyncLocalStorage for the duration of the request.
 *
 * When called with a single string argument (headerName), uses legacy header-only behavior.
 * When called with a VersionPickingOptions object, supports all version location modes.
 */
export function versionPickingMiddleware(
  optionsOrHeaderName: string | VersionPickingOptions,
): (req: Request, res: Response, next: NextFunction) => void {
  // Support legacy single-string usage
  if (typeof optionsOrHeaderName === "string") {
    const headerName = optionsOrHeaderName;
    return (req: Request, res: Response, next: NextFunction) => {
      const version = req.headers[headerName.toLowerCase()] as string | undefined;
      const versionValue = version || null;

      apiVersionStorage.run(versionValue, () => {
        if (versionValue) {
          res.setHeader(headerName, versionValue);
        }
        next();
      });
    };
  }

  const opts = optionsOrHeaderName;
  const headerName = opts.headerName;

  // Build regex for path-based version extraction
  let versionRegex: RegExp | null = null;
  if (opts.apiVersionLocation === "path" && opts.versionValues.length > 0) {
    const escaped = opts.versionValues.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    versionRegex = new RegExp(`/(${escaped.join("|")})/`);
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    let version: string | undefined;

    if (opts.apiVersionLocation === "path") {
      version = versionRegex ? getVersionFromPath(req, versionRegex) : undefined;
    } else {
      version = getVersionFromHeader(req, headerName);
    }

    // Apply default value if no version found
    if (version === undefined && opts.apiVersionDefaultValue !== null) {
      if (typeof opts.apiVersionDefaultValue === "function") {
        version = await opts.apiVersionDefaultValue(req);
      } else if (typeof opts.apiVersionDefaultValue === "string") {
        version = opts.apiVersionDefaultValue;
      }
    }

    const versionValue = version || null;

    apiVersionStorage.run(versionValue, () => {
      if (versionValue) {
        res.setHeader(headerName, versionValue);
      }
      next();
    });
  };
}
