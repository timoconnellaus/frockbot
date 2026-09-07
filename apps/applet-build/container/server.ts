/**
 * The Node process inside the Cloudflare Container.
 *
 * It owns no build knowledge: it converts a Node request into a `Request`,
 * hands it to the decoder and then to `buildAppletRequestV1`, and writes the
 * answer back. Builds are serialized — the type checker, esbuild and a
 * Miniflare boot each want the whole box, and two concurrent builds on one
 * instance make both slower than they would have been in a queue.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  APPLET_BUILD_LIMITS,
  APPLET_BUILD_TOKEN_HEADER,
  appletBuildProblemResponseV1,
  decodeAppletBuildHttpRequestV1,
  encodeAppletBuildResponseV1,
} from "@frockbot/applets/build-contract";
import { buildAppletRequestV1 } from "./build.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`${name} is required by the Applet build service`);
  return value;
}

const hostToken = required("APPLET_BUILD_TOKEN");

/**
 * Constant-time comparison of the shared service token. The service binding
 * already makes this container unroutable from the internet; this is the
 * second of the two locks, because a container URL is a separate path to the
 * same port.
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
    if (size > APPLET_BUILD_LIMITS.requestBytes) {
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
    `http://${incoming.headers.host ?? "applet-build.internal"}${incoming.url ?? "/"}`,
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
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

/**
 * One build at a time. Each stage saturates the instance, so the queue is what
 * keeps a second caller's build from making the first one's slower than both
 * would have been in turn.
 */
let queue: Promise<unknown> = Promise.resolve();
let inFlight = 0;

function serialize<T>(work: () => Promise<T>): Promise<T> {
  inFlight += 1;
  const next = queue.then(work, work).finally(() => {
    inFlight -= 1;
  });
  queue = next.catch(() => {});
  return next;
}

async function handle(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Promise<void> {
  if (incoming.url === "/healthz") {
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ ok: true, inFlight }));
    return;
  }

  let request: Request;
  try {
    request = await webRequest(incoming);
  } catch (error) {
    await send(
      outgoing,
      (error instanceof Error ? error.message : "") === "request-too-large"
        ? appletBuildProblemResponseV1(
            413,
            "limit-exceeded",
            "request body too large",
          )
        : appletBuildProblemResponseV1(
            400,
            "invalid-request",
            "unreadable request",
          ),
    );
    return;
  }

  if (
    !tokenMatches(request.headers.get(APPLET_BUILD_TOKEN_HEADER) ?? undefined)
  ) {
    await send(
      outgoing,
      appletBuildProblemResponseV1(
        401,
        "not-authorized",
        "Applet build token is missing or wrong",
      ),
    );
    return;
  }

  const decoded = await decodeAppletBuildHttpRequestV1(request);
  if (!decoded.ok) {
    await send(outgoing, decoded.response);
    return;
  }

  try {
    const result = await serialize(() => buildAppletRequestV1(decoded.value));
    await send(outgoing, Response.json(encodeAppletBuildResponseV1(result)));
  } catch (error) {
    await send(
      outgoing,
      appletBuildProblemResponseV1(
        500,
        "provider-failure",
        error instanceof Error ? error.message : "the build failed",
      ),
    );
  }
}

const port = Number(process.env.PORT ?? 8080);
createServer((incoming, outgoing) => {
  void handle(incoming, outgoing).catch(() => {
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end();
  });
}).listen(port, () => {
  process.stdout.write(`applet build service listening on ${port}\n`);
});
