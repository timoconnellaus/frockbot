// "Memory contains no secrets and no credential references."
//
// This is Package policy and it is only here. `kernel-contracts` deliberately
// declares nothing about it, because the kernel's file contract carries bytes
// and cannot classify them; the Memory Package owns what may be written into a
// Memory root, so the refusal belongs at its write path.
//
// The *shapes* it recognises are not owned here. They live in
// `@frockbot/secret-shapes`, because the Audit Package needs the same list to
// redact a durable preview and two drifting copies of a redaction list is the
// failure mode worth one small package. What is owned here is the policy: a
// match is a refusal, in words a Bot can act on.
//
// The check is deliberately bounded and deliberately shallow. It refuses
// *obvious credential shapes* — the ones a model pastes into a fact because it
// just read them out of a config file — and it makes no claim to be a secret
// scanner. A determined encoding gets through, and that is the honest bound:
// the rule it enforces is "do not write the API key into Memory", not "prove
// this string holds no entropy". A refusal is a declared outcome the tool
// reports, never a throw and never a silent redaction, because a Bot told its
// fact was refused can write a different one.
import { matchSecretShapeV1 } from "@frockbot/secret-shapes";

/** One refusal: the pattern that matched, in words a Bot can act on. */
export interface MemorySecretRefusalV1 {
  reason: string;
}

/**
 * Answers a refusal when a fact looks like a credential, and `undefined`
 * otherwise. Pure and total: the same text always gets the same answer, and no
 * input throws.
 */
export function refuseMemorySecretV1(
  text: string,
): MemorySecretRefusalV1 | undefined {
  // Bounded input: a fact is already length-capped by the tool, and the shared
  // table caps its own input too, so the bound is the scanner's rather than a
  // caller's promise.
  const match = matchSecretShapeV1(text);
  if (!match) return undefined;
  return {
    reason: `Memory contains no secrets and no credential references, and ${match.reason}`,
  };
}
