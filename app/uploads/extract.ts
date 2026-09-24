// A document's text, extracted once, when it is uploaded.
//
// The model reads documents as text, so the text is what an upload of one
// actually delivers. It is extracted before the upload is admitted: a PDF
// with no text in it is refused on the composer with a sentence, rather than
// accepted and then shown to the Bot as nothing.
//
// Plain text is decoded here. PDF and Office files go to the deployment's
// document converter (Workers AI `toMarkdown`) with image description off —
// describing a document's pictures would be a model call nobody asked for.
// PowerPoint and Word also have a small reader of their own, because a slide
// deck is a ZIP of XML and its words are right there.
import {
  DOCX_MEDIA_TYPE_V1,
  PPTX_MEDIA_TYPE_V1,
  XLSX_MEDIA_TYPE_V1,
} from "@frockbot/core/contracts";
import { decodeUploadTextV1 } from "./shared.js";

/** The most text one document keeps. A novel is about a million. */
export const DOCUMENT_TEXT_MAX_CHARS_V1 = 2_000_000;

/** The converter this deployment offers, narrowed to what extraction uses. */
export interface DocumentConverterV1 {
  toMarkdown(
    files: { name: string; blob: Blob }[],
    options?: {
      conversionOptions?: {
        pdf?: { images?: { convert?: boolean } };
        docx?: { images?: { convert?: boolean } };
      };
    },
  ): Promise<
    readonly ({ format: string; data?: string; error?: string } | undefined)[]
  >;
}

export type DocumentTextV1 =
  | { status: "ok"; text: string; chars: number }
  | { status: "refused"; reason: string };

function bounded(text: string): DocumentTextV1 {
  const trimmed = text.replace(/\r\n?/g, "\n").trim();
  if (trimmed.length === 0) {
    return {
      status: "refused",
      reason: "There's no text in that file to read.",
    };
  }
  const kept = trimmed.slice(0, DOCUMENT_TEXT_MAX_CHARS_V1);
  return { status: "ok", text: kept, chars: kept.length };
}

/** The text of one uploaded document, or why there is none. */
export async function extractDocumentTextV1(input: {
  name: string;
  mediaType: string;
  bytes: Uint8Array;
  converter?: DocumentConverterV1;
}): Promise<DocumentTextV1> {
  const { mediaType, bytes } = input;
  if (mediaType.startsWith("text/") || mediaType === "application/json") {
    const text = decodeUploadTextV1(bytes);
    return text === undefined
      ? { status: "refused", reason: "That file isn't readable text." }
      : bounded(text);
  }
  if (mediaType === PPTX_MEDIA_TYPE_V1) {
    const text = await officeTextV1(bytes, "pptx").catch(() => undefined);
    if (text !== undefined) return bounded(text);
  }
  const converted = await convertV1(input).catch(() => undefined);
  if (converted !== undefined) return bounded(converted);
  if (mediaType === DOCX_MEDIA_TYPE_V1) {
    const text = await officeTextV1(bytes, "docx").catch(() => undefined);
    if (text !== undefined) return bounded(text);
  }
  return {
    status: "refused",
    reason:
      mediaType === "application/pdf"
        ? "That PDF couldn't be read. If it's a scan, send the pages as images."
        : mediaType === XLSX_MEDIA_TYPE_V1 || mediaType === DOCX_MEDIA_TYPE_V1
          ? "That document couldn't be read. Try saving it again, or as a PDF."
          : "That document couldn't be read.",
  };
}

async function convertV1(input: {
  name: string;
  mediaType: string;
  bytes: Uint8Array;
  converter?: DocumentConverterV1;
}): Promise<string | undefined> {
  if (!input.converter) return undefined;
  const [result] = await input.converter.toMarkdown(
    [
      {
        name: input.name,
        blob: new Blob([input.bytes as BlobPart], { type: input.mediaType }),
      },
    ],
    {
      conversionOptions: {
        pdf: { images: { convert: false } },
        docx: { images: { convert: false } },
      },
    },
  );
  if (!result || result.format === "error" || typeof result.data !== "string")
    return undefined;
  return result.data;
}

// ---------------------------------------------------------------------------
// Office Open XML: a ZIP of XML parts. Only what reading words needs.

/** The most bytes one document may inflate to, whatever its ZIP claims. */
const OFFICE_INFLATED_MAX_BYTES_V1 = 64 * 1024 * 1024;
const OFFICE_ENTRIES_MAX_V1 = 4_096;

