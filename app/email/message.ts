// One email, read: who wrote it, what it says without the quoted thread and
// the signature under it, and the files it carries.
//
// Parsing is `postal-mime`, bundled. Everything after it is small and
// deliberately conservative: a reply's quoted history is cut at the line that
// introduces it, a signature at its standard delimiter or a phone's footer,
// and anything forwarded is kept, because a forward is usually the point.

import PostalMime, { addressParser } from "postal-mime";
import type { EmailHeaderV1 } from "./authentication.js";
import { normalizeSenderAddressV1 } from "./shared.js";

/** One file part of the message, before it is anything the Bot holds. */
export interface InboundEmailFileV1 {
  name: string;
  /** What the message declared; the bytes decide in the end. */
  mediaType: string;
  bytes: Uint8Array;
}

export interface InboundEmailV1 {
  /** Every header, lowercase keys, in document order. */
  headers: EmailHeaderV1[];
  /** The one mailbox in the one `From`, normalized; absent when that is not what it has. */
  from?: string;
  messageId?: string;
  subject: string;
  /** The words, quoted history and signature removed. */
  body: string;
  /** Whether a machine wrote it (RFC 3834): a vacation reply, a bounce. */
  automatic: boolean;
  /** The files, attachments first, then pictures placed in the body. */
  files: InboundEmailFileV1[];
}

/**
 * An inline part smaller than this is the kind a signature carries — a logo,
 * a social icon — and not something the person meant to send.
 */
const INLINE_IMAGE_MIN_BYTES = 20 * 1024;

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
};

function fileName(filename: string | null, mediaType: string): string {
  if (filename?.trim()) return filename.trim();
  const extension = EXTENSIONS[mediaType.toLowerCase()];
  return extension ? `attachment.${extension}` : "attachment";
}

function bytesOf(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Elements whose content is never words the person wrote to the Bot. */
const SKIPPED_ELEMENTS = new Set([
  "head",
  "style",
  "script",
  "title",
  // The thread being replied to.
  "blockquote",
]);

/** Elements that end a line where they close. */
const BLOCK_ELEMENTS = new Set([
  "p",
  "div",
  "li",
  "tr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "ul",
  "ol",
]);

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi,
    (entity, name: string) => {
      if (name.startsWith("#")) {
        const code =
          name[1] === "x" || name[1] === "X"
            ? Number.parseInt(name.slice(2), 16)
            : Number.parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : entity;
      }
      return ENTITIES[name.toLowerCase()] ?? entity;
    },
  );
}

/**
 * An HTML body as the words a person would read in it.
 *
 * One pass, never a backtracking pattern over the whole document: this runs
 * before the sender is known to be anyone, so a body built to make a regular
 * expression quadratic must cost no more than one of the same size that was
 * not. A tag that never closes ends the text there.
 */
export function htmlToTextV1(html: string): string {
  const lower = html.toLowerCase();
  let out = "";
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open < 0) {
      out += html.slice(index);
      break;
    }
    out += html.slice(index, open);
    const close = html.indexOf(">", open + 1);
    if (close < 0) break;
    index = close + 1;
    const tag = /^<\s*(\/?)\s*([a-z0-9]+)/i.exec(
      html.slice(open, Math.min(close + 1, open + 64)),
    );
    if (!tag) continue;
    const closing = tag[1] === "/";
    const name = tag[2]!.toLowerCase();
    if (!closing && SKIPPED_ELEMENTS.has(name)) {
      const end = lower.indexOf(`</${name}`, index);
      const after = end < 0 ? -1 : html.indexOf(">", end);
      if (after < 0) break;
      index = after + 1;
    } else if (name === "br") {
      out += "\n";
    } else if (name === "li" && !closing) {
      out += "- ";
    } else if (closing && BLOCK_ELEMENTS.has(name)) {
      out += "\n";
    }
  }
  return decodeEntities(out)
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}

