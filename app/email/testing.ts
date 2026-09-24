// A raw message, built the way a mail client and Email Routing would have
// left it: the receiving server's ARC verdict on top, then the sender's own
// headers, then a MIME body. Tests only.

export interface RawEmailFileV1 {
  name: string;
  mediaType: string;
  bytes: Uint8Array;
  /** An inline part a body refers to, like a pasted picture or a logo. */
  inline?: boolean;
}

export interface RawEmailV1 {
  from: string;
  to: string;
  subject?: string;
  messageId?: string;
  text?: string;
  html?: string;
  files?: RawEmailFileV1[];
  /**
   * The verdict Email Routing stamps. `pass` is DMARC passing for the From
   * domain; `none` leaves it out; a string is written as it is.
   */
  verdict?: "pass" | "fail" | "none" | string;
  headers?: Record<string, string>;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return (btoa(binary).match(/.{1,76}/g) ?? []).join("\r\n");
}

function domainOf(address: string): string {
  const bare = address.replace(/^.*</, "").replace(/>.*$/, "");
  return bare.slice(bare.lastIndexOf("@") + 1).toLowerCase();
}

export function rawEmailV1(message: RawEmailV1): Uint8Array {
  const domain = domainOf(message.from);
  const verdict = message.verdict ?? "pass";
  const lines: string[] = [];
  if (verdict === "pass" || verdict === "fail") {
    lines.push(
      `ARC-Authentication-Results: i=1; mx.cloudflare.net;\r\n\tdkim=${verdict} header.d=${domain} header.s=s1 header.b=AbC;\r\n\tdmarc=${verdict} header.from=${domain} policy.dmarc=reject;\r\n\tspf=pass smtp.mailfrom=${domain}`,
    );
  } else if (verdict !== "none") {
    lines.push(`ARC-Authentication-Results: ${verdict}`);
  }
  lines.push(
    `From: ${message.from}`,
    `To: ${message.to}`,
    ...(message.subject === undefined ? [] : [`Subject: ${message.subject}`]),
    ...(message.messageId === undefined
      ? []
      : [`Message-ID: <${message.messageId}>`]),
    "Date: Thu, 24 Sep 2026 10:00:00 +0000",
    "MIME-Version: 1.0",
    ...Object.entries(message.headers ?? {}).map(
      ([name, value]) => `${name}: ${value}`,
    ),
  );
  const files = message.files ?? [];
  const bodyPart = message.html
    ? [
        'Content-Type: multipart/alternative; boundary="frock-alternative"',
        "",
        "--frock-alternative",
        "Content-Type: text/plain; charset=utf-8",
        "",
        message.text ?? "",
        "--frock-alternative",
        "Content-Type: text/html; charset=utf-8",
        "",
        message.html,
        "--frock-alternative--",
      ]
    : ["Content-Type: text/plain; charset=utf-8", "", message.text ?? ""];
  const filePart = (file: RawEmailFileV1, index: number) => [
    `Content-Type: ${file.mediaType}; name="${file.name}"`,
    file.inline
      ? `Content-Disposition: inline; filename="${file.name}"`
      : `Content-Disposition: attachment; filename="${file.name}"`,
    ...(file.inline ? [`Content-ID: <part${index}@frock.test>`] : []),
    "Content-Transfer-Encoding: base64",
    "",
    base64(file.bytes),
  ];
  // Pictures placed in the body go beside it in `multipart/related`, as a
  // mail client sends them; attachments go after it in `multipart/mixed`.
  const inline = files.filter((file) => file.inline);
  const attached = files.filter((file) => !file.inline);
  const related =
    inline.length === 0
      ? bodyPart
      : [
          'Content-Type: multipart/related; boundary="frock-related"',
          "",
          "--frock-related",
          ...bodyPart,
          ...inline.flatMap((file, index) => [
            "--frock-related",
            ...filePart(file, index),
          ]),
          "--frock-related--",
        ];
  const body =
    attached.length === 0
      ? related
      : [
          'Content-Type: multipart/mixed; boundary="frock-mixed"',
          "",
          "--frock-mixed",
          ...related,
          ...attached.flatMap((file, index) => [
            "--frock-mixed",
            ...filePart(file, inline.length + index),
          ]),
          "--frock-mixed--",
        ];
  return new TextEncoder().encode([...lines, ...body, ""].join("\r\n"));
}

/** A minimal PNG of the given size in bytes, padded after its header. */
export function pngBytesV1(size = 128): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}
