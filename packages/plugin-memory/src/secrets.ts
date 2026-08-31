// "Memory contains no secrets and no credential references."
//
// This is Package policy and it is only here. `kernel-contracts` deliberately
// declares nothing about it, because the kernel's file contract carries bytes
// and cannot classify them; the Memory Package owns what may be written into a
// Memory root, so the refusal belongs at its write path.
//
// The check is deliberately bounded and deliberately shallow. It refuses
// *obvious credential shapes* — the ones a model pastes into a fact because it
// just read them out of a config file — and it makes no claim to be a secret
// scanner. A determined encoding gets through, and that is the honest bound:
// the rule it enforces is "do not write the API key into Memory", not "prove
// this string holds no entropy". A refusal is a declared outcome the tool
// reports, never a throw and never a silent redaction, because a Bot told its
// fact was refused can write a different one.
//
// Bounded in the other sense too: every pattern is anchored and linear, so a
// hostile fact cannot make the check itself expensive.

/** One refusal: the pattern that matched, in words a Bot can act on. */
export interface MemorySecretRefusalV1 {
  reason: string;
}

interface SecretPattern {
  pattern: RegExp;
  reason: string;
}

const PATTERNS: SecretPattern[] = [
  {
    pattern: /-----BEGIN [A-Z ]{0,40}(PRIVATE KEY|CERTIFICATE)-----/,
    reason: "it contains a PEM private key or certificate block",
  },
  {
    pattern: /\bsk-[A-Za-z0-9_-]{16,}/,
    reason: 'it contains an "sk-" style API key',
  },
  {
    pattern: /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
    reason: "it contains a GitHub token",
  },
  {
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
    reason: "it contains a Slack token",
  },
  {
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    reason: "it contains an AWS access key id",
  },
  {
    pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}/,
    reason: "it contains a bearer token",
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
    reason: "it contains a JSON Web Token",
  },
  {
    pattern:
      /\b(api[_-]?key|secret|password|passwd|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*\S{12,}/i,
    reason: "it assigns a value to a credential-shaped name",
  },
];

/**
 * Answers a refusal when a fact looks like a credential, and `undefined`
 * otherwise. Pure and total: the same text always gets the same answer, and no
 * input throws.
 */
export function refuseMemorySecretV1(
  text: string,
): MemorySecretRefusalV1 | undefined {
  // Bounded input: a fact is already length-capped by the tool, and the slice
  // makes that bound the scanner's bound too rather than a caller's promise.
  const candidate = text.slice(0, 8_192);
  for (const entry of PATTERNS) {
    if (entry.pattern.test(candidate)) {
      return {
        reason: `Memory contains no secrets and no credential references, and ${entry.reason}`,
      };
    }
  }
  return undefined;
}