interface ZipEntryV1 {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

function uint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function uint32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function zipEntriesV1(bytes: Uint8Array): ZipEntryV1[] {
  const floor = Math.max(0, bytes.length - 22 - 65_535);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= floor; offset -= 1) {
    if (uint32(bytes, offset) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error("not a ZIP archive");
  const count = uint16(bytes, end + 10);
  if (count > OFFICE_ENTRIES_MAX_V1) throw new Error("too many ZIP entries");
  let offset = uint32(bytes, end + 16);
  const names = new TextDecoder();
  const entries: ZipEntryV1[] = [];
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || uint32(bytes, offset) !== 0x02014b50) {
      throw new Error("ZIP central directory is invalid");
    }
    const nameLength = uint16(bytes, offset + 28);
    const extraLength = uint16(bytes, offset + 30);
    const commentLength = uint16(bytes, offset + 32);
    entries.push({
      method: uint16(bytes, offset + 10),
      compressedSize: uint32(bytes, offset + 20),
      localHeaderOffset: uint32(bytes, offset + 42),
      name: names.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflateRawV1(
  data: Uint8Array,
  budget: { left: number },
): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    budget.left -= value.byteLength;
    if (budget.left < 0) {
      await reader.cancel();
      throw new Error("document inflates past its bound");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

async function readZipEntryV1(
  bytes: Uint8Array,
  entry: ZipEntryV1,
  budget: { left: number },
): Promise<string> {
  const local = entry.localHeaderOffset;
  if (local + 30 > bytes.length || uint32(bytes, local) !== 0x04034b50) {
    throw new Error("ZIP local header is invalid");
  }
  const start =
    local + 30 + uint16(bytes, local + 26) + uint16(bytes, local + 28);
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) {
    budget.left -= data.byteLength;
    if (budget.left < 0) throw new Error("document inflates past its bound");
    return new TextDecoder().decode(data);
  }
  if (entry.method !== 8) throw new Error("ZIP compression is unsupported");
  return new TextDecoder().decode(await inflateRawV1(data, budget));
}

function xmlUnescapeV1(text: string): string {
  return text.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g,
    (_match, entity: string) => {
      if (entity === "amp") return "&";
      if (entity === "lt") return "<";
      if (entity === "gt") return ">";
      if (entity === "quot") return '"';
      if (entity === "apos") return "'";
      const code =
        entity[1] === "x"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : "";
    },
  );
}

/**
 * The words of one Office XML part: text runs in order, a line per
 * paragraph. `run` is the element that holds text — `a:t` on a slide, `w:t`
 * in a Word body.
 */
function xmlWordsV1(xml: string, run: string, paragraph: string): string {
  const lines: string[] = [];
  let line = "";
  const pattern = new RegExp(
    `<${run}(?:\\s[^>]*)?>([^<]*)</${run}>|</${paragraph}>|<w:tab/>|<w:br/>|<a:br/>`,
    "g",
  );
  for (const match of xml.matchAll(pattern)) {
    if (match[1] !== undefined) line += xmlUnescapeV1(match[1]);
    else if (match[0] === "<w:tab/>") line += "\t";
    else {
      lines.push(line);
      line = "";
    }
  }
  if (line) lines.push(line);
  return lines
    .map((value) => value.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A slide deck's or a Word document's words, read from its XML. */
export async function officeTextV1(
  bytes: Uint8Array,
  format: "pptx" | "docx",
): Promise<string | undefined> {
  const entries = zipEntriesV1(bytes);
  const budget = { left: OFFICE_INFLATED_MAX_BYTES_V1 };
  if (format === "docx") {
    const body = entries.find((entry) => entry.name === "word/document.xml");
    if (!body) return undefined;
    const words = xmlWordsV1(
      await readZipEntryV1(bytes, body, budget),
      "w:t",
      "w:p",
    );
    return words || undefined;
  }
  const slides = entries
    .map((entry) => ({
      entry,
      number: /^ppt\/slides\/slide(\d+)\.xml$/.exec(entry.name)?.[1],
    }))
    .filter(
      (slide): slide is { entry: ZipEntryV1; number: string } =>
        slide.number !== undefined,
    )
    .sort((left, right) => Number(left.number) - Number(right.number));
  if (slides.length === 0) return undefined;
  const sections: string[] = [];
  for (const slide of slides) {
    const words = xmlWordsV1(
      await readZipEntryV1(bytes, slide.entry, budget),
      "a:t",
      "a:p",
    );
    if (words) sections.push(`## Slide ${slide.number}\n\n${words}`);
  }
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}
