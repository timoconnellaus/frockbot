import { describe, expect, test } from "bun:test";
import {
  DOCX_MEDIA_TYPE_V1,
  PPTX_MEDIA_TYPE_V1,
  XLSX_MEDIA_TYPE_V1,
} from "@frockbot/core/contracts";
import {
  extractDocumentTextV1,
  officeTextV1,
  type DocumentConverterV1,
} from "./extract.js";

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A ZIP of the given parts: the first stored, the rest deflated. */
async function zip(parts: Record<string, string>): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  let index = 0;
  for (const [name, content] of Object.entries(parts)) {
    const nameBytes = encoder.encode(name);
    const raw = encoder.encode(content);
    const method = index === 0 ? 0 : 8;
    const data = method === 0 ? raw : await deflateRaw(raw);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
    index += 1;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const all = [...locals, ...centrals, end];
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const slide = (words: string[]) =>
  `<p:sld><p:txBody>${words
    .map((word) => `<a:p><a:r><a:t>${word}</a:t></a:r></a:p>`)
    .join("")}</p:txBody></p:sld>`;

describe("a document's text", () => {
  test("plain text is decoded, trimmed and counted", async () => {
    expect(
      await extractDocumentTextV1({
        name: "notes.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("\ufeff# Notes\r\n\r\nBuy milk.\r\n"),
      }),
    ).toEqual({ status: "ok", text: "# Notes\n\nBuy milk.", chars: 18 });
  });

  test("an empty file has nothing to read", async () => {
    expect(
      await extractDocumentTextV1({
        name: "empty.txt",
        mediaType: "text/plain",
        bytes: new TextEncoder().encode("   \n"),
      }),
    ).toMatchObject({ status: "refused" });
  });

  test("a slide deck is read slide by slide, in order", async () => {
    const deck = await zip({
      "[Content_Types].xml": "<Types/>",
      "ppt/slides/slide10.xml": slide(["Last"]),
      "ppt/slides/slide2.xml": slide(["Revenue &amp; growth", "Up 12%"]),
      "ppt/slides/slide1.xml": slide(["Quarterly review"]),
    });
    expect(await officeTextV1(deck, "pptx")).toBe(
      "## Slide 1\n\nQuarterly review\n\n## Slide 2\n\nRevenue & growth\nUp 12%\n\n## Slide 10\n\nLast",
    );
    // The converter is never asked about a deck its own reader can read.
    let asked = false;
    const converter: DocumentConverterV1 = {
      toMarkdown: async () => {
        asked = true;
        return [];
      },
    };
    expect(
      await extractDocumentTextV1({
        name: "review.pptx",
        mediaType: PPTX_MEDIA_TYPE_V1,
        bytes: deck,
        converter,
      }),
    ).toMatchObject({ status: "ok" });
    expect(asked).toBe(false);
  });

  test("a PDF goes to the converter with image description off", async () => {
    const calls: unknown[] = [];
    const converter: DocumentConverterV1 = {
      toMarkdown: async (files, options) => {
        calls.push({ name: files[0]!.name, options });
        return [{ format: "markdown", data: "# Report\n\nRevenue rose." }];
      },
    };
    expect(
      await extractDocumentTextV1({
        name: "report.pdf",
        mediaType: "application/pdf",
        bytes: new TextEncoder().encode("%PDF-1.7"),
        converter,
      }),
    ).toEqual({ status: "ok", text: "# Report\n\nRevenue rose.", chars: 23 });
    expect(calls).toEqual([
      {
        name: "report.pdf",
        options: {
          conversionOptions: {
            pdf: { images: { convert: false } },
            docx: { images: { convert: false } },
          },
        },
      },
    ]);
  });

  test("a Word document the converter refuses is read from its XML", async () => {
    const document = await zip({
      "[Content_Types].xml": "<Types/>",
      "word/document.xml":
        '<w:document><w:body><w:p><w:r><w:t>Dear Sam,</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Thanks </w:t></w:r><w:r><w:t>again.</w:t></w:r></w:p></w:body></w:document>',
    });
    const converter: DocumentConverterV1 = {
      toMarkdown: async () => [{ format: "error", error: "unsupported" }],
    };
    expect(
      await extractDocumentTextV1({
        name: "letter.docx",
        mediaType: DOCX_MEDIA_TYPE_V1,
        bytes: document,
        converter,
      }),
    ).toEqual({ status: "ok", text: "Dear Sam,\nThanks again.", chars: 23 });
  });

  test("a document nothing can read is refused with a sentence", async () => {
    expect(
      await extractDocumentTextV1({
        name: "scan.pdf",
        mediaType: "application/pdf",
        bytes: new TextEncoder().encode("%PDF-1.7"),
        converter: {
          toMarkdown: async () => [{ format: "markdown", data: "" }],
        },
      }),
    ).toEqual({
      status: "refused",
      reason: "There's no text in that file to read.",
    });
    expect(
      await extractDocumentTextV1({
        name: "sheet.xlsx",
        mediaType: XLSX_MEDIA_TYPE_V1,
        bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      }),
    ).toMatchObject({ status: "refused" });
  });
});
