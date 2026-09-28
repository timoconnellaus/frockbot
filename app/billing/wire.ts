import { BillingError } from "./errors.js";

/**
 * Reading what billing is sent: a JSON object, and a body no longer than
 * billing will read. Shared by the gateway's routes and a payments Package's.
 */
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BillingError("Invalid payment response", 502);
  return value as Record<string, unknown>;
}

export async function boundedText(
  response: Response | Request,
  maximum = 1_048_576,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new BillingError("Payment payload is too large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(result);
}
