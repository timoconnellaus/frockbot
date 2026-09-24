// A thin adapter over the official MCP client: the one place FrockBot speaks
// to a remote MCP server, from the User Durable Object (handshake and tool
// listing) and from a Bot's Turn (a tool call).
//
// The protocol, both HTTP transports and the JSON-RPC framing are the SDK's.
// What is ours is the edge around it:
//
//  * OUTBOUND. Every request — and every hop a redirect names — is held to the
//    same classifier `web_fetch` uses, with the server's own port allowed. A
//    response body is read through a byte bound, because a server is
//    somebody else's code answering inside our object.
//  * SESSIONS. A session lives for one operation and is closed after it: the
//    handshake and the listing, or one call. Nothing is resident between
//    Turns, so nothing needs restoring after an eviction.
//  * FAILURES. What went wrong is sorted into what the caller can say
//    honestly: the server wants a credential, the server could not be reached
//    before anything was asked of it, the server answered with a refusal, or
//    the call left and its outcome is unknown.
import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type CallToolResult,
  type Transport,
} from "@modelcontextprotocol/client";
import { classifyOutboundUrlV1 } from "@frockbot/app/web/ssrf";

export type McpTransportV1 = "streamable-http" | "sse";

export type McpFetchV1 = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/** One tool as FrockBot keeps it: what the model reads, nothing else. */
export interface McpToolV1 {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** What a handshake learned about the server. Never a secret. */
export interface McpServerInfoV1 {
  transport: McpTransportV1;
  serverName?: string;
  serverVersion?: string;
  /** The server's own instructions for using its tools, bounded. */
  instructions?: string;
}

/** The server refused the request for want of a credential it accepts. */
export class McpUnauthorizedError extends Error {
  constructor() {
    super("The server asked for a credential FrockBot does not hold.");
    this.name = "McpUnauthorizedError";
  }
}

/** Nothing reached the server that it could have acted on. */
export class McpUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpUnreachableError";
  }
}

/** The server answered the request with a protocol error. */
export class McpRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpRefusedError";
  }
}

/** Largest body one server response may carry. */
export const MCP_RESPONSE_MAX_BYTES_V1 = 8 * 1024 * 1024;
/** Redirect hops a request may follow, each one classified again. */
const MAX_REDIRECTS = 3;
/** How long a handshake, and the listing after it, may take. */
export const MCP_HANDSHAKE_TIMEOUT_MS_V1 = 20_000;
/** How long one tool call may take. */
export const MCP_CALL_TIMEOUT_MS_V1 = 120_000;
/** The most pages one listing may walk. */
const LIST_MAX_PAGES = 20;
/** The longest set of server instructions kept. */
const MAX_INSTRUCTIONS = 4_000;
/** The longest tool description kept. */
const MAX_DESCRIPTION = 4_000;
/** The tool names MCP recommends, and the only ones a namespace can hold. */
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

const CLIENT_INFO = { name: "FrockBot", version: "1.0.0" } as const;

/** Invalid request, unknown method and invalid params: nothing was run. */
const REFUSAL_CODES = new Set([-32600, -32601, -32602]);

/**
 * The server address a person may add: https, no credentials in it, no
 * fragment, and a host on the public internet. Answers the normalized
 * address, or the sentence the refusal carries.
 */
export function classifyMcpServerUrlV1(
  candidate: unknown,
): { url: string; host: string } | { refusal: string } {
  const verdict = classifyOutboundUrlV1(candidate, {
    allowNonDefaultPort: true,
  });
  if (!verdict.allowed) {
    return {
      refusal:
        verdict.reason === "ssrf-invalid-url" ||
        verdict.reason === "ssrf-blocked-scheme"
          ? "Enter the server's full https address."
          : verdict.message,
    };
  }
  const url = new URL(verdict.url);
  url.hash = "";
  return { url: url.href, host: url.host };
}

/**
 * The outbound seam a session reaches the network through. Each hop is
 * classified before it is sent; 307 and 308 are followed because they keep
 * the method and body, every other redirect is refused.
 */
