/**
 * `raw()` — declarative response marker for routes that return binary /
 * streaming content (PDFs, CSVs, images, pre-rendered thumbnails) rather
 * than JSON.
 *
 * tsadwyn already detects Buffer / Readable returns at runtime and sends
 * them with `application/octet-stream`. The marker adds three things:
 *
 *   1. Explicit mime type at registration time (no more octet-stream
 *      default for known formats).
 *   2. A generation-time lint: response migrations that target a raw()
 *      route are dead code because the body is opaque bytes — tsadwyn
 *      warns.
 *   3. A signal for future OpenAPI output to describe the response as
 *      `{type: string, format: binary}` with the correct content-type.
 *
 * Usage:
 *
 *   router.get('/reports/:id/export.pdf', null, raw({mimeType: 'application/pdf'}),
 *     async (req) => reportService.renderPdf(req.params.id)  // returns Buffer
 *   );
 */

import { z } from "zod";

/** Sentinel used to detect raw() markers without attaching enumerable noise. */
export const RAW_RESPONSE_MARKER = Symbol.for("tsadwyn.rawResponse");

export interface RawResponseOptions {
  mimeType: string;
  /**
   * Reserved for a future range-request implementation (§4.5 in the
   * landscape doc). The flag is accepted today but not yet honored —
   * tsadwyn currently streams the full buffer regardless.
   */
  supportsRanges?: boolean;
}

export interface RawResponseMarker {
  readonly mimeType: string;
  readonly supportsRanges: boolean;
}

/**
 * Produce a raw-response marker. The returned value is structurally a
 * Zod schema (so it satisfies the `responseSchema` slot's type signature)
 * with metadata attached for tsadwyn's runtime + generation-time checks.
 */
export function raw(options: RawResponseOptions) {
  const schema = z.any() as any;
  schema.mimeType = options.mimeType;
  schema.supportsRanges = options.supportsRanges ?? false;
  schema[RAW_RESPONSE_MARKER] = true;
  return schema as z.ZodTypeAny & RawResponseMarker;
}

/**
 * Runtime detection: returns the marker's metadata if `schema` was
 * produced by `raw()`, otherwise null.
 */
export function isRawResponse(
  schema: unknown,
): RawResponseMarker | null {
  if (schema && typeof schema === "object" && (schema as any)[RAW_RESPONSE_MARKER]) {
    return {
      mimeType: (schema as any).mimeType,
      supportsRanges: (schema as any).supportsRanges ?? false,
    };
  }
  return null;
}