/** The line a quoted reply starts at, or -1. */
function quoteStart(lines: readonly string[]): number {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    // "On Mon, 1 Sep 2026 at 10:00, Tim <tim@example.com> wrote:", which
    // some clients wrap onto a second line.
    if (/^On\b.+\bwrote:$/i.test(line)) return index;
    if (
      /^On\b/i.test(line) &&
      /^.{0,80}\bwrote:$/i.test(lines[index + 1]?.trim() ?? "")
    ) {
      return index;
    }
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(line)) return index;
    // Outlook: a rule, then the header block of what it replied to.
    if (
      /^_{10,}$/.test(line) &&
      /^From:/i.test(lines[index + 1]?.trim() ?? "")
    ) {
      return index;
    }
    if (
      /^From:\s/i.test(line) &&
      lines
        .slice(index + 1, index + 5)
        .some((next) => /^(Sent|Date):\s/i.test(next.trim()))
    ) {
      return index;
    }
  }
  return -1;
}

/** The footer a phone or a mail app signs every message with. */
const FOOTER =
  /^(Sent from my \w+|Sent from (Mail|Outlook|Yahoo Mail|Gmail)\b.*|Get Outlook for \w+.*|Sent via .+)$/i;

/**
 * The words the person wrote: the reply's quoted history and the signature
 * under it gone, and a forward left whole.
 */
export function readableBodyV1(text: string, forwarded: boolean): string {
  let lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (!forwarded) {
    const quoted = quoteStart(lines);
    if (quoted >= 0) lines = lines.slice(0, quoted);
    // A reply quoted with `>` and nothing introducing it.
    while (lines.length > 0 && /^\s*(>.*)?$/.test(lines.at(-1)!)) {
      lines.pop();
    }
  }
  // "-- " on its own line is the signature delimiter (RFC 3676).
  const delimiter = lines.findIndex((line) => /^--\s?$/.test(line));
  if (delimiter >= 0) lines = lines.slice(0, delimiter);
  const lastWords = lines.findLastIndex((line) => line.trim() !== "");
  if (lastWords >= 0 && FOOTER.test(lines[lastWords]!.trim())) {
    lines = lines.slice(0, lastWords);
  }
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isForward(subject: string): boolean {
  return /^\s*(fwd?|fw)\s*:/i.test(subject);
}

/** The one mailbox a `From` value names, or nothing when it names more or none. */
function soleMailbox(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = addressParser(value);
  if (parsed.length !== 1) return undefined;
  const only = parsed[0]!;
  if (only.group !== undefined) return undefined;
  return normalizeSenderAddressV1(only.address);
}

/** Parse one raw message. Throws when it is not a message at all. */
export async function parseInboundEmailV1(
  raw: Uint8Array,
): Promise<InboundEmailV1> {
  const parsed = await PostalMime.parse(raw, {
    attachmentEncoding: "arraybuffer",
    maxNestingDepth: 50,
  });
  const headers = parsed.headers.map((header) => ({
    key: header.key.toLowerCase(),
    value: header.value,
  }));
  const fromHeaders = headers.filter((header) => header.key === "from");
  const from =
    fromHeaders.length === 1 ? soleMailbox(fromHeaders[0]!.value) : undefined;
  const subject = (parsed.subject ?? "").replace(/\s+/g, " ").trim();
  const autoSubmitted = headers
    .find((header) => header.key === "auto-submitted")
    ?.value.trim()
    .toLowerCase();
  const automatic = autoSubmitted !== undefined && autoSubmitted !== "no";
  // Both far more than a Turn carries, and bounded before any cleaning runs:
  // this is parsed before the sender is known to be anyone.
  const text =
    parsed.text && parsed.text.trim()
      ? parsed.text.slice(0, 200_000)
      : parsed.html
        ? htmlToTextV1(parsed.html.slice(0, 400_000)).slice(0, 200_000)
        : "";
  const attached: InboundEmailFileV1[] = [];
  const placed: InboundEmailFileV1[] = [];
  for (const attachment of parsed.attachments) {
    const bytes = bytesOf(attachment.content);
    if (bytes.byteLength === 0) continue;
    const file = {
      name: fileName(attachment.filename, attachment.mimeType),
      mediaType: attachment.mimeType.toLowerCase(),
      bytes,
    };
    if (attachment.disposition === "attachment" || !attachment.related) {
      attached.push(file);
    } else if (
      file.mediaType.startsWith("image/") &&
      bytes.byteLength >= INLINE_IMAGE_MIN_BYTES
    ) {
      placed.push(file);
    }
  }
  return {
    headers,
    ...(from ? { from } : {}),
    ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
    subject,
    body: readableBodyV1(text, isForward(subject)),
    automatic,
    files: [...attached, ...placed],
  };
}
