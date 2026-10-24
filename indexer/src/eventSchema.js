import { z } from "zod";

/**
 * Strict shape of a raw event as returned by SorobanRpc.getEvents().
 * `topic` and `value` are XDR ScVal objects; they are checked structurally
 * so malformed payloads are rejected before reaching decode().
 */
const scVal = z.custom((v) => v !== null && typeof v === "object", "expected ScVal object");

export const rawEventSchema = z.object({
  contractId: z.string().min(1),
  topic: z.array(scVal),
  value: scVal,
  ledger: z.number().int().nonnegative(),
  txHash: z.string().min(1).optional(),
});

/**
 * Validate a raw ledger event.
 *
 * @param {unknown} ev
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateRawEvent(ev) {
  const result = rawEventSchema.safeParse(ev);
  if (result.success) {
    return { ok: true };
  }
  const reason = result.error.issues
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
  return { ok: false, reason };
}
