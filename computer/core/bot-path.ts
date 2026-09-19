import { createHash } from "node:crypto";

/**
 * A stable, provider-neutral directory name for one Bot inside a User-scoped
 * durable root.
 *
 * A Package that files something per Bot under a root the whole User shares
 * needs a name that is the same on every Computer and on every provider, so it
 * is derived here rather than borrowed from whichever provider happens to be
 * mounted. It is a path segment, never an identity: the writer of a file is
 * what the generation records.
 *
 * This file is a leaf on purpose. The Computer host container imports it and
 * Node 24 only strips types there, so it cannot pull `@frockbot/core/contracts`
 * or `ComputerError`'s TypeScript parameter properties.
 */
export function computerBotPathKeyV1(
  botId: string,
  digest: (value: string) => string = (value) =>
    createHash("sha256").update(value).digest("hex"),
): string {
  const id = botId.trim();
  if (!id || id.length > 200)
    throw new Error("Computer Bot id must contain 1-200 characters");
  const digestHex = digest(id);
  if (!/^[a-f0-9]{64}$/.test(digestHex))
    throw new Error("Computer Bot key requires a SHA-256 hex digest");
  const slug = id
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  return `${slug || "bot"}-${digestHex.slice(0, 12)}`;
}
