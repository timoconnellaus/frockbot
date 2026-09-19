import type { WorkspaceFailureV1 } from "@frockbot/core/contracts";
import { shellQuote } from "./shell.js";

export interface FlyWorkspaceStageOptionsV1 {
  mount: string;
  name: string;
  bytes: Uint8Array;
  chunkBytes: number;
  stagingRoot: string;
  invalidResponse: string;
  run(script: string): Promise<string | WorkspaceFailureV1>;
}

/**
 * Append bounded chunks to a private staging file.
 *
 * This helper owns only the transport loop and its marker. Callers retain
 * their own generation, lock/CAS, tombstone, and final-rename decisions.
 */
export async function stageFlyWorkspaceBytesV1(
  options: FlyWorkspaceStageOptionsV1,
): Promise<string | WorkspaceFailureV1 | undefined> {
  if (options.bytes.byteLength <= options.chunkBytes) return undefined;
  const staged = options.mount + "/" + options.stagingRoot + "/" + options.name;
  for (
    let offset = 0;
    offset < options.bytes.byteLength;
    offset += options.chunkBytes
  ) {
    const chunk = options.bytes.subarray(offset, offset + options.chunkBytes);
    const output = await options.run(
      [
        "set -eu",
        "STAGE=" + shellQuote(staged),
        'mkdir -p "$(dirname "$STAGE")"',
        ...(offset === 0 ? ['rm -f "$STAGE"'] : []),
        "printf %s " +
          shellQuote(Buffer.from(chunk).toString("base64")) +
          ' | base64 -d >> "$STAGE"',
        'chmod 600 "$STAGE"',
        "echo __STAGED__",
      ].join("\n"),
    );
    if (typeof output !== "string") return output;
    if (!output.includes("__STAGED__")) {
      return {
        status: "unavailable",
        reason: options.invalidResponse.slice(0, 512),
      };
    }
  }
  return staged;
}
