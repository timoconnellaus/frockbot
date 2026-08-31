// The browser end-to-end harness.
//
// It boots the production serving path and nothing else: the real client
// bundle baked into `dist/artifacts/foundation-v1.mjs`, that artifact seeded
// into the local `APPLICATION_ARTIFACTS` bucket, and `src/index.ts` — the
// deployed Worker, unmodified — running under `wrangler dev`. A browser then
// talks to it exactly as it talks to production: gateway auth, the User
// Durable Object, the `USER_APPLICATIONS` Worker Loader, the Bot Durable
// Object, and the outbound provider seam.
//
// The steps are the ones `dev-electron.ts` already scripts for local
// development (`artifact:build` → `wrangler r2 object put --local` →
// `wrangler dev`), lifted here so the test layer runs the developer's own
// path rather than a second one.
//
// The provider is the one thing that is not real. `wrangler dev` has no
// `outboundService` knob, so the Worker's outbound `fetch` is the machine's,
// and a test must not depend on https://ollama.com. Instead this harness runs
// a fake Ollama HTTP server on a loopback port and each spec points its
// Connection at it through the Package's own `apiBaseUrl` Connection setting —
// a shipped product feature (Ollama-compatible endpoints, local Ollama), not a
// test-only branch.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cloudflareRoot = fileURLToPath(new URL("..", import.meta.url));

/** The key the fake server accepts for inference. */
export const E2E_OLLAMA_GOOD_API_KEY = "e2e-test-key";

/** Anything else is rejected by `POST /api/chat`, exactly as production is. */
export const E2E_OLLAMA_BAD_API_KEY = "e2e-not-a-key";

/** The model a spec selects; `gpt-oss:20b` is the Package's probe model. */
export const E2E_MODEL_ID = "gpt-oss:20b";
export const E2E_SECOND_MODEL_ID = "glm-5.3-flash:cloud";

/** The deterministic assistant reply, in Markdown so the renderer is proved. */
export const E2E_ASSISTANT_REPLY = "Reply from the **local Ollama stub**.";

/**
 * The fixture keyring. The User Durable Object mounts the Credential Store
 * Contribution the moment any User Contribution resolves, so a Worker without
 * a keyring cannot even create a Bot. This is the same fixture value
 * `test/harness/miniflare.ts` uses, and it holds nothing real; it is repeated
 * rather than imported because that module is loaded by Vitest configs and
 * this one by the Playwright config.
 */
export const E2E_CREDENTIAL_KEYRING = JSON.stringify({
  schemaVersion: 1,
  currentKeyId: "primary",
  keys: { primary: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY" },
});

/** How the fake server should answer chat completions. */
export type FakeOllamaChatMode = "ok" | "unauthorized";

const READY_TIMEOUT_MS = 120_000;
const SHUTDOWN_GRACE_MS = 5_000;

/**
 * Ask the operating system for a port nobody is listening on.
 *
 * The Playwright config reserves both ports in its own process and hands them
 * to this harness through the environment, so the specs know the fake server's
 * address without the harness having to report it back.
 */
export function reserveFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createTcpServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "string" || address === null) {
        server.close();
        reject(new Error("could not reserve a port"));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });
}

function unauthorized(): { status: number; body: string } {
  return { status: 401, body: JSON.stringify({ error: "Unauthorized" }) };
}

/**
 * A fake Ollama server.
 *
 * The authentication behaviour is the one measured against https://ollama.com
 * on 2026-08-31 and recorded in `docs/research/ollama-cloud-auth.md`, and the
 * same one `test/harness/miniflare.ts` reproduces for the workerd layers: the
 * catalog reads answer 200 for any key at all, and only `POST /api/chat` and
 * `POST /v1/chat/completions` authenticate. Reproducing that asymmetry is what
 * lets a spec prove a Connection is validated by an inference call and not by a
 * catalog read.
 *
 * `POST /__e2e/chat-mode` is not an Ollama route: it lets a spec revoke the key
 * mid-run, so a Turn can fail at the provider after the Connection is ready.
 */
