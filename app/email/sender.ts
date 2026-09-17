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

/**
 * A send is reported by what actually left. One envelope out is a send, and a
 * send is never retried — so a provider that refused recipient two after
 * accepting recipient one answers `sent` and names the second in
 * `undelivered`, rather than an `unavailable` a caller would try again and
 * deliver twice. `unavailable` means nothing left at all.
 */
export type EmailSendOutcomeV1 =
  | { status: "sent"; messageId: string; undelivered?: string[] }
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

/** One header, from a value already sanitised and folded. */
function headerLine(name: string, value: string): string {
  return `${name}: ${value}`;
}

/** Anything that could start another header, removed. */
function headerValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

/**
 * A header value as RFC 2047 encoded-words: UTF-8, Base64, split so that no
 * word passes the 75-octet limit and no multi-byte character is cut in half,
 * and folded onto continuation lines so no header line approaches 998.
 */
function encodedWords(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const words: string[] = [];
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + 45, bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    let binary = "";
    for (const byte of bytes.subarray(start, end))
      binary += String.fromCharCode(byte);
    words.push(`=?utf-8?B?${btoa(binary)}?=`);
    start = end;
  }
  return words.join("\r\n ");
}

/**
 * Text in a header: left exactly as it is while it is plain ASCII, so the
 * common message is the bytes it always was, and encoded when it is not —
 * a header is not covered by the body's `charset`, and a recipient's client
 * reading raw UTF-8 there shows mojibake rather than what was written.
 */
function headerText(value: string): string {
  const sanitised = headerValue(value);
  return /^[\x20-\x7e\t]*$/.test(sanitised)
    ? sanitised
    : encodedWords(sanitised);
}

/**
 * An address list. Every address is ASCII by the validators in front of this
 * seam, which forbid whitespace and angle brackets, so each is emitted as the
 * bare address it is — there is no display name for free text to reach.
 */
function headerAddressList(values: string[]): string {
  return values.map(headerValue).join(", ");
}

/**
 * The RFC 5322 message one request becomes: plain text, UTF-8, no
 * attachments. A Card's draft is a note to a person.
 */
export function composeEmailMessageV1(
  request: EmailSendRequestV1,
  from: { address: string; messageId: string },
): string {
  const headers = [
    headerLine("From", headerValue(from.address)),
    headerLine("To", headerAddressList(request.to)),
    ...(request.cc && request.cc.length > 0
      ? [headerLine("Cc", headerAddressList(request.cc))]
      : []),
    headerLine("Subject", headerText(request.subject)),
    headerLine("Message-ID", headerValue(from.messageId)),
    ...(request.inReplyTo === undefined
      ? []
      : [
          headerLine("In-Reply-To", headerValue(request.inReplyTo)),
          headerLine("References", headerValue(request.inReplyTo)),
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
}): EmailSenderV1 | undefined {
  const binding = env.SEND_EMAIL;
  const address = env.EMAIL_SENDER_ADDRESS;
  if (!binding || !address) return undefined;
  return {
    async send(request) {
      const messageId = emailMessageIdV1(address);
      const raw = composeEmailMessageV1(request, { address, messageId });
      const recipients = [...request.to, ...(request.cc ?? [])];
      const undelivered: string[] = [];
      let delivered = 0;
      let reason = "the message could not be sent";
      try {
        const { EmailMessage } = (await import("cloudflare:email")) as {
          EmailMessage: new (from: string, to: string, raw: string) => unknown;
        };
        // One message per recipient: the binding takes a single envelope
        // recipient. Progress is recorded as it goes, because once one
        // envelope has left the caller must never be told to try again.
        for (const recipient of recipients) {
          try {
            await binding.send(new EmailMessage(address, recipient, raw));
            delivered += 1;
          } catch (error) {
            undelivered.push(recipient);
            reason = `the message could not be sent: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
        }
      } catch (error) {
        return {
          status: "unavailable",
          reason: `the message could not be sent: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      if (delivered === 0) return { status: "unavailable", reason };
      return {
        status: "sent",
        messageId,
        ...(undelivered.length > 0 ? { undelivered } : {}),
      };
    },
  };
}
