// The Web Package's runtime Contribution: `web_fetch`.
//
// AUTHORITY. `web-fetch` is a Capability with no Connection: fetching a public
// page needs no credential, so a Bot holds the tool the moment its User grants
// an Assignment of it, and holds nothing when they have not. The Capability is
// still the fence — {@link createConfiguredWebFetchRuntimeContribution} mounts
// nothing without an enabled Assignment naming it.
//
// TRUST BOUNDARY. The Bot's Durable Object is the only thing between a model's
// URL and the platform's network, so every hop is classified by `./ssrf.ts`
// before it is made, and again for every `Location`. See that module for the
// DNS-rebinding limitation this cannot close.
//
// NO COMPUTER. `web_fetch` is a plain outbound request. It works while the
// User's Computer is hibernated and never wakes it; a page that needs a real
// browser is the Computer's job, not this tool's.
//
// EFFECT CLASS. Read-only, so `idempotent: true`: after a Durable Object
// eviction the registry recovers the effect by re-running the request rather
// than reconciling a recorded outcome. The constitution's "record intent
// before an external side effect" exempts effects an interface declares
// read-only, and this is one.
import type {
  ToolDefinition,
  ToolExecutionResult,
} from "@frockbot/kernel-contracts";
import type { Plugin } from "cordis";
import { classifyWebFetchUrlV1, type SsrfRefusalReasonV1 } from "./ssrf.js";

export type WebFetchFn = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export const WEB_FETCH_TOOL_NAME_V1 = "web_fetch";

/** Hard ceiling on the body read off the wire, whatever the call asks for. */
export const WEB_FETCH_MAX_BYTES_V1 = 1024 * 1024;
/** Hard ceiling on the extracted text that reaches the durable event log. */
export const WEB_FETCH_MAX_TEXT_BYTES_V1 = 32 * 1024;
/** Rule 6: how many `Location` hops are followed, each re-classified. */
export const WEB_FETCH_MAX_REDIRECTS_V1 = 3;
export const WEB_FETCH_TIMEOUT_MS_V1 = 15_000;

/** Rule 7: the media types a Bot may read. Anything else is refused. */
export const WEB_FETCH_ALLOWED_CONTENT_TYPES_V1: readonly string[] = [
  "text/html",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/xhtml+xml",
];

/** Every refusal code `web_fetch` can record, SSRF codes included. */
export type WebFetchRefusalReasonV1 =
  | SsrfRefusalReasonV1
  | "web-fetch-invalid-input"
  | "web-fetch-too-many-redirects"
  | "web-fetch-redirect-without-location"
  | "web-fetch-blocked-content-type"
  | "web-fetch-response-too-large"
  | "web-fetch-http-error"
  | "web-fetch-failed";

export type WebFetchFormatV1 = "text" | "markdown";

export interface WebFetchRequestV1 {
  url: string;
  maxBytes: number;
  format: WebFetchFormatV1;
}

/** The durable `tool/result` body of a successful fetch. */
export interface WebFetchResultV1 {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  bytes: number;
  truncated: boolean;
  text: string;
}

const WEB_FETCH_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    url: {
      type: "string",
      description: "Absolute https URL of a public page to read.",
      maxLength: 2048,
    },
    max_bytes: {
      type: "integer",
      description: `Stop reading the body after this many bytes, at most ${WEB_FETCH_MAX_BYTES_V1}.`,
      minimum: 1024,
      maximum: WEB_FETCH_MAX_BYTES_V1,
    },
    format: {
      type: "string",
      description:
        "How to render the page: plain text, or markdown that keeps headings, lists and links.",
      enum: ["text", "markdown"],
    },
  },
  required: ["url"],
  additionalProperties: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeWebFetchInputV1(input: unknown): WebFetchRequestV1 {
  if (!isRecord(input)) throw new Error("web_fetch input must be an object");
  if (typeof input.url !== "string" || input.url.trim().length === 0) {
    throw new Error("web_fetch url must be a string");
  }
  const requested = input.max_bytes ?? WEB_FETCH_MAX_BYTES_V1;
  if (
    typeof requested !== "number" ||
    !Number.isSafeInteger(requested) ||
    requested < 1024 ||
    requested > WEB_FETCH_MAX_BYTES_V1
  ) {
    throw new Error(
      `web_fetch max_bytes must be an integer 1024–${WEB_FETCH_MAX_BYTES_V1}`,
    );
  }
  const format = input.format ?? "text";
  if (format !== "text" && format !== "markdown") {
    throw new Error('web_fetch format must be "text" or "markdown"');
  }
  return { url: input.url.trim(), maxBytes: requested, format };
}

