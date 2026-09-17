// Sending one transactional email, for whoever the deployment let ask.
//
// The deployment sends mail, not the thing that asked: a Plugin drafting an
// email holds no credential and names no provider, and the sender here is the
// one place a message actually leaves. Cloudflare Email Service is this
// deployment's choice (2026-09-15), reached through a `send_email` binding;
// a deployment that has bound none sends nothing and says so, which is what
// the email card then draws on its face.
//
// The message is composed here rather than by the caller so every header a
// person could forge — the sender, the reply relationship, the line breaks —
// is written by code that already knows it is untrusted input.

/** One message, as the kernel accepts it. Addresses are already validated. */
export interface EmailSendRequestV1 {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
}

export type EmailSendOutcomeV1 =
  | { status: "sent"; messageId: string }
  | { status: "unavailable"; reason: string };

/** The deployment's sender. Structural, so no Package is imported to send. */
export interface EmailSenderV1 {
  send(request: EmailSendRequestV1): Promise<EmailSendOutcomeV1>;
}

/** What the platform's `send_email` binding takes, structurally. */
export interface EmailBindingV1 {
  send(message: unknown): Promise<void>;
}

/**
 * A `Message-Id` for one send, in the sender's own domain. The id is what an
 * answer quotes in `In-Reply-To`, so it is minted here and returned to the
 * caller rather than left to the provider.
 */
export function emailMessageIdV1(from: string): string {
  const domain = from.slice(from.lastIndexOf("@") + 1);
  return `<${crypto.randomUUID()}@${domain}>`;
}

/** One line of a header, with anything that could start another removed. */
function headerLine(name: string, value: string): string {
  return `${name}: ${value.replace(/[\r\n]+/g, " ")}`;
}

/**
 * The RFC 5322 message one request becomes: plain text, UTF-8, no
 * attachments. A Card's draft is a note to a person.
 */
export function composeEmailMessageV1(
  request: EmailSendRequestV1,
  from: { address: string; displayName?: string; messageId: string },
): string {
  const sender =
    from.displayName === undefined
      ? from.address
      : `${JSON.stringify(from.displayName)} <${from.address}>`;
  const headers = [
    headerLine("From", sender),
    headerLine("To", request.to.join(", ")),
    ...(request.cc && request.cc.length > 0
      ? [headerLine("Cc", request.cc.join(", "))]
      : []),
    headerLine("Subject", request.subject),
    headerLine("Message-ID", from.messageId),
    ...(request.inReplyTo === undefined
      ? []
      : [
          headerLine("In-Reply-To", request.inReplyTo),
          headerLine("References", request.inReplyTo),
        ]),
    headerLine("Date", new Date().toUTCString()),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${request.body.replace(/\r?\n/g, "\r\n")}\r\n`;
}

/**
 * The deployment's sender, when it has one: a `send_email` binding and the
 * address it sends from. Absent either, there is no sender — never a partial
 * one that fails at the moment a person presses Send.
 *
 * `EmailMessage` is imported only when a message is actually sent, and only
 * on a deployment that bound a sender: a static import of a platform module
 * this Worker may not have is a Worker that does not start.
 */
export function createBindingEmailSenderV1(env: {
  SEND_EMAIL?: EmailBindingV1;
  EMAIL_SENDER_ADDRESS?: string;
  EMAIL_SENDER_NAME?: string;
}): EmailSenderV1 | undefined {
  const binding = env.SEND_EMAIL;
  const address = env.EMAIL_SENDER_ADDRESS;
  if (!binding || !address) return undefined;
  return {
    async send(request) {
      const messageId = emailMessageIdV1(address);
      const raw = composeEmailMessageV1(request, {
        address,
        ...(env.EMAIL_SENDER_NAME === undefined
          ? {}
          : { displayName: env.EMAIL_SENDER_NAME }),
        messageId,
      });
      try {
        const { EmailMessage } = (await import("cloudflare:email")) as {
          EmailMessage: new (from: string, to: string, raw: string) => unknown;
        };
        // One message per recipient: the binding takes a single envelope
        // recipient, and a partial send is reported as a failure rather than
        // as a send the caller would read as complete.
        for (const recipient of [...request.to, ...(request.cc ?? [])]) {
          await binding.send(new EmailMessage(address, recipient, raw));
        }
      } catch (error) {
        return {
          status: "unavailable",
          reason: `the message could not be sent: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      return { status: "sent", messageId };
    },
  };
}
