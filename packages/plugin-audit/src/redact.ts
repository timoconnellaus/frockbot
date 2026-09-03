// What an audit entry is allowed to carry out of a tool call.
//
// The constitution is explicit and this module is where it is enforced:
// "No secret lives on the Workspace except the User's browser profile … Code
// running on the Computer receives every other credential only as an opaque,
// expiring lease" (`AGENTS.md` § Computer and Workspace), and "client bundles
// and protocols contain no secrets" (§ Architecture checks). An audit table is
// durable state a person reads, so it gets the digest and a redacted preview,
// never the arguments.
//
// Three refusals, in order of how badly they would fail:
//
//  1. `env` is never projected. The Computer host's exec op carries an `env`
//     map (`computer-host-protocol/src/protocol.ts`), which is exactly where a
//     leased credential would be; the preview is built from a per-kind
//     allowlist of fields, so `env` is absent because it was never reachable,
//     not because a filter removed it.
//  2. `credentialRef` is never projected, for the same reason and by the same
//     mechanism.
//  3. Whatever survives runs through the shared credential-shape table
//     (`@frockbot/secret-shapes`), matched substrings replaced with
//     `[redacted:<id>]`.
//
// HONEST BOUND, stated as `plugin-memory/src/secrets.ts` states it: step 3 is
// a shape matcher, not a secret scanner, and a determined encoding gets
// through it. Steps 1 and 2 are not — they are structural, and they are what
// the rule actually rests on.
import { redactSecretShapesV1 } from "@frockbot/secret-shapes";
import { AUDIT_MAX_PREVIEW_LENGTH_V1, type AuditKindV1 } from "./shared.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The fields each kind may show, in the order they read best.
 *
 * An allowlist rather than a denylist: a Package that adds an argument gets no
 * preview for it until somebody names it here, which is the failure direction
 * worth having.
 */
const PREVIEW_FIELDS: Record<AuditKindV1, readonly string[]> = {
  shell: ["command", "machineId"],
  browser: ["action", "url", "role", "name", "label", "key"],
  process: ["action", "command", "processId", "machineId"],
  // No `text`: it previewed up to 200 characters of a `memory_write` or
  // `skill_write` body into a durable table a person reads later. What was
  // written is the Workspace's business and the digest's; the audit row says
  // where it was written, which is the question an audit answers.
  file: ["path", "root", "project", "packageId", "skill"],
  mcp: [],
};

function render(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

/**
 * The bounded, redacted, human-readable half of an audit entry.
 *
 * Deterministic: same call, same preview, for ever — which is what lets a
 * rebuild reproduce a row written months earlier.
 */
export function auditPreviewV1(
  kind: AuditKindV1,
  toolName: string,
  input: unknown,
): string {
  const parts: string[] = [];
  if (kind === "mcp") {
    // A remote server's arguments are somebody else's schema; there is no
    // allowlist that could be right for all of them, so the preview names the
    // tool and the *shape* of what it was given and stops there.
    parts.push(toolName);
    if (isObject(input)) {
      const keys = Object.keys(input).slice(0, 12).sort();
      if (keys.length > 0) parts.push(`(${keys.join(", ")})`);
    }
  } else {
    for (const field of PREVIEW_FIELDS[kind]) {
      if (!isObject(input)) break;
      const rendered = render(input[field]);
      if (rendered === undefined || rendered.length === 0) continue;
      parts.push(rendered);
    }
    if (parts.length === 0) parts.push(toolName);
  }
  const joined = parts.join(" ").replace(/\s+/g, " ").trim();
  return redactSecretShapesV1(joined).slice(0, AUDIT_MAX_PREVIEW_LENGTH_V1);
}

/**
 * Lowercase hex sha-256 of the exact argument JSON.
 *
 * "Exact" means the value the durable `tool/call` event holds, serialized
 * once: two Turns that issued the same call share a digest, and a person
 * checking whether a command recurred can do so without the table ever having
 * held the command. `undefined` arguments hash as `null` so the digest is
 * total.
 */
export async function auditArgumentDigestV1(input: unknown): Promise<string> {
  const canonical = JSON.stringify(input ?? null) ?? "null";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
