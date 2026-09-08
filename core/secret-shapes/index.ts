// The credential-shape table, in one place.
//
// Two Packages need the same list for two different refusals. Memory refuses a
// fact that looks like a credential outright ("Memory contains no secrets and
// no credential references", `AGENTS.md` § Memory). Audit keeps a bounded
// preview of a tool argument in a durable table and must not carry a
// credential into it ("No secrets in durable logs"). A copied list would drift,
// and the copy that drifted would be the one holding the secret, so the table
// lives here and both import it.
//
// WHAT THIS IS NOT. It is not a secret scanner. It recognises *obvious
// credential shapes* — the ones a model pastes because it just read them out
// of a config file — and makes no claim about entropy. A determined encoding
// gets through. That is the honest bound, and it is stated at both call sites
// as well as here.
//
// Bounded in the other sense too: every pattern is anchored and linear, so a
// hostile input cannot make the check itself expensive.

/** One recognised credential shape. */
export interface SecretShapeV1 {
  /**
   * A stable slug. It is written into durable audit previews as
   * `[redacted:<id>]`, so renaming one changes bytes already on disk: treat it
   * as part of the wire contract, not as a label.
   */
  id: string;
  /** The shape, as a sentence that completes "… because it …". */
  reason: string;
  /**
   * Global so a redaction can replace every occurrence. `lastIndex` is reset
   * by every function here before use, so sharing one object between callers
   * is safe.
   */
  pattern: RegExp;
}

/**
 * The table. Order is significant only in that the first match wins for
 * `matchSecretShapeV1`; redaction applies every pattern.
 */
export const SECRET_SHAPES_V1: readonly SecretShapeV1[] = [
  {
    id: "private-key",
    reason: "it contains a PEM private key or certificate block",
    pattern: /-----BEGIN [A-Z ]{0,40}(PRIVATE KEY|CERTIFICATE)-----/g,
  },
  {
    id: "api-key",
    reason: 'it contains an "sk-" style API key',
    pattern: /\bsk-[A-Za-z0-9_-]{16,}/g,
  },
  {
    id: "github-token",
    reason: "it contains a GitHub token",
    pattern: /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  },
  {
    id: "slack-token",
    reason: "it contains a Slack token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  },
  {
    id: "aws-access-key-id",
    reason: "it contains an AWS access key id",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    id: "bearer-token",
    reason: "it contains a bearer token",
    pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}/g,
  },
  {
    id: "jwt",
    reason: "it contains a JSON Web Token",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    id: "credential-assignment",
    reason: "it assigns a value to a credential-shaped name",
    // The keyword is NOT anchored on `\b`, because `_` is a word character:
    // `\bsecret\b` does not match inside `AWS_SECRET_ACCESS_KEY`, so
    // `AWS_SECRET_ACCESS_KEY=…`, `GITHUB_TOKEN=…` and `MYSQL_PASSWORD=…`
    // landed verbatim in the durable audit preview — the exact shape a leased
    // credential takes in a `computer_exec` command. The name is matched
    // whole, keyword anywhere inside it.
    pattern:
      /(?<![A-Za-z0-9])[A-Za-z0-9_-]{0,64}(?:api[_-]?key|secret|password|passwd|token|credential|passphrase)[A-Za-z0-9_-]{0,64}\s*[:=]\s*\S{8,}/gi,
  },
  {
    id: "url-credentials",
    reason: "it contains credentials in a URL",
    pattern: /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/g,
  },
  {
    id: "url-secret-parameter",
    reason: "it contains a secret in a URL parameter",
    pattern:
      /[?&](?:token|code|sig|signature|key|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|auth)=[^\s&#]{6,}/gi,
  },
];

/** The bound every caller's input is cut to before a pattern sees it. */
export const SECRET_SHAPE_MAX_INPUT_V1 = 8_192;

/** One match, named by the table. */
export interface SecretShapeMatchV1 {
  id: string;
  reason: string;
}

/**
 * The first credential shape `text` carries, or `undefined`.
 *
 * Pure and total: the same text always gets the same answer, and no input
 * throws.
 */
export function matchSecretShapeV1(
  text: string,
): SecretShapeMatchV1 | undefined {
  const candidate = text.slice(0, SECRET_SHAPE_MAX_INPUT_V1);
  for (const shape of SECRET_SHAPES_V1) {
    shape.pattern.lastIndex = 0;
    if (shape.pattern.test(candidate)) {
      return { id: shape.id, reason: shape.reason };
    }
  }
  return undefined;
}

/**
 * Every matched substring replaced by `[redacted:<id>]`.
 *
 * The replacement is deliberately *not* the whole string: a redaction that
 * discarded the surrounding text would make a preview useless, and a preview
 * that survives is what makes an audit row worth keeping. The marker names
 * which shape matched, so a person reading the row can tell a redacted bearer
 * token from a redacted private key without the row carrying either.
 *
 * Deterministic: the same input always produces the same output, which is what
 * lets a settlement-time projection and a rebuild months later agree byte for
 * byte.
 */
export function redactSecretShapesV1(text: string): string {
  let redacted = text.slice(0, SECRET_SHAPE_MAX_INPUT_V1);
  for (const shape of SECRET_SHAPES_V1) {
    shape.pattern.lastIndex = 0;
    redacted = redacted.replace(shape.pattern, `[redacted:${shape.id}]`);
  }
  return redacted;
}