/** A refusal names its reason code and never the address it resolved to. */
function refusal(
  reason: WebFetchRefusalReasonV1,
  message: string,
  url: string,
): ToolExecutionResult {
  return {
    content: JSON.stringify({ url, error: reason, message }),
    isError: true,
  };
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(value: string): string {
  return value.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g,
    (match, body: string) => {
      if (body.startsWith("#x") || body.startsWith("#X")) {
        const code = Number.parseInt(body.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      if (body.startsWith("#")) {
        const code = Number.parseInt(body.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return ENTITIES[body.toLowerCase()] ?? match;
    },
  );
}

/**
 * Reduce a page to the text a model can act on.
 *
 * This is a reader, not a parser: no DOM is available in a Durable Object and
 * a real HTML parser is not worth its weight for a tool whose output is capped
 * at 32 KiB anyway. Script, style and other non-content elements are dropped
 * whole, block boundaries become newlines, and in `markdown` mode headings,
 * list items and links keep their shape.
 */
export function extractReadableTextV1(
  body: string,
  contentType: string,
  format: WebFetchFormatV1,
): string {
  const isHtml = contentType.includes("html") || contentType.includes("xhtml");
  if (!isHtml) return body.trim();
  let text = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<(script|style|noscript|template|svg|iframe|head)\b[\s\S]*?<\/\1>/gi,
      " ",
    );
  if (format === "markdown") {
    text = text
      .replace(
        /<h([1-6])\b[^>]*>/gi,
        (_match, level: string) => `\n\n${"#".repeat(Number(level))} `,
      )
      .replace(/<\/h[1-6]>/gi, "\n\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(
        /<a\b[^>]*\shref=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
        (match, href: string, label: string) => {
          const inner = label.replace(/<[^>]*>/g, "").trim();
          return inner ? `[${inner}](${href})` : match;
        },
      );
  }
  text = text
    .replace(/<(p|div|br|tr|section|article|h[1-6]|li|ul|ol)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|tr|section|article|h[1-6]|li|ul|ol)>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(text)
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function boundedUtf8(value: string, maximum: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maximum) return value;
  let bounded = "";
  let bytes = 0;
  for (const character of value) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > maximum) break;
    bounded += character;
    bytes += size;
  }
  return bounded;
}

/**
 * Read at most `maximum` bytes off the wire, cancelling the body the moment
 * the cap is reached. `truncated` distinguishes a page that ended from a page
 * that was cut off, so the model can ask for more rather than assume it saw
 * everything.
 */
async function readBoundedBody(
  response: Response,
  maximum: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  let truncated = false;
  const reader = response.body?.getReader();
  if (reader) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const remaining = maximum - length;
      if (chunk.value.byteLength >= remaining) {
        chunks.push(chunk.value.subarray(0, remaining));
        length = maximum;
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(chunk.value);
      length += chunk.value.byteLength;
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

export interface WebFetchConfigV1 {
  fetch?: WebFetchFn;
  timeoutMs?: number;
}

/**
 * Execute one `web_fetch`, applying SSRF rules 1–8 on the requested URL and
 * again on every redirect target.
 */
export async function executeWebFetchV1(
  request: WebFetchRequestV1,
  config: WebFetchConfigV1 = {},
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  // Workerd rejects a detached global `fetch`, so the default forwards.
  const fetcher: WebFetchFn =
    config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  let current = classifyWebFetchUrlV1(request.url);
  if (!current.allowed) {
    return refusal(current.reason, current.message, request.url);
  }
  const requested = current.url;
  let response: Response | undefined;
  for (let hop = 0; hop <= WEB_FETCH_MAX_REDIRECTS_V1; hop += 1) {
    if (!current.allowed) {
      return refusal(current.reason, current.message, requested);
    }
    const target = current.url;
    let hopResponse: Response;
    try {
      hopResponse = await fetcher(target, {
        method: "GET",
        redirect: "manual",
        // Rule 5: a fixed identity, and nothing the Bot holds. No cookie, no
        // authorization, no header the model chose.
        headers: {
          accept:
            "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8",
          "user-agent": "FrockBot/0.0.1 (+https://frockbot.com)",
          "accept-language": "en",
        },
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      return refusal(
        "web-fetch-failed",
        (error instanceof Error ? error.message : "the request failed").slice(
          0,
          200,
        ),
        requested,
      );
    }
    if (hopResponse.status >= 300 && hopResponse.status < 400) {
      const location = hopResponse.headers.get("location");
      await hopResponse.body?.cancel().catch(() => undefined);
      if (!location) {
        return refusal(
          "web-fetch-redirect-without-location",
          "The site redirected without saying where.",
          requested,
        );
      }
      if (hop === WEB_FETCH_MAX_REDIRECTS_V1) {
        return refusal(
          "web-fetch-too-many-redirects",
          `The site redirected more than ${WEB_FETCH_MAX_REDIRECTS_V1} times.`,
          requested,
        );
      }
      let resolved: string;
      try {
        resolved = new URL(location, target).toString();
      } catch {
        return refusal(
          "ssrf-invalid-url",
          "The site redirected to an address that is not a URL.",
          requested,
        );
      }
      current = classifyWebFetchUrlV1(resolved);
      continue;
    }
    response = hopResponse;
    break;
  }
  if (!response || !current.allowed) {
    return refusal(
      "web-fetch-too-many-redirects",
      `The site redirected more than ${WEB_FETCH_MAX_REDIRECTS_V1} times.`,
      requested,
    );
  }
  const finalUrl = current.url;
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return refusal(
      "web-fetch-http-error",
      `The site answered ${response.status}.`,
      requested,
    );
  }
  const contentType = (response.headers.get("content-type") ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase();
  if (
    !contentType ||
    !WEB_FETCH_ALLOWED_CONTENT_TYPES_V1.includes(contentType)
  ) {
    await response.body?.cancel().catch(() => undefined);
    return refusal(
      "web-fetch-blocked-content-type",
      `web_fetch reads text pages, not ${contentType || "an undeclared type"}.`,
      requested,
    );
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > request.maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return refusal(
      "web-fetch-response-too-large",
      `The page declares ${declared} bytes, over the ${request.maxBytes} byte limit.`,
      requested,
    );
  }
  let body: { bytes: Uint8Array; truncated: boolean };
  try {
    body = await readBoundedBody(response, request.maxBytes);
  } catch (error) {
    return refusal(
      "web-fetch-failed",
      (error instanceof Error
        ? error.message
        : "the body could not be read"
      ).slice(0, 200),
      requested,
    );
  }
  const decoded = new TextDecoder().decode(body.bytes);
  const extracted = extractReadableTextV1(decoded, contentType, request.format);
  const text = boundedUtf8(extracted, WEB_FETCH_MAX_TEXT_BYTES_V1);
  const result: WebFetchResultV1 = {
    url: requested,
    finalUrl,
    status: response.status,
    contentType,
    bytes: body.bytes.byteLength,
    truncated: body.truncated || text.length < extracted.length,
    text,
  };
  return { content: JSON.stringify(result), isError: false };
}

export function createWebFetchToolDefinitionV1(
  config: WebFetchConfigV1 = {},
): ToolDefinition {
  return {
    name: WEB_FETCH_TOOL_NAME_V1,
    // A general work tool: the reach an `executor` subagent has, and not the
    // narrow reach of `browserUse`, `computerUse`, or the two video roles.
    admission: { subagentRoles: ["executor"] },
    description:
      "Read a public https web page and return its readable text. Refuses non-public addresses.",
    inputSchema: WEB_FETCH_INPUT_SCHEMA,
    idempotent: true,
    validate: (input: unknown) => {
      try {
        decodeWebFetchInputV1(input);
        return true;
      } catch {
        return false;
      }
    },
    execute: async (input, context) => {
      let request: WebFetchRequestV1;
      try {
        request = decodeWebFetchInputV1(input);
      } catch (error) {
        return refusal(
          "web-fetch-invalid-input",
          error instanceof Error ? error.message : "invalid input",
          isRecord(input) && typeof input.url === "string" ? input.url : "",
        );
      }
      return executeWebFetchV1(request, config, context.signal);
    },
  };
}

/** Mount `web_fetch` into a Bot's runtime. */
export function createWebRuntimePlugin(
  config: WebFetchConfigV1 = {},
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) =>
    ctx.tools.register(createWebFetchToolDefinitionV1(config), {
      admissionCeiling: ["chat", "automation", "subagent"],
      subagentRoleCeiling: ["executor"],
    });
  plugin.inject = ["tools"];
  return plugin;
}

/**
 * The Assignment fence. A Bot holds `web_fetch` only through an enabled
 * Assignment of this Package's `web-fetch` Capability; without one this
 * returns `undefined` and nothing is mounted.
 */
export function createConfiguredWebFetchRuntimeContribution(config: {
  assignment: {
    packageId: string;
    capabilityId: string;
    connectionId?: string;
    state: string;
  };
  fetch?: WebFetchFn;
}): Plugin.Function | undefined {
  if (
    config.assignment.packageId !== "web" ||
    config.assignment.capabilityId !== "web-fetch" ||
    config.assignment.state !== "enabled"
  ) {
    return undefined;
  }
  return createWebRuntimePlugin(config.fetch ? { fetch: config.fetch } : {});
}

export default createWebRuntimePlugin;
