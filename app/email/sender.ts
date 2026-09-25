// Sending one email from a Bot's own address, for whoever the kernel let ask.
//
// The deployment sends mail, not the thing that asked: a Plugin drafting an
// email holds no credential and names no provider, and the sender here is the
// one place a message actually leaves. Every message is from a Bot's address
// on the deployment's one email domain, `<bot>.<username>@<domain>`, the same
// address mail to the Bot arrives at. Cloudflare Email Service is this
// deployment's choice (2026-09-15), reached through a `send_email` binding;
// a deployment that has bound none sends nothing and says so, which is what
// the email Plugin then tells the Bot in so many words.
//
// The binding's structured `send` composes the message itself — the headers,
// the encoding, the `Message-ID` — so nothing a draft says is ever written
// into a raw header here. One call is one message to every recipient, which
// the provider accepts or refuses whole.

/** One message, as the kernel accepts it. Addresses are already validated. */
export interface EmailSendRequestV1 {
  /**
   * The Bot sending it: its own address on the deployment's email domain,
   * and its name. Composed by the kernel, never by whoever asked.
   */
  from: { address: string; name: string };
  to: string[];
  cc?: string[];
  /** Where a reply goes when it should reach a person rather than the Bot. */
  replyTo?: string;
  subject: string;
  body: string;
  /** The `Message-ID` this answers, angle brackets and all. */
  inReplyTo?: string;
}

/**
 * What one send came to. `unavailable` means nothing left and the caller may
 * try again once the reason is fixed. `unknown` means the provider may have
 * accepted it: the call failed in a way that does not say, so it is never
 * tried again — a retry could deliver the message twice.
 */
export type EmailSendOutcomeV1 =
  | { status: "sent"; messageId: string }
  | { status: "unavailable"; reason: string }
  | { status: "unknown"; reason: string };

/** The deployment's sender. Structural, so no Package is imported to send. */
export interface EmailSenderV1 {
  /** The one domain every message is sent from. */
  readonly domain: string;
  send(request: EmailSendRequestV1): Promise<EmailSendOutcomeV1>;
}

/**
 * The message builder form of the platform's `send_email` binding,
 * structurally: `SendEmail.send(EmailMessageBuilder)` in
 * `@cloudflare/workers-types`, narrowed to what a note to a person uses.
 */
export interface EmailBindingV1 {
  send(message: {
    from: { email: string; name: string };
    to: string[];
    cc?: string[];
    replyTo?: string;
    subject: string;
    text: string;
    headers?: Record<string, string>;
  }): Promise<{ messageId: string }>;
}

/**
 * The codes Email Service refuses a message with before accepting any of it
 * (developers.cloudflare.com/email-service/api/send-emails/workers-api/, read
 * 2026-09-24). Every other failure — `E_DELIVERY_FAILED`,
 * `E_INTERNAL_SERVER_ERROR`, a thrown error with no code, a dropped
 * connection — does not say whether the message left, so it is `unknown`.
 */
const REFUSED_BEFORE_SENDING_V1: ReadonlySet<string> = new Set([
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_TOO_MANY_RECIPIENTS",
  "E_TOO_MANY_ATTACHMENTS",
  "E_SENDER_NOT_VERIFIED",
  "E_RECIPIENT_NOT_ALLOWED",
  // Only thrown while dropping suppressed recipients is off, when the whole
  // message is refused rather than sent to the rest.
  "E_RECIPIENT_SUPPRESSED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_CONTENT_TOO_LARGE",
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
  "E_HEADER_NOT_ALLOWED",
  "E_HEADER_USE_API_FIELD",
  "E_HEADER_VALUE_INVALID",
  "E_HEADER_VALUE_TOO_LONG",
  "E_HEADER_NAME_INVALID",
  "E_HEADERS_TOO_LARGE",
  "E_HEADERS_TOO_MANY",
]);

/** The platform's words for a failure, and its code when it gave one. */
function failureOf(error: unknown): { code?: string; message: string } {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return {
    ...(typeof code === "string" ? { code } : {}),
    message: error instanceof Error ? error.message : String(error),
  };
}

/** The longest display name a message carries. A Bot's name, not a sentence. */
const DISPLAY_NAME_MAX_V1 = 80;

/**
 * The deployment's sender, when it has one: a `send_email` binding and the
 * email domain. Absent either, there is no sender — never a partial one that
 * fails at the moment a person presses Send.
 *
 * The binding may send from any address on any domain the account onboarded,
 * because it cannot be told "one domain" (`allowed_sender_addresses` is a list
 * of exact addresses), so the domain is held here: a `from` anywhere else is
 * refused before the binding is reached.
 */
export function createBindingEmailSenderV1(env: {
  SEND_EMAIL?: EmailBindingV1;
  EMAIL_DOMAIN?: string;
}): EmailSenderV1 | undefined {
  const binding = env.SEND_EMAIL;
  const domain = env.EMAIL_DOMAIN?.trim().toLowerCase();
  if (!binding || !domain) return undefined;
  return {
    domain,
    async send(request) {
      const address = request.from.address.toLowerCase();
      if (address.slice(address.lastIndexOf("@") + 1) !== domain) {
        return {
          status: "unavailable",
          reason: `the message was not sent: ${address} is not on ${domain}`,
        };
      }
      // The binding writes the header from these parts; what is left to keep
      // out of it is a control character and a name long enough to be a
      // message.
      const name = request.from.name
        .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
        .trim()
        .slice(0, DISPLAY_NAME_MAX_V1);
      try {
        const { messageId } = await binding.send({
          from: { email: address, name },
          to: request.to,
          ...(request.cc && request.cc.length > 0 ? { cc: request.cc } : {}),
          ...(request.replyTo === undefined
            ? {}
            : { replyTo: request.replyTo }),
          subject: request.subject,
          text: request.body,
          // The reply relationship is the one thing a message says that
          // becomes a header, and the kernel has already refused a value
          // carrying a line break.
          ...(request.inReplyTo === undefined
            ? {}
            : {
                headers: {
                  "In-Reply-To": request.inReplyTo,
                  References: request.inReplyTo,
                },
              }),
        });
        return { status: "sent", messageId };
      } catch (error) {
        const failure = failureOf(error);
        const said = `${failure.code === undefined ? "" : `${failure.code}: `}${failure.message}`;
        if (
          failure.code !== undefined &&
          REFUSED_BEFORE_SENDING_V1.has(failure.code)
        ) {
          return {
            status: "unavailable",
            reason: `the message was not sent: ${said}`,
          };
        }
        return {
          status: "unknown",
          reason: `the message may have been sent: ${said}`,
        };
      }
    },
  };
}
