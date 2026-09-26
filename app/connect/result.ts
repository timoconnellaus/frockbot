// What a connected app's answer becomes before the model reads it.
//
// Apps answer in whatever shape their API has: an email arrives as its HTML
// body and its MIME parts in base64, a page as its markup. None of that is
// words the model can use, and all of it is what fills a request. So a long
// HTML string becomes the text a person would read in it, a long encoded blob
// becomes a line saying one was there, and an answer still too long keeps its
// beginning and its end with the middle named as cut.
import { htmlToTextV1 } from "@frockbot/app/email/message";

/** Shorter strings are left exactly as the app sent them. */
const SHAPE_MIN_CHARS_V1 = 1_000;

/** Longest answer the model is handed, in characters. */
export const CONNECT_RESULT_MAX_CHARS_V1 = 40_000;

/** How much of an over-long answer's end is kept beside its beginning. */
const CONNECT_RESULT_TAIL_CHARS_V1 = 8_000;

// No repeated whitespace before the name: this runs on text an app relays from
// anyone, and a pattern that can backtrack is one a sender can make slow.
const HTML = /<\/?(?:html|body|div|table|td|p|br|span|img|style)\b/i;
const ENCODED = /^[A-Za-z0-9+/_-]+={0,2}$/;

function shapeString(value: string): string {
  if (value.length < SHAPE_MIN_CHARS_V1) return value;
  if (ENCODED.test(value)) {
    return `[${value.length} characters of encoded data left out]`;
  }
  if (HTML.test(value)) {
    return htmlToTextV1(value)
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  return value;
}

export function shapeConnectResultV1(data: unknown): string {
  const content =
    JSON.stringify(data, (_key, value: unknown) =>
      typeof value === "string" ? shapeString(value) : value,
    ) ?? "null";
  if (content.length <= CONNECT_RESULT_MAX_CHARS_V1) return content;
  const head = CONNECT_RESULT_MAX_CHARS_V1 - CONNECT_RESULT_TAIL_CHARS_V1;
  const omitted = content.length - head - CONNECT_RESULT_TAIL_CHARS_V1;
  return `${content.slice(0, head)}\n[… ${omitted} characters cut here. Ask the app for less at a time — fewer results, or only the fields you need — to see them.]\n${content.slice(-CONNECT_RESULT_TAIL_CHARS_V1)}`;
}
