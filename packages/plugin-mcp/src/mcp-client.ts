/**
 * A minimal Model Context Protocol client for remote servers.
 *
 * Written against the specification rather than taken from
 * `@modelcontextprotocol/sdk`: the SDK is not a dependency of this repository,
 * it carries Node transports (stdio, `EventSource`, process spawning) this
 * Package must never reach for, and the surface FrockBot needs is four
 * messages wide — `initialize`, `notifications/initialized`, `tools/list` and
 * `tools/call`. Everything here runs inside a Durable Object, so every read is
 * bounded and every request goes through the `fetch` the host supplies, which
 * is the Package's own outbound seam.
 *
 * Two transports are covered:
 *
 * - `streamable-http` (spec revision 2025-03-26 and later): one POST per
 *   JSON-RPC message. The response is either `application/json` carrying the
 *   reply, or `text/event-stream` carrying it as an SSE `message` event.
 * - `sse` (the 2024-11-05 HTTP+SSE transport): a long-lived GET stream that
 *   opens with an `endpoint` event naming the URL to POST messages to; every
 *   reply arrives back on the stream.
 */

const CLIENT_INFO = { name: "frockbot", version: "0.0.1" } as const;

/**
 * The revision this client speaks. A server that answers `initialize` with a
 * different revision is taken at its word: the messages this client sends are
 * unchanged across every revision that defines them.
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Bounds. Every one of them is a refusal, never a truncation. */
export const MAX_MCP_RESPONSE_BYTES = 256 * 1024;
export const MAX_MCP_TOOLS_PER_SERVER = 64;
const MAX_TOOL_LIST_PAGES = 8;
const MAX_TOOL_NAME_LENGTH = 128;
const MAX_TOOL_DESCRIPTION_LENGTH = 4_096;

export type McpTransportV1 = "streamable-http" | "sse";

/**
 * The outbound seam, narrowed to what this client calls. Narrower than
 * `typeof fetch` on purpose: the global cannot be passed by reference inside a
 * Durable Object, so what is handed in here is always a small wrapper.
 */
export type McpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface McpToolDeclarationV1 {
  name: string;
  description?: string;
  /** The server's own JSON Schema, passed through to the model unchanged. */
  inputSchema: Record<string, unknown>;
}

export interface McpHandshakeV1 {
  protocolVersion: string;
  serverName?: string;
  serverVersion?: string;
}

export interface McpToolResultV1 {
  content: string;
  isError: boolean;
}

export interface McpClientConfig {
  url: URL;
  transport: McpTransportV1;
  fetch: McpFetch;
  /** The credential, already opened from its lease. Never stored. */
  apiKey?: string;
  /** The header the key travels in. `Authorization` means `Bearer <key>`. */
  headerName?: string;
  maxResponseBytes?: number;
  maxTools?: number;
}

export class McpProtocolError extends Error {
  /**
   * The HTTP status the server answered with, when there was one. The
   * lifecycle needs it to tell `needs-auth` from `error`: a 401 is a
   * credential a User can replace, and everything else is a server that is
   * not there.
   */
  readonly status?: number;

  /**
   * The `WWW-Authenticate` header the server answered a 401 with, verbatim.
   *
   * It is carried rather than parsed here because this client speaks MCP and
   * not OAuth: `plugin-mcp/src/oauth.ts` reads the `resource_metadata`
   * parameter out of it (RFC 9728 §5.1) to find where the server's protected
   * resource metadata lives, and the classification of the failure as
   * "this server wants authorization" is the same header seen from L4b.
   */
  readonly wwwAuthenticate?: string;

  constructor(
    message: string,
    status?: number,
    wwwAuthenticate?: string | null,
  ) {
    super(message);
    if (status !== undefined) this.status = status;
    if (wwwAuthenticate) {
      this.wwwAuthenticate = wwwAuthenticate.slice(0, 2_048);
    }
  }
}

/**
 * The server said "authorize first".
 *
 * A 401 carrying `WWW-Authenticate: Bearer …` is the one MCP failure that is
 * not a broken server: it puts the existing User Connection into a durable
 * repair state. It is a subclass rather than a sibling so every existing
 * `McpProtocolError` handler keeps working, and typed rather than a status
 * check so the runtime seam and the durable record agree on what it means
 * without re-deriving it from prose.
 */
export class McpAuthorizationRequiredError extends McpProtocolError {
  /** RFC 9728 §5.1's `resource_metadata`, when the server named one. */
  readonly resourceMetadataUrl?: string;

