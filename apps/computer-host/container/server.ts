/**
 * The Node process inside the Cloudflare Container.
 *
 * It owns no protocol knowledge and no Sprite knowledge: it converts a Node
 * request into a `Request`, hands it to the decoder and then to `ComputerHost`,
 * and streams the answer back. The one thing it does own is the shape of
 * cancellation — `req.on("close")` before the response has finished is the
 * Bot Durable Object having gone away, and it aborts the effect rather than
 * leaving a command running on someone's Computer.
 */

import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import { SpritesClient } from "@fly/sprites";
import WebSocket from "ws";
import {
  COMPUTER_HOST_LIMITS,
  COMPUTER_HOST_TOKEN_HEADER,
  decodeComputerHostHttpRequestV1,
  problem,
} from "@frockbot/computer-host-protocol";
import { ComputerHost, type SpritesClientHandle } from "./computer.ts";

/** The SDK reaches the Sprite over a WebSocket; Node needs one supplied. */
Object.defineProperty(globalThis, "WebSocket", { value: WebSocket });

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required by the Computer host`);
  return value;
}

const spritesToken = required("SPRITES_TOKEN");
const hostToken = required("COMPUTER_HOST_TOKEN");
const baseSpriteName = process.env.FROCKBOT_SPRITE_NAME?.trim() || "frockbot";

const host = new ComputerHost({
  client: new SpritesClient(spritesToken) as unknown as SpritesClientHandle,
  baseSpriteName,
  digest: (value) => createHash("sha256").update(value).digest("hex"),
});

/**
 * Constant-time comparison of the shared service token. The service binding
 * already makes this container unroutable from the internet; this is the
 * second of the two locks, because `interceptHttps` and container URLs are a
 * separate path to the same port.
 */
function tokenMatches(presented: string | undefined): boolean {
  if (!presented || presented.length !== hostToken.length) return false;
  let difference = 0;
  for (let index = 0; index < hostToken.length; index += 1) {
    difference |= hostToken.charCodeAt(index) ^ presented.charCodeAt(index);
  }
  return difference === 0;
}

async function webRequest(incoming: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of incoming) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bytes.byteLength;
    if (size > COMPUTER_HOST_LIMITS.requestBytes) {
      throw new Error("request-too-large");
    }
    chunks.push(bytes);
  }
  const method = incoming.method ?? "GET";
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  return new Request(
    `http://${incoming.headers.host ?? "computer-host.internal"}${incoming.url ?? "/"}`,
    {
      method,
      headers,
      body:
        method === "GET" || method === "HEAD"
          ? undefined
          : Buffer.concat(chunks),
    },
  );
}

async function send(
  outgoing: ServerResponse,
  response: Response,
): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  outgoing.writeHead(response.status, headers);
  if (!response.body) {
    outgoing.end();
    return;
  }
  // Piped rather than buffered: an exec stream must reach the caller while the
  // command is still running, or a streaming caller learns nothing early.
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(
      response.body as unknown as Parameters<typeof Readable.fromWeb>[0],
    )
      .on("error", reject)
      .on("end", resolve)
      .pipe(outgoing);
  });
  outgoing.end();
}

async function handle(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Promise<void> {
  if (incoming.url === "/healthz") {
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ ok: true, inFlight: host.inFlightCount }));
    return;
  }

  let request: Request;
  try {
    request = await webRequest(incoming);
  } catch (error) {
    await send(
      outgoing,
      errorText(error) === "request-too-large"
        ? problem(413, "limit-exceeded", "request body too large")
        : problem(400, "invalid-request", "unreadable request"),
    );
    return;
  }

  if (
    !tokenMatches(request.headers.get(COMPUTER_HOST_TOKEN_HEADER) ?? undefined)
  ) {
    await send(
      outgoing,
      problem(401, "not-authorized", "Computer host token is missing or wrong"),
    );
    return;
  }

  const decoded = await decodeComputerHostHttpRequestV1(request);
  if (!decoded.ok) {
    await send(outgoing, decoded.response);
    return;
  }

  // "Client disconnect, refresh, or shutdown detaches an observer" — but the
  // caller here is the Bot Durable Object itself, and its disconnect is the
  // cancellation signal the Sprite must see.
  const controller = new AbortController();
  let settled = false;
  incoming.on("close", () => {
    if (!settled) controller.abort();
  });

  try {
    const response = await host.handle(decoded.value, controller.signal);
    await send(outgoing, response);
  } catch (error) {
    if (!outgoing.headersSent) {
      await send(outgoing, problem(502, "provider-failure", errorText(error)));
    } else {
      outgoing.end();
    }
  } finally {
    settled = true;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const server = createServer((incoming, outgoing) => {
  handle(incoming, outgoing).catch(() => {
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end();
  });
});

server.listen(Number(process.env.PORT ?? "8080"), "0.0.0.0");
