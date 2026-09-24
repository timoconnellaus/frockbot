// Sending one transactional email, for whoever the deployment let ask.
//
// The deployment sends mail, not the thing that asked: a Plugin drafting an
// email holds no credential and names no provider, and the sender here is the
// one place a message actually leaves. Cloudflare Email Service is this
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
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
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
  send(request: EmailSendRequestV1): Promise<EmailSendOutcomeV1>;
}

/**
 * The message builder form of the platform's `send_email` binding,
 * structurally: `SendEmail.send(EmailMessageBuilder)` in
 * `@cloudflare/workers-types`, narrowed to what a note to a person uses.
 */
export interface EmailBindingV1 {
  send(message: {
    from: string;
    to: string[];
    cc?: string[];
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

/**
 * The deployment's sender, when it has one: a `send_email` binding and the
 * address it sends from. Absent either, there is no sender — never a partial
 * one that fails at the moment a person presses Send.
 */
export function createBindingEmailSenderV1(env: {
  SEND_EMAIL?: EmailBindingV1;
  EMAIL_SENDER_ADDRESS?: string;
}): EmailSenderV1 | undefined {
  const binding = env.SEND_EMAIL;
  const address = env.EMAIL_SENDER_ADDRESS?.trim();
  if (!binding || !address) return undefined;
  return {
    async send(request) {
      try {
        const { messageId } = await binding.send({
          from: address,
          to: request.to,
          ...(request.cc && request.cc.length > 0 ? { cc: request.cc } : {}),
          subject: request.subject,
          text: request.body,
          // The reply relationship is the one thing a draft says that
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
