/**
 * `deletedResponseSchema` — produces the Stripe-style deleted-resource
 * response shape.
 *
 * Stripe's `DELETE /v1/customers/{id}` (and every other DELETE in its API)
 * returns **HTTP 200** with `{ id, object, deleted: true }` — NOT 204.
 * RFC 9110 §15.3.5 says a 204 response "cannot contain content", and
 * Node's HTTP writer enforces that at the wire level: bodies written
 * to res.end() on a 204 response are stripped before bytes reach the
 * client. Verified empirically against api.stripe.com.
 *
 * This helper makes the Stripe shape a one-liner and keeps consumers
 * off the 204-with-body footgun. For richer audit envelopes — tracking
 * `deleted_at` / `deleted_by` / etc. — pass `extraFields` and either
 * evolve the shape across versions with a VersionChange or declare it
 * nested under `response:` from the start.
 *
 * Usage:
 *
 *   const DeletedCustomer = deletedResponseSchema("customer")
 *     .named("DeletedCustomer");
 *
 *   router.delete("/customers/:id", null, DeletedCustomer, async (req) => {
 *     const existing = await customers.delete(req.params.id);
 *     return { id: existing.id, object: "customer", deleted: true };
 *   });
 *   // Note: no statusCode override needed — defaults to 200 (correct).
 */

import { z, type ZodRawShape } from "zod";

export function deletedResponseSchema<E extends ZodRawShape = {}>(
  objectName: string,
  extraFields?: E,
) {
  return z.object({
    id: z.string(),
    object: z.literal(objectName),
    deleted: z.literal(true),
    ...(extraFields ?? ({} as E)),
  });
}
