// What a connected app's answer becomes before the model reads it.
//
// Most apps' answers go through as the app sent them, refused past a bound.
// Gmail's do not: a message arrives as its HTML body and its MIME parts in
// base64, 70–90 KB with almost no words in it, and reading email is most of
// what a Bot does with Gmail. So for Gmail a body that is HTML becomes the
// text a person would read in it, with its links listed after it; a long
// encoded blob becomes a line saying one was there; and an answer still too
// long keeps its beginning and end with the cut named.
//
// Everything here runs on text a stranger can send, so every scan is one
// linear pass: no pattern that can backtrack over the body.
import type { ToolExecutionResult } from "@frockbot/core/contracts";
import { htmlToTextV1 } from "@frockbot/app/email/message";

/** Longest answer from any other app handed back to the model, in bytes. */
const MAX_RESULT_BYTES = 128_000;

/** Longest Gmail answer the model is handed, in characters. */
export const GMAIL_RESULT_MAX_CHARS_V1 = 40_000;

/** How much of an over-long answer's end is kept beside its beginning. */
const GMAIL_RESULT_TAIL_CHARS_V1 = 8_000;

/** Shorter strings are never read as HTML. */
const HTML_MIN_CHARS_V1 = 1_000;

/** Shorter strings are never read as encoded data. */
const ENCODED_MIN_CHARS_V1 = 8_000;

/** The most characters of links listed after one body. */
const LINKS_MAX_CHARS_V1 = 6_000;

const HTML_START =
  /^\s*<(?:!doctype|html|head|body|div|table|p|span|meta|style)\b/i;
const ENCODED = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** Each `href` of an HTML body that goes to the web, in order, once. */
function linksIn(html: string): string[] {
  const lower = html.toLowerCase();
  const links: string[] = [];
  let spent = 0;
  let at = lower.indexOf("href=");
  while (at >= 0) {
    const quote = html[at + 5];
    let next = at + 5;
    if (quote === '"' || quote === "'") {
      const end = html.indexOf(quote, at + 6);
      if (end < 0) break;
      next = end;
      const link = html.slice(at + 6, end).replaceAll("&amp;", "&");
      if (/^https?:\/\//i.test(link) && !links.includes(link)) {
        if (spent + link.length > LINKS_MAX_CHARS_V1) break;
        links.push(link);
        spent += link.length;
      }
    }
    at = lower.indexOf("href=", next);
  }
  return links;
}

function shapeGmailString(value: string): string {
  if (value.length >= ENCODED_MIN_CHARS_V1 && ENCODED.test(value)) {
    return `[${value.length} characters of encoded data left out]`;
  }
  if (value.length < HTML_MIN_CHARS_V1 || !HTML_START.test(value)) return value;
  const text = htmlToTextV1(value)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const links = linksIn(value);
  return links.length === 0
    ? text
    : `${text}\n\nLinks in it:\n${links.map((link) => `- ${link}`).join("\n")}`;
}

function gmailContent(data: unknown): string {
  const content =
    JSON.stringify(data, (_key, value: unknown) =>
      typeof value === "string" ? shapeGmailString(value) : value,
    ) ?? "null";
  if (content.length <= GMAIL_RESULT_MAX_CHARS_V1) return content;
  const head = GMAIL_RESULT_MAX_CHARS_V1 - GMAIL_RESULT_TAIL_CHARS_V1;
  const omitted = content.length - head - GMAIL_RESULT_TAIL_CHARS_V1;
  return `${content.slice(0, head)}\n[… ${omitted} characters cut here. Ask for less at a time — fewer messages, or without the payload — to see them.]\n${content.slice(-GMAIL_RESULT_TAIL_CHARS_V1)}`;
}

/** The answer one Connect tool call hands the model. */
export function connectResultV1(
  toolSlug: string,
  data: unknown,
): ToolExecutionResult {
  if (toolSlug.startsWith("GMAIL_")) {
    return { content: gmailContent(data), isError: false };
  }
  const content = JSON.stringify(data);
  if (new TextEncoder().encode(content).byteLength > MAX_RESULT_BYTES) {
    return {
      content: "The app's answer is too large to show. Ask for less at a time.",
      isError: true,
    };
  }
  return { content, isError: false };
}