export function startFakeOllama(port: number): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  let chatMode: FakeOllamaChatMode = "ok";

  const server: Server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    const header = request.headers.authorization ?? "";
    const key = header.toLowerCase().startsWith("bearer ")
      ? header.slice(7)
      : "";
    const json = (status: number, body: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };

    if (url.pathname === "/__e2e/chat-mode" && request.method === "POST") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const requested = String(
          (
            JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
              mode?: unknown;
            }
          ).mode,
        );
        chatMode = requested === "unauthorized" ? "unauthorized" : "ok";
        json(200, { mode: chatMode });
      });
      return;
    }

    // Unauthenticated in production, and unauthenticated here: a catalog read
    // can never distinguish a good key from a bad one.
    if (url.pathname === "/api/tags") {
      json(200, {
        models: [{ model: E2E_MODEL_ID }, { model: E2E_SECOND_MODEL_ID }],
      });
      return;
    }
    if (url.pathname === "/api/show") {
      request.resume();
      json(200, {
        capabilities: ["tools"],
        model_info: { "general.context_length": 8192 },
      });
      return;
    }
    if (url.pathname === "/api/chat") {
      request.resume();
      if (key !== E2E_OLLAMA_GOOD_API_KEY) {
        const refusal = unauthorized();
        response.writeHead(refusal.status, {
          "content-type": "application/json",
        });
        response.end(refusal.body);
        return;
      }
      json(200, {
        model: E2E_MODEL_ID,
        created_at: new Date(0).toISOString(),
        message: { role: "assistant", content: "h" },
        done: true,
        done_reason: "length",
      });
      return;
    }
    if (url.pathname === "/v1/chat/completions") {
      request.resume();
      if (key !== E2E_OLLAMA_GOOD_API_KEY || chatMode === "unauthorized") {
        const refusal = unauthorized();
        response.writeHead(refusal.status, {
          "content-type": "application/json",
        });
        response.end(refusal.body);
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: E2E_ASSISTANT_REPLY } }],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
        })}\n\n`,
      );
      response.write("data: [DONE]\n\n");
      response.end();
      return;
    }
    request.resume();
    json(404, { error: "unexpected Ollama request" });
  });

  return new Promise((resolveServer, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolveServer({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((closed) => {
            server.closeAllConnections();
            server.close(() => closed());
          }),
      });
    });
  });
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((done, fail) => {
    const child = spawn(command, args, {
      cwd: cloudflareRoot,
      stdio: "inherit",
    });
    child.on("error", fail);
    child.on("exit", (code) =>
      code === 0
        ? done()
        : fail(new Error(`${command} ${args.join(" ")} exited with ${code}`)),
    );
  });
}

/**
 * `wrangler dev` is a Node parent that supervises workerd. Killing the parent
 * alone leaves it free to respawn its child, so the harness puts wrangler in
 * its own process group (`detached`) and signals the whole group.
 */
async function stopProcessTree(child: ChildProcess): Promise<void> {
  const group = child.pid === undefined ? undefined : -child.pid;
  const signal = (name: NodeJS.Signals): void => {
    try {
      if (group === undefined) child.kill(name);
      else process.kill(group, name);
    } catch {
      // Already gone.
    }
  };
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((done) =>
      child.once("exit", () => done()),
    );
    signal("SIGTERM");
    const escalation = setTimeout(() => signal("SIGKILL"), SHUTDOWN_GRACE_MS);
    // Never block teardown on a process that refuses to die: escalate, give up
    // waiting, and let the caller finish releasing everything else.
    const abandoned = new Promise<void>((done) =>
      setTimeout(done, SHUTDOWN_GRACE_MS * 2).unref(),
    );
    await Promise.race([exited, abandoned]);
    clearTimeout(escalation);
  }
  // The Playwright `webServer` waits for this process's stdio to close, and an
  // inherited pipe held by a surviving grandchild would hang the run.
  child.stdout?.destroy();
  child.stderr?.destroy();
}

async function waitForManifest(baseUrl: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastFailure = "no attempt was made";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/app-manifest`, {
        headers: { "x-frockbot-user-id": "e2e-harness-readiness" },
      });
      if (response.ok) return;
      lastFailure = `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((sleep) => setTimeout(sleep, 250));
  }
  throw new Error(
    `Timed out waiting for ${baseUrl}/app-manifest: ${lastFailure}`,
  );
}

export interface HarnessOptions {
  /** The port `wrangler dev` listens on. */
  port: number;
  /** The port the fake Ollama server listens on. */
  ollamaPort: number;
}

export interface RunningHarness {
  baseUrl: string;
  ollamaUrl: string;
  stop(): Promise<void>;
}

/**
 * Build, seed, and serve. Every resource this creates is released by `stop()`,
 * including a `--persist-to` directory that is fresh for every run, so no
 * Durable Object, R2 object or D1 row survives from one run into the next.
 */
export async function startHarness(
  options: HarnessOptions,
): Promise<RunningHarness> {
  const persistDirectory = await mkdtemp(join(tmpdir(), "frockbot-e2e-"));
  let ollama: Awaited<ReturnType<typeof startFakeOllama>> | undefined;
  let worker: ChildProcess | undefined;

  const stop = async (): Promise<void> => {
    if (worker) await stopProcessTree(worker);
    if (ollama) await ollama.close();
    await rm(persistDirectory, { recursive: true, force: true });
  };

  try {
    await run("bun", ["run", "artifact:build"]);
    await run("bunx", [
      "wrangler",
      "--env",
      "e2e",
      "r2",
      "object",
      "put",
      "frockbot-application-artifacts/applications/foundation-v1.mjs",
      "--file",
      resolve(cloudflareRoot, "dist/artifacts/foundation-v1.mjs"),
      "--local",
      "--persist-to",
      persistDirectory,
    ]);

    ollama = await startFakeOllama(options.ollamaPort);

    worker = spawn(
      "bunx",
      [
        "wrangler",
        "dev",
        "--env",
        "e2e",
        "--ip",
        "127.0.0.1",
        "--port",
        String(options.port),
        // The gateway's development identity, the same one `bun run dev` and
        // the Electron shell use: `?as_user=` and `x-frockbot-user-id` stand in
        // for a Google session, so the layer needs no secret.
        "--var",
        "ALLOW_DEVELOPMENT_AUTH:true",
        "--var",
        `CREDENTIAL_KEYRING:${E2E_CREDENTIAL_KEYRING}`,
        // No Computer: the Sprite is unreachable from workerd (ADR 0004) and
        // no spec touches it. An empty token is what production hands a Worker
        // with no Computer configured.
        "--var",
        "SPRITES_TOKEN:",
        // better-auth needs a secret to construct; no spec signs in with it.
        "--var",
        "BETTER_AUTH_SECRET:e2e",
        "--persist-to",
        persistDirectory,
      ],
      // `detached` puts wrangler in its own process group so the whole tree can
      // be signalled at once: killing the Node parent alone leaves it free to
      // respawn workerd. Its output is piped rather than inherited for the same
      // reason — an inherited handle outlives the parent and would keep
      // Playwright waiting on a closed server.
      {
        cwd: cloudflareRoot,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    worker.stdout?.pipe(process.stdout);
    worker.stderr?.pipe(process.stderr);
    const baseUrl = `http://127.0.0.1:${options.port}`;
    const crashed = new Promise<never>((_, fail) => {
      worker?.once("exit", (code) =>
        fail(new Error(`wrangler dev exited early with code ${code}`)),
      );
      worker?.once("error", fail);
    });
    await Promise.race([waitForManifest(baseUrl), crashed]);

    return { baseUrl, ollamaUrl: ollama.url, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
