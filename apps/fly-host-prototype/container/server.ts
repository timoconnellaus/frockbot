import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { SpritesClient } from "@fly/sprites";
import {
  computerHostEffectResponseWireV1,
  decodeComputerHostEffectRequestV1,
  type ComputerHostEffectResponseV1,
} from "@frockbot/computer-core/host-protocol";
import { FlySpriteComputerProvider } from "@frockbot/plugin-fly-sprite/provider";
import WebSocket from "ws";
import {
  decodeSmokeHttpRequest,
  encodeSmokeResponse,
  type FlyHostSmokeRequest,
} from "./contracts.ts";

const commandTimeoutMs = 60_000;
const commandTerminationTimeoutMs = 5_000;

type SpriteCommand = ReturnType<ReturnType<SpritesClient["sprite"]>["spawn"]>;

function withTimeout<T>(
  operation: Promise<T>,
  phase: string,
  timeoutMs = commandTimeoutMs,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Sprites ${phase} timed out`)),
      timeoutMs,
    );
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function terminateCommand(command: SpriteCommand): Promise<void> {
  try {
    command.kill("SIGKILL");
  } catch (error) {
    void error;
  }
  try {
    await withTimeout(
      command.wait(),
      "command termination",
      commandTerminationTimeoutMs,
    );
  } catch (error) {
    void error;
  }
}

function spriteName(effectId: string): string {
  const suffix = createHash("sha256")
    .update(effectId)
    .digest("hex")
    .slice(0, 16);
  return `frockbot-test-${suffix}`;
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error && "statusCode" in error && error.statusCode === 404
  );
}

async function findOrCreateSprite(client: SpritesClient, name: string) {
  try {
    return await client.getSprite(name);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return client.createSprite(name);
  }
}

async function streamedEcho(
  client: SpritesClient,
  name: string,
  probe: string,
): Promise<string> {
  const command = client
    .sprite(name)
    .spawn("/bin/sh", ["-c", 'printf %s "$PROBE"'], {
      env: { PROBE: probe },
    });
  const chunks: Buffer[] = [];
  command.stdout.on("data", (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  const failed = new Promise<never>((_resolve, reject) => {
    command.once("error", reject);
  });
  try {
    await withTimeout(
      Promise.race([once(command, "spawn"), failed]),
      "streaming spawn",
    );
    const exitCode = await withTimeout(
      Promise.race([command.wait(), failed]),
      "streaming completion",
    );
    if (exitCode !== 0) {
      throw new Error(`Sprites streaming probe exited with ${exitCode}`);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    await terminateCommand(command);
    throw error;
  }
}

async function cancellationProbe(
  client: SpritesClient,
  name: string,
): Promise<boolean> {
  const command = client
    .sprite(name)
    .spawn("/bin/sh", [
      "-c",
      "trap 'exit 73' TERM; printf ready; while :; do sleep 1; done",
    ]);
  const failed = new Promise<never>((_resolve, reject) => {
    command.once("error", reject);
  });
  const ready = once(command.stdout, "data");
  try {
    await withTimeout(
      Promise.race([once(command, "spawn"), failed]),
      "cancellation spawn",
    );
    const [chunk] = await withTimeout(
      Promise.race([ready, failed]),
      "cancellation readiness",
    );
    if (String(chunk) !== "ready") {
      throw new Error("Sprites cancellation probe did not become ready");
    }

    command.kill("SIGTERM");
    const exitCode = await withTimeout(
      Promise.race([command.wait(), failed]),
      "cancellation completion",
    );
    return exitCode === 73;
  } catch (error) {
    await terminateCommand(command);
    throw error;
  }
}

async function smoke(
  request: FlyHostSmokeRequest,
  token: string,
): Promise<Response> {
  const client = new SpritesClient(token);
  const name = spriteName(request.effectId);
  let evidence: Omit<
    Parameters<typeof encodeSmokeResponse>[0],
    "cleanupObserved"
  >;
  try {
    const sprite = await findOrCreateSprite(client, name);
    const stream = await streamedEcho(client, name, request.probe);
    const fileSystem = sprite.filesystem("/tmp");
    await fileSystem.writeFile("frockbot-probe.txt", request.probe);
    const file = await fileSystem.readFile("frockbot-probe.txt", "utf8");

    const reconstructedClient = new SpritesClient(token);
    const reconstructed = await reconstructedClient.getSprite(name);
    const reconstructedFile = await reconstructed
      .filesystem("/tmp")
      .readFile("frockbot-probe.txt", "utf8");
    const cancellationObserved = await cancellationProbe(client, name);

    evidence = {
      effectId: request.effectId,
      stream,
      file,
      cancellationObserved,
      reconstructionObserved: reconstructedFile === request.probe,
    };
  } finally {
    try {
      await client.deleteSprite(name);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  let cleanupObserved = false;
  try {
    await client.getSprite(name);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    cleanupObserved = true;
  }
  return Response.json(encodeSmokeResponse({ ...evidence, cleanupObserved }));
}

function problem(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

const configuredToken = process.env.SPRITES_TOKEN;
if (!configuredToken) {
  throw new Error("SPRITES_TOKEN is required by the Fly host container");
}
const token: string = configuredToken;

Object.defineProperty(globalThis, "WebSocket", { value: WebSocket });

async function executeEffect(request: Request): Promise<Response> {
  let effect;
  try {
    effect = decodeComputerHostEffectRequestV1(await request.json());
  } catch (error) {
    return problem(
      400,
      error instanceof Error ? error.message : "invalid Computer effect",
    );
  }
  let response: ComputerHostEffectResponseV1;
  const provider = new FlySpriteComputerProvider(undefined, token);
  try {
    const computer = await provider.open(effect.target, {
      providerId: "fly-sprite",
      generation: effect.assignment.generation,
    });
    try {
      if (effect.operation.type === "exec") {
        if (!computer.exec) throw new Error("Computer exec is unavailable");
        response = {
          schemaVersion: 1,
          effectId: effect.effectId,
          status: "completed",
          result: {
            type: "exec",
            result: await computer.exec.execute(effect.operation.request, {
              signal: request.signal,
              effectId: effect.effectId,
            }),
          },
        };
      } else {
        if (!computer.browser) {
          throw new Error("Computer browser is unavailable");
        }
        response = {
          schemaVersion: 1,
          effectId: effect.effectId,
          status: "completed",
          result: {
            type: "browser",
            result: await computer.browser.perform(effect.operation.action, {
              signal: request.signal,
              effectId: effect.effectId,
            }),
          },
        };
      }
    } finally {
      await computer.close();
    }
  } catch (error) {
    response = {
      schemaVersion: 1,
      effectId: effect.effectId,
      status: "rejected",
      failure:
        error instanceof Error ? error.message : "Computer effect failed",
    };
  }
  return Response.json(computerHostEffectResponseWireV1(response));
}

function requestUrl(request: Request): URL {
  try {
    return new URL(request.url);
  } catch {
    throw new Error("Computer host request URL is invalid");
  }
}

async function handle(request: Request): Promise<Response> {
  const url = requestUrl(request);
  if (url.pathname === "/v1/effects" && request.method === "POST") {
    return executeEffect(request);
  }
  const decoded = await decodeSmokeHttpRequest(request);
  if (!decoded.ok) return decoded.response;
  try {
    return await smoke(decoded.value, token);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return problem(502, message);
  }
}

async function webRequest(request: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 64 * 1_024) {
      throw new Error("request-too-large");
    }
    chunks.push(bytes);
  }
  const method = request.method ?? "GET";
  return new Request(
    `http://${request.headers.host ?? "fly-host.internal"}${request.url ?? "/"}`,
    {
      method,
      headers: request.headers as HeadersInit,
      body:
        method === "GET" || method === "HEAD"
          ? undefined
          : Buffer.concat(chunks),
    },
  );
}

const server = createServer(async (incoming, outgoing) => {
  let response: Response;
  try {
    response = await handle(await webRequest(incoming));
  } catch (error) {
    response = problem(
      error instanceof Error && error.message === "request-too-large"
        ? 413
        : 500,
      "invalid-request",
    );
  }
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(Number(process.env.PORT ?? "8080"), "0.0.0.0");
