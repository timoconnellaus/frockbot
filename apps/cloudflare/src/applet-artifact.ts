/**
 * The one rule about an Applet's server bundle: mismatched bytes never become
 * code. This is that rule as a function, so it can be read and tested apart
 * from the Durable Object that applies it.
 *
 * The bytes live under a content-addressed key, `packages/<sha256>.mjs`, and
 * the write path refuses bytes whose hash is not the key. An activation
 * hashes what it read in full and records the object's R2 etag beside the
 * hash. A later mount that finds the same etag under the same key is holding
 * the very object version that was hashed, so it skips the hash; any other
 * etag, or none recorded, hashes in full and, when the hash holds, becomes the
 * new pin. Nothing is ever loaded that was not hashed against its key.
 */

export interface AppletArtifactObjectV1 {
  etag: string;
  text(): Promise<string>;
}

export interface AppletArtifactVerifiedV1 {
  source: string;
  /** The etag to record: what a later mount compares against. */
  etag: string;
  /** Whether this read hashed the bytes, or trusted the recorded pin. */
  hashed: boolean;
}

export async function sha256HexV1(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifyAppletArtifactV1(input: {
  contentHash: string;
  object: AppletArtifactObjectV1 | null | undefined;
  pinnedEtag?: string;
}): Promise<AppletArtifactVerifiedV1> {
  const { object } = input;
  if (!object) {
    throw new Error(`Applet artifact "${input.contentHash}" is unavailable`);
  }
  const source = await object.text();
  if (input.pinnedEtag !== undefined && input.pinnedEtag === object.etag) {
    return { source, etag: object.etag, hashed: false };
  }
  if ((await sha256HexV1(source)) !== input.contentHash) {
    throw new Error(
      `Applet artifact "${input.contentHash}" failed hash verification`,
    );
  }
  return { source, etag: object.etag, hashed: true };
}