  constructor(message: string, wwwAuthenticate?: string | null) {
    super(message, 401, wwwAuthenticate);
    const named = mcpResourceMetadataChallengeV1(wwwAuthenticate ?? null);
    if (named) this.resourceMetadataUrl = named;
  }
}

/**
 * The `resource_metadata` parameter of a `WWW-Authenticate` challenge. Parsed
 * defensively: the header is the server's, and the URL it names is still put
 * through the outbound classifier before anything fetches it.
 */
export function mcpResourceMetadataChallengeV1(
  header: string | null,
): string | undefined {
  if (!header) return undefined;
  const match = header.match(
    /(?:^|[\s,])resource_metadata\s*=\s*(?:"([^"]*)"|([^\s,]+))/i,
  );
  const value = match?.[1] ?? match?.[2];
  return value && value.length <= 2_048 ? value : undefined;
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new McpProtocolError(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function boundedText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}…`;
}

/** Read a whole body, refusing anything past the cap rather than truncating. */
async function boundedBody(
  response: Response,
  maximum: number,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    throw new McpProtocolError("MCP response is too large");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximum) {
        throw new McpProtocolError("MCP response is too large");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text + decoder.decode();
}

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Parse a complete SSE body into its events. Fields other than `event` and
 * `data` are ignored: this client uses neither `id` resumption nor `retry`.
 */
export function parseSseEventsV1(body: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let name = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator === -1 ? line : line.slice(0, separator);
      const raw = separator === -1 ? "" : line.slice(separator + 1);
      const value = raw.startsWith(" ") ? raw.slice(1) : raw;
      if (field === "event") name = value;
      else if (field === "data") data.push(value);
    }
    if (data.length > 0 || name !== "message") {
      events.push({ event: name, data: data.join("\n") });
    }
  }
  return events;
}

function decodeJsonRpcResponse(value: unknown): JsonRpcResponse {
  const message = record(value, "MCP response");
  if (message.jsonrpc !== "2.0" || typeof message.id !== "number") {
    throw new McpProtocolError("MCP response is not a JSON-RPC reply");
  }
  if (message.error !== undefined) {
    const error = record(message.error, "MCP error");
    return {
      id: message.id,
      error: {
        ...(typeof error.code === "number" ? { code: error.code } : {}),
        message:
          typeof error.message === "string"
            ? boundedText(error.message, 2_000)
            : "MCP request failed",
      },
    };
  }
  return { id: message.id, result: message.result };
}

/** The reply carried by one HTTP body, whichever content type it arrived in. */
function replyFromBody(
  contentType: string,
  body: string,
  id: number,
): JsonRpcResponse {
  if (contentType.includes("text/event-stream")) {
    for (const event of parseSseEventsV1(body)) {
      if (event.event !== "message" || !event.data) continue;
      const reply = decodeJsonRpcResponse(JSON.parse(event.data));
      if (reply.id === id) return reply;
    }
    throw new McpProtocolError("MCP stream carried no reply");
  }
  const reply = decodeJsonRpcResponse(JSON.parse(body));
  if (reply.id !== id) {
    throw new McpProtocolError("MCP reply does not answer the request");
  }
  return reply;
}

/**
 * The long-lived GET stream of the legacy HTTP+SSE transport. It is opened
 * once per client, yields the message endpoint, and then carries every reply.
 */
class SseSession {
  private buffer = "";
  private consumed = 0;
  private readonly decoder = new TextDecoder();
  private pending: SseEvent[] = [];

  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly maximum: number,
  ) {}

  /** The next event on the stream, or `undefined` when it ends. */
  async next(): Promise<SseEvent | undefined> {
    for (;;) {
      const ready = this.pending.shift();
      if (ready) return ready;
      const chunk = await this.reader.read();
      if (chunk.done) {
        const rest = parseSseEventsV1(this.buffer);
        this.buffer = "";
        this.pending.push(...rest);
        return this.pending.shift();
      }
      this.consumed += chunk.value.byteLength;
      if (this.consumed > this.maximum) {
        throw new McpProtocolError("MCP response is too large");
      }
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
      const boundary = this.buffer.lastIndexOf("\n\n");
      if (boundary === -1) continue;
      const complete = this.buffer.slice(0, boundary + 2);
      this.buffer = this.buffer.slice(boundary + 2);
      this.pending.push(...parseSseEventsV1(complete));
    }
  }

  /** Bytes read so far, reset between requests so each one has its own cap. */
  resetBudget(): void {
    this.consumed = 0;
  }

  async close(): Promise<void> {
    try {
      await this.reader.cancel();
    } catch {
      // A server that already closed the stream is not a failure.
    }
    this.reader.releaseLock();
  }
}

export class McpClient {
  private nextId = 1;
  private sessionId?: string;
  private protocolVersion?: string;
  private session?: SseSession;
  private messageUrl?: URL;
  private readonly maxResponseBytes: number;
  private readonly maxTools: number;

  constructor(private readonly config: McpClientConfig) {
    this.maxResponseBytes = config.maxResponseBytes ?? MAX_MCP_RESPONSE_BYTES;
    this.maxTools = config.maxTools ?? MAX_MCP_TOOLS_PER_SERVER;
  }

  private headers(accept: string): Headers {
    const headers = new Headers({
      accept,
      "content-type": "application/json",
    });
    if (this.config.apiKey) {
      const name = this.config.headerName ?? "Authorization";
      headers.set(
        name,
        name.toLowerCase() === "authorization"
          ? `Bearer ${this.config.apiKey}`
          : this.config.apiKey,
      );
    }
    if (this.sessionId) headers.set("mcp-session-id", this.sessionId);
    if (this.protocolVersion) {
      headers.set("mcp-protocol-version", this.protocolVersion);
    }
    return headers;
  }

  private async post(
    url: URL,
    body: unknown,
    accept: string,
  ): Promise<Response> {
    const response = await this.config.fetch(url.toString(), {
      method: "POST",
      headers: this.headers(accept),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = boundedText(
        await response.text().catch(() => ""),
        200,
      ).trim();
      const message = `MCP server answered ${response.status}${detail ? `: ${detail}` : ""}`;
      const challenge = response.headers.get("www-authenticate");
      if (response.status === 401) {
        throw new McpAuthorizationRequiredError(message, challenge);
      }
      throw new McpProtocolError(message, response.status, challenge);
    }
    return response;
  }

  /** One request/response exchange, on whichever transport is configured. */
  private async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const message = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };
    const reply =
      this.config.transport === "sse"
        ? await this.requestOverSse(message, id)
        : await this.requestOverStreamableHttp(message, id);
    if (reply.error) {
      throw new McpProtocolError(reply.error.message ?? "MCP request failed");
    }
    return reply.result;
  }

  private async requestOverStreamableHttp(
    message: unknown,
    id: number,
  ): Promise<JsonRpcResponse> {
    const response = await this.post(
      this.config.url,
      message,
      "application/json, text/event-stream",
    );
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    const contentType = response.headers.get("content-type") ?? "";
    const body = await boundedBody(response, this.maxResponseBytes);
    return replyFromBody(contentType, body, id);
  }

  private async requestOverSse(
    message: unknown,
    id: number,
  ): Promise<JsonRpcResponse> {
    const session = await this.openSseSession();
    session.resetBudget();
    const accepted = await this.post(
      this.messageUrl!,
      message,
      "application/json",
    );
    // The legacy transport answers the POST with 202 and delivers the reply on
    // the stream; a server that answers inline is honoured too.
    const contentType = accepted.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = await boundedBody(accepted, this.maxResponseBytes);
      if (body.trim()) return replyFromBody(contentType, body, id);
    } else {
      await accepted.body?.cancel();
    }
    for (;;) {
      const event = await session.next();
      if (!event)
        throw new McpProtocolError("MCP stream closed before replying");
      if (event.event !== "message" || !event.data) continue;
      const reply = decodeJsonRpcResponse(JSON.parse(event.data));
      if (reply.id === id) return reply;
    }
  }

  private async openSseSession(): Promise<SseSession> {
    if (this.session) return this.session;
    const response = await this.config.fetch(this.config.url.toString(), {
      method: "GET",
      headers: this.headers("text/event-stream"),
    });
    if (!response.ok || !response.body) {
      const message = `MCP server answered ${response.status} opening its event stream`;
      const challenge = response.headers.get("www-authenticate");
      if (response.status === 401) {
        throw new McpAuthorizationRequiredError(message, challenge);
      }
      throw new McpProtocolError(message, response.status, challenge);
    }
    const session = new SseSession(
      response.body.getReader(),
      this.maxResponseBytes,
    );
    const first = await session.next();
    if (first?.event !== "endpoint" || !first.data) {
      await session.close();
      throw new McpProtocolError("MCP stream did not name a message endpoint");
    }
    let endpoint: URL;
    try {
      endpoint = new URL(first.data, this.config.url);
    } catch {
      await session.close();
      throw new McpProtocolError("MCP message endpoint is invalid");
    }
    if (endpoint.origin !== this.config.url.origin) {
      await session.close();
      throw new McpProtocolError("MCP message endpoint changed origin");
    }
    this.messageUrl = endpoint;
    this.session = session;
    return session;
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    const message = {
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    };
    const target =
      this.config.transport === "sse"
        ? (this.messageUrl ?? this.config.url)
        : this.config.url;
    const response = await this.post(
      target,
      message,
      "application/json, text/event-stream",
    );
    await response.body?.cancel();
  }

  /** `initialize` plus `notifications/initialized`: the whole handshake. */
  async connect(): Promise<McpHandshakeV1> {
    const result = record(
      await this.request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      }),
      "MCP initialize result",
    );
    const version = result.protocolVersion;
    if (typeof version !== "string" || version.length === 0) {
      throw new McpProtocolError("MCP server declared no protocol version");
    }
    this.protocolVersion = boundedText(version, 64);
    const info =
      result.serverInfo && typeof result.serverInfo === "object"
        ? (result.serverInfo as Record<string, unknown>)
        : {};
    await this.notify("notifications/initialized");
    return {
      protocolVersion: this.protocolVersion,
      ...(typeof info.name === "string"
        ? { serverName: boundedText(info.name, 128) }
        : {}),
      ...(typeof info.version === "string"
        ? { serverVersion: boundedText(info.version, 64) }
        : {}),
    };
  }

  /**
   * Every tool the server offers, paginated until it stops or the per-server
   * ceiling is reached. Exceeding the ceiling is a refusal: a Bot must not be
   * handed a partial catalog it cannot tell from a complete one.
   */
  async listTools(): Promise<McpToolDeclarationV1[]> {
    const tools: McpToolDeclarationV1[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_LIST_PAGES; page += 1) {
      const result = record(
        await this.request(
          "tools/list",
          cursor === undefined ? {} : { cursor },
        ),
        "MCP tools/list result",
      );
      if (!Array.isArray(result.tools)) {
        throw new McpProtocolError("MCP tools/list returned no tools array");
      }
      for (const candidate of result.tools) {
        tools.push(decodeToolDeclaration(candidate));
        if (tools.length > this.maxTools) {
          throw new McpProtocolError(
            `MCP server offers more than ${this.maxTools} tools`,
          );
        }
      }
      const next = result.nextCursor;
      if (typeof next !== "string" || next.length === 0) return tools;
      cursor = next;
    }
    throw new McpProtocolError("MCP tools/list did not terminate");
  }

  /**
   * One `tools/call`. A protocol error and a tool that reports `isError` are
   * both errors the Bot sees; neither throws past the Agent loop.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResultV1> {
    const result = record(
      await this.request("tools/call", { name, arguments: args }),
      "MCP tools/call result",
    );
    return {
      content: renderToolContent(result),
      isError: result.isError === true,
    };
  }

  async close(): Promise<void> {
    await this.session?.close();
    this.session = undefined;
  }
}

function decodeToolDeclaration(value: unknown): McpToolDeclarationV1 {
  const tool = record(value, "MCP tool");
  if (
    typeof tool.name !== "string" ||
    tool.name.length === 0 ||
    tool.name.length > MAX_TOOL_NAME_LENGTH
  ) {
    throw new McpProtocolError("MCP tool name is invalid");
  }
  // The server's schema reaches the model unchanged: it is the contract the
  // server itself will validate the call against, and rewriting it here would
  // make the two disagree.
  const inputSchema =
    tool.inputSchema && typeof tool.inputSchema === "object"
      ? (tool.inputSchema as Record<string, unknown>)
      : { type: "object" };
  return {
    name: tool.name,
    ...(typeof tool.description === "string"
      ? {
          description: boundedText(
            tool.description,
            MAX_TOOL_DESCRIPTION_LENGTH,
          ),
        }
      : {}),
    inputSchema,
  };
}

/**
 * A tool result as one text payload. Text content blocks are joined; anything
 * else (images, embedded resources, structured content) is carried as its own
 * JSON, so nothing the server returned is silently dropped.
 */
function renderToolContent(result: Record<string, unknown>): string {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const parts = blocks.map((block) => {
    if (!block || typeof block !== "object") return JSON.stringify(block);
    const value = block as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") {
      return value.text;
    }
    return JSON.stringify(value);
  });
  if (parts.length === 0 && result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent);
  }
  return parts.join("\n");
}
