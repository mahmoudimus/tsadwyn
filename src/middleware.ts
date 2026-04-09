import type { Request, Response, NextFunction } from "express";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * AsyncLocalStorage instance that holds the current API version string
 * for the duration of a request.
 */
export const apiVersionStorage = new AsyncLocalStorage<string | null>();

/**
 * Creates Express middleware that extracts the API version from a header
 * and stores it in AsyncLocalStorage for the duration of the request.
 */
export function versionPickingMiddleware(
  headerName: string = "x-api-version",
): (req: Request, res: Response, next: NextFunction) => void {
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
