export interface BoundedResponseBytesOptionsV1 {
  /** Error text used when the streamed body crosses the byte bound. */
  oversizedMessage?: string;
  /** Preserve whether a provider lets reader.cancel() reject. */
  cancelOnLimit?: "propagate" | "ignore";
  /** Read and truncate a diagnostic body instead of rejecting it. */
  truncate?: boolean;
  /** Preserve callers that cancel even after a clean end-of-stream. */
  cancelAfterRead?: boolean;
}

/**
 * Read a response body without allowing an unbounded provider answer.
 *
 * This is intentionally local to Ollama's HTTP clients: its callers own the
 * user-facing parse and error wrappers, while this helper owns only byte
 * accumulation and stream cancellation.
 */
export async function boundedResponseBytesV1(
  response: Response,
  maximum: number,
  options: BoundedResponseBytesOptionsV1 = {},
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  const oversizedMessage = options.oversizedMessage ?? "response is too large";
  if (
    !options.truncate &&
    Number.isFinite(declaredLength) &&
    declaredLength > maximum
  ) {
    throw new Error(oversizedMessage);
  }

  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      if (options.cancelAfterRead) {
        await reader.cancel().catch(() => undefined);
      }
      break;
    }
    length += chunk.value.byteLength;
    if (!options.truncate && length > maximum) {
      if (options.cancelOnLimit === "ignore") {
        await reader.cancel().catch(() => undefined);
      } else {
        await reader.cancel();
      }
      throw new Error(oversizedMessage);
    }
    chunks.push(chunk.value);
    if (options.truncate && length > maximum) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const bytes = new Uint8Array(
    options.truncate ? Math.min(length, maximum) : length,
  );
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= bytes.byteLength) break;
    const copy = Math.min(chunk.byteLength, bytes.byteLength - offset);
    bytes.set(chunk.subarray(0, copy), offset);
    offset += copy;
  }
  return bytes;
}