export function guardedMcpFetchV1(base: McpFetchV1): McpFetchV1 {
  return async (input, init = {}) => {
    let url = typeof input === "string" ? input : input.href;
    for (let hop = 0; ; hop += 1) {
      const verdict = classifyOutboundUrlV1(url, { allowNonDefaultPort: true });
      if (!verdict.allowed) throw new McpUnreachableError(verdict.message);
      // Only the fields every runtime honours: workerd refuses some of the
      // ones an EventSource sets.
      const response = await base(verdict.url, {
        ...(init.method ? { method: init.method } : {}),
        ...(init.headers ? { headers: init.headers } : {}),
        ...(init.body !== undefined && init.body !== null
          ? { body: init.body }
          : {}),
        ...(init.signal ? { signal: init.signal } : {}),
        redirect: "manual",
      });
      if (response.status < 300 || response.status >= 400) {
        return boundedResponse(response, MCP_RESPONSE_MAX_BYTES_V1);
      }
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      if (
        (response.status !== 307 && response.status !== 308) ||
        !location ||
        hop >= MAX_REDIRECTS
      ) {
        throw new McpUnreachableError(
          "The server redirected somewhere FrockBot does not follow.",
        );
      }
      url = new URL(location, verdict.url).href;
    }
  };
}

function boundedResponse(response: Response, maxBytes: number): Response {
  if (!response.body) return response;
  let seen = 0;
  const bounded = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          controller.error(
            new McpUnreachableError("The server's answer is too large."),
          );
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(bounded, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export interface McpSessionOptionsV1 {
  url: string;
  /** Known from an earlier handshake; absent tries streamable HTTP, then SSE. */
  transport?: McpTransportV1;
  /** A bearer token, opened from a lease for this one operation. */
  token?: string;
  fetch?: McpFetchV1;
  signal?: AbortSignal;
}

export interface McpSessionV1 {
  readonly info: McpServerInfoV1;
  listTools(): Promise<McpToolV1[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult>;
}

function transportFor(
  kind: McpTransportV1,
  options: McpSessionOptionsV1,
  fetcher: McpFetchV1,
): Transport {
  const url = new URL(options.url);
  const token = options.token;
  const authProvider = token ? { token: async () => token } : undefined;
  return kind === "sse"
    ? new SSEClientTransport(url, {
        fetch: fetcher,
        ...(authProvider ? { authProvider } : {}),
      })
    : new StreamableHTTPClientTransport(url, {
        fetch: fetcher,
        ...(authProvider ? { authProvider } : {}),
      });
}

function httpStatus(error: unknown): number | undefined {
  if (error instanceof SdkHttpError) return error.status;
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "number" && code >= 400 && code < 600
    ? code
    : undefined;
}

function isUnauthorized(error: unknown): boolean {
  if (error instanceof UnauthorizedError) return true;
  const status = httpStatus(error);
  return status === 401 || status === 403;
}

/**
 * Whether a failed first request means the address speaks the older
 * HTTP+SSE transport: the specification's own test is a 4xx that is not a
 * refusal of the credential.
 */
function suggestsLegacyTransport(error: unknown): boolean {
  const status = httpStatus(error);
  return status === 400 || status === 404 || status === 405;
}

function handshakeFailure(error: unknown): Error {
  if (error instanceof McpUnauthorizedError) return error;
  if (isUnauthorized(error)) return new McpUnauthorizedError();
  if (error instanceof McpUnreachableError) return error;
  if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
    return new McpUnreachableError("The server did not answer in time.");
  }
  const status = httpStatus(error);
  if (status !== undefined) {
    return new McpUnreachableError(
      `The server answered HTTP ${status} instead of speaking MCP.`,
    );
  }
  return new McpUnreachableError(
    "The server could not be reached, or did not speak MCP.",
  );
}

async function connect(
  kind: McpTransportV1,
  options: McpSessionOptionsV1,
  fetcher: McpFetchV1,
): Promise<Client> {
  const client = new Client(CLIENT_INFO, { listMaxPages: LIST_MAX_PAGES });
  try {
    await client.connect(transportFor(kind, options, fetcher), {
      timeout: MCP_HANDSHAKE_TIMEOUT_MS_V1,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Opens a session, hands it to `use`, and closes it whatever `use` did. The
 * handshake's own failures are sorted here; what `use` throws is its own.
 */
export async function withMcpSessionV1<T>(
  options: McpSessionOptionsV1,
  use: (session: McpSessionV1) => Promise<T>,
): Promise<T> {
  const fetcher = guardedMcpFetchV1(
    options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
  );
  let client: Client;
  let transport: McpTransportV1 = options.transport ?? "streamable-http";
  try {
    try {
      client = await connect(transport, options, fetcher);
    } catch (error) {
      if (options.transport !== undefined || !suggestsLegacyTransport(error)) {
        throw error;
      }
      transport = "sse";
      client = await connect(transport, options, fetcher);
    }
  } catch (error) {
    throw handshakeFailure(error);
  }
  const server = client.getServerVersion();
  const instructions = client.getInstructions()?.trim();
  const info: McpServerInfoV1 = {
    transport,
    ...(server?.name ? { serverName: server.name.slice(0, 200) } : {}),
    ...(server?.version ? { serverVersion: server.version.slice(0, 100) } : {}),
    ...(instructions
      ? { instructions: instructions.slice(0, MAX_INSTRUCTIONS) }
      : {}),
  };
  const session: McpSessionV1 = {
    info,
    async listTools() {
      try {
        const listed = await client.listTools(undefined, {
          timeout: MCP_HANDSHAKE_TIMEOUT_MS_V1,
          cacheMode: "bypass",
          ...(options.signal ? { signal: options.signal } : {}),
        });
        return listed.tools.flatMap((tool): McpToolV1[] =>
          TOOL_NAME.test(tool.name) &&
          tool.inputSchema &&
          typeof tool.inputSchema === "object"
            ? [
                {
                  name: tool.name,
                  description: (tool.description ?? tool.title ?? "").slice(
                    0,
                    MAX_DESCRIPTION,
                  ),
                  inputSchema: structuredClone(
                    tool.inputSchema as Record<string, unknown>,
                  ),
                },
              ]
            : [],
        );
      } catch (error) {
        throw handshakeFailure(error);
      }
    },
    async callTool(name, args, signal) {
      try {
        return await client.callTool(
          { name, arguments: args },
          {
            timeout: MCP_CALL_TIMEOUT_MS_V1,
            ...(signal ? { signal } : {}),
          },
        );
      } catch (error) {
        if (isUnauthorized(error)) throw new McpUnauthorizedError();
        // The request-shape errors are the server refusing the call before
        // running it. Any other error it sends — an internal one — may have
        // come from partway through, so it stays an unknown outcome.
        if (error instanceof ProtocolError && REFUSAL_CODES.has(error.code)) {
          throw new McpRefusedError(error.message.slice(0, 500));
        }
        throw error;
      }
    },
  };
  try {
    return await use(session);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Longest tool answer handed back to the model. */
export const MCP_RESULT_MAX_BYTES_V1 = 128_000;

/**
 * A tool's answer as the model reads it. Text stays text; anything the model
 * cannot be shown here is named rather than dropped, so a result is never
 * silently shorter than what the server sent.
 */
export function mcpResultTextV1(result: CallToolResult): string {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "image":
        parts.push(`[image: ${block.mimeType}]`);
        break;
      case "audio":
        parts.push(`[audio: ${block.mimeType}]`);
        break;
      case "resource_link":
        parts.push(
          `[resource: ${block.uri}${block.name ? ` (${block.name})` : ""}]`,
        );
        break;
      case "resource": {
        const resource = block.resource;
        parts.push(
          "text" in resource && typeof resource.text === "string"
            ? resource.text
            : `[resource: ${resource.uri}]`,
        );
        break;
      }
      default:
        parts.push(`[${(block as { type?: string }).type ?? "content"}]`);
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent);
  }
  return parts.join("\n");
}
