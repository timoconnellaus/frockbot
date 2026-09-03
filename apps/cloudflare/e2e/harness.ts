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
// The providers are the only things that are not real. `wrangler dev` has no
// `outboundService` knob, so the Worker's outbound `fetch` is the machine's,
// and a test must not depend on https://ollama.com. Instead this harness runs
// a fake Ollama HTTP server on a loopback port and each spec points its
// Connection at it through the Package's own `api-base-url` Connection setting —
// a shipped product feature (Ollama-compatible endpoints, local Ollama), not a
// test-only branch. Flock AI is an auxiliary local Wrangler process,
// discovered through Wrangler's dev service registry and bound under `AI` at
// the Gateway and native-image seams.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { mkdir, readFile, rm } from "node:fs/promises";
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

/**
 * How the fake server should answer chat completions.
 *
 * `slow` answers exactly as `ok` does, after a pause long enough for a spec to
 * reload the page while the Turn is still running. It is the only way to test
 * what a browser does with a Turn it is not holding open.
 */
export type FakeOllamaChatMode = "ok" | "unauthorized" | "slow";

/** How long `slow` holds a chat completion before it answers. */
export const E2E_SLOW_CHAT_DELAY_MS = 10_000;

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
/**
 * The trigger a spec puts in the message it sends, so the fake model calls a
 * tool.
 *
 * The same device `test/harness/miniflare.ts` uses for the workerd layers, and
 * for the same reason: one fake server serves every spec in the run and cannot
 * be reconfigured per test, so the script travels on the wire with the request
 * it belongs to. A tool result falls through to prose, or the loop would call
 * the same tool until it exhausted its step budget.
 */
export const E2E_TOOL_CALL_TRIGGER = "frockbot-e2e-tool-call:";

export function e2eToolCallPrompt(name: string, input: unknown = {}): string {
  return `${E2E_TOOL_CALL_TRIGGER}${name}:${JSON.stringify(input)}`;
}

function scriptedToolCalls(
  body: string,
): Array<{ name: string; arguments: string }> {
  let parsed: { messages?: unknown };
  try {
    parsed = JSON.parse(body || "{}") as { messages?: unknown };
  } catch {
    return [];
  }
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const last = messages.at(-1) as { role?: unknown } | undefined;
  if (last?.role === "tool") return [];
  // The *last* user message only, stringified: a provider may send the user
  // turn as parts rather than a string, and the trigger only has to be found,
  // not parsed. Earlier user messages travel with every later request, so
  // reading them all would replay every Turn's tool call on every Turn after.
  const lastUser = messages.findLast(
    (message) => (message as { role?: unknown }).role === "user",
  ) as { content?: unknown } | undefined;
  const value = lastUser?.content;
  const content =
    typeof value === "string" ? value : JSON.stringify(value ?? "");
  const calls: Array<{ name: string; arguments: string }> = [];
  // A JSON-encoded message escapes the newline, so both separators end a
  // trigger line.
  for (const line of content.split(/\\n|\n/)) {
    const trimmed = line.trim();
    const start = trimmed.indexOf(E2E_TOOL_CALL_TRIGGER);
    if (start < 0) continue;
    const rest = trimmed.slice(start + E2E_TOOL_CALL_TRIGGER.length);
    const separator = rest.indexOf(":");
    if (separator < 0) continue;
    calls.push({
      name: rest.slice(0, separator),
      arguments: rest.slice(separator + 1),
    });
  }
  return calls;
}

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
        chatMode =
          requested === "unauthorized" || requested === "slow"
            ? requested
            : "ok";
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
      if (key !== E2E_OLLAMA_GOOD_API_KEY || chatMode === "unauthorized") {
        request.resume();
        const refusal = unauthorized();
        response.writeHead(refusal.status, {
          "content-type": "application/json",
        });
        response.end(refusal.body);
        return;
      }
      const chunks: Buffer[] = [];
      const slow = chatMode === "slow";
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const answer = () => {
          const calls = scriptedToolCalls(
            Buffer.concat(chunks).toString("utf8"),
          );
          response.writeHead(200, { "content-type": "text/event-stream" });
          if (calls.length > 0) {
            response.write(
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: calls.map((call, index) => ({
                        index,
                        id: `e2e-call-${index}`,
                        type: "function",
                        function: {
                          name: call.name,
                          arguments: call.arguments,
                        },
                      })),
                    },
                  },
                ],
              })}\n\n`,
            );
            response.write(
              `data: ${JSON.stringify({
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
              })}\n\n`,
            );
          } else {
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
          }
          response.write("data: [DONE]\n\n");
          response.end();
        };
        if (!slow) {
          answer();
          return;
        }
        // The Turn is still running while the spec reloads the page. The
        // timer is unreferenced so a finished spec never waits on it.
        setTimeout(answer, E2E_SLOW_CHAT_DELAY_MS).unref();
      });
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

/**
 * Seed the remote Package Catalog the way the production deploy does: build one
 * immutable generation with `scripts/publish-catalog.ts`, then put its
 * documents into the local bucket. Without it `GET /catalog/v1/index` answers
 * 503 and the Plugins surface opens with a load error on every spec.
 *
 * Only the pointer and the index are uploaded. Entry documents are read one at
 * a time, when a User opens a Catalog row, and no spec opens one; each
 * `wrangler r2 object put` costs several seconds of wrangler start-up, and 23
 * unread entries would cost more than the whole browser layer. A spec that
 * opens a row must seed that entry — its key is
 * `catalog/<generation>/entry/<catalogId>.json` in the same directory.
 */
async function seedPackageCatalog(persistDirectory: string): Promise<void> {
  const source = join(persistDirectory, "catalog-source");
  await run("bun", [
    resolve(cloudflareRoot, "../../scripts/publish-catalog.ts"),
    "--out",
    source,
  ]);
  const pointerPath = join(source, "catalog", "current");
  const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as {
    generation?: unknown;
  };
  if (typeof pointer.generation !== "string") {
    throw new Error("the published Catalog pointer names no generation");
  }
  const indexKey = `catalog/${pointer.generation}/index.json`;
  // The index first, so the pointer never names a generation that is not there.
  for (const [key, file] of [
    [indexKey, join(source, "catalog", pointer.generation, "index.json")],
    ["catalog/current", pointerPath],
  ] as const) {
    await run("bunx", [
      "wrangler",
      "--env",
      "e2e",
      "r2",
      "object",
      "put",
      `frockbot-package-catalog/${key}`,
      "--file",
      file,
      "--content-type",
      "application/json",
      "--local",
      "--persist-to",
      persistDirectory,
    ]);
  }
}

/** The bearer token `/api/debug/*` accepts in an end-to-end run. */
export const E2E_DEBUG_TOKEN = "e2e-debug-token";

/** The `--persist-to` directory of the run listening on `port`. */
export function e2ePersistDirectory(port: number): string {
  return join(tmpdir(), `frockbot-e2e-${port}`);
}

/** The bearer token the Workspace seed door accepts in an end-to-end run. */
export const E2E_WORKSPACE_SEED_TOKEN = "e2e-workspace-seed-token";

/**
 * Land one file in one of the User's durable roots while the Worker is up.
 *
 * Production has exactly one writer of a durable root's bytes besides the
 * Package that owns it: the Computer's sync. An end-to-end run has no Computer,
 * so a spec that needs a file "the Computer wrote" — an Applet's `dist/` after
 * `applet build` — writes it through the gateway's seed door, which the Bot
 * Durable Object serves as a User write over the same store and generation
 * record the sync uses. Nothing else is faked: the publish that reads it is
 * real.
 *
 * Over HTTP rather than a second `wrangler r2 object put` against the running
 * server's `--persist-to` directory: that second process shares the local
 * store's files with the live one, and on Linux it took the dev server down.
 */
export async function seedWorkspaceFile(
  baseUrl: string,
  userId: string,
  botId: string,
  root: unknown,
  path: string,
  file: string,
  mediaType: string,
): Promise<void> {
  const bytes = await readFile(file);
  const response = await fetch(
    `${baseUrl}/api/workspace-seed/${encodeURIComponent(userId)}/${encodeURIComponent(botId)}`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${E2E_WORKSPACE_SEED_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        root,
        path,
        bytesBase64: Buffer.from(bytes).toString("base64"),
        mediaType,
      }),
    },
  );
  const outcome = (await response.json()) as {
    status?: string;
    reason?: string;
  };
  if (!response.ok || outcome.status !== "written") {
    throw new Error(
      `seeding ${path} failed: ${response.status} ${outcome.reason ?? ""}`,
    );
  }
}

export interface HarnessOptions {
  /** The port `wrangler dev` listens on. */
  port: number;
  /** The port the fake Ollama server listens on. */
  ollamaPort: number;
  /** The port the auxiliary Flock AI RPC Worker listens on. */
  flockAiPort: number;
}

export interface RunningHarness {
  baseUrl: string;
  ollamaUrl: string;
  flockAiUrl: string;
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
  // Named by port rather than random, so a spec that must seed object storage
  // while the Worker runs — an Applet's built `dist/`, which only a Computer
  // writes in production — can find the same directory from
  // `FROCKBOT_E2E_PORT` (see `e2ePersistDirectory`). Still fresh per run.
  const persistDirectory = e2ePersistDirectory(options.port);
  await rm(persistDirectory, { recursive: true, force: true });
  await mkdir(persistDirectory, { recursive: true });
  let ollama: Awaited<ReturnType<typeof startFakeOllama>> | undefined;
  let flockAi: ChildProcess | undefined;
  let worker: ChildProcess | undefined;

  const stop = async (): Promise<void> => {
    if (worker) await stopProcessTree(worker);
    if (flockAi) await stopProcessTree(flockAi);
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

    await seedPackageCatalog(persistDirectory);

    ollama = await startFakeOllama(options.ollamaPort);

    flockAi = spawn(
      "bunx",
      [
        "wrangler",
        "dev",
        "--config",
        resolve(cloudflareRoot, "e2e/flock-ai-fake.wrangler.jsonc"),
        "--env",
        "e2e",
        "--ip",
        "127.0.0.1",
        "--port",
        String(options.flockAiPort),
        // A line per request, times two Workers and seventeen specs, is the
        // bulk of what this harness forwards. Warnings and errors — the only
        // output a failing run is read for — still print.
        "--log-level",
        "warn",
      ],
      {
        cwd: cloudflareRoot,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    forwardOutput(flockAi);
    const flockAiUrl = `http://127.0.0.1:${options.flockAiPort}`;
    const flockAiCrashed = processFailure(
      flockAi,
      "Flock AI fake wrangler dev",
    );
    await Promise.race([waitForHttpServer(flockAiUrl), flockAiCrashed]);

    worker = spawn(
      "bunx",
      [
        "wrangler",
        "dev",
        "--config",
        resolve(cloudflareRoot, "wrangler.jsonc"),
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
        // Applet viewer tokens are HMACs over this; any value works locally.
        "--var",
        "APPLET_VIEWER_SECRET:e2e-applet-viewer-secret",
        // The operator surface, so a spec can read a Turn's tool results — the
        // transcript deliberately hides them — when it has to explain a state.
        "--var",
        `DEBUG_TOKEN:${E2E_DEBUG_TOKEN}`,
        // The Workspace seed door: how a run with no Computer lands a file
        // the Computer would have written. See `seedWorkspaceFile`.
        "--var",
        `WORKSPACE_SEED_TOKEN:${E2E_WORKSPACE_SEED_TOKEN}`,
        "--persist-to",
        persistDirectory,
        // As above: the per-request log is the flood, not the signal.
        "--log-level",
        "warn",
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
    forwardOutput(worker);
    const baseUrl = `http://127.0.0.1:${options.port}`;
    const crashed = processFailure(worker, "FrockBot wrangler dev");
    await Promise.race([waitForManifest(baseUrl), crashed, flockAiCrashed]);

    return { baseUrl, ollamaUrl: ollama.url, flockAiUrl, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * Forward a child's output without ever letting a slow reader stall the child.
 *
 * `stream.pipe(process.stdout)` honours backpressure: when the far end of this
 * process's own stdout is slow — Playwright's `webServer` pipe, itself read by
 * a workspace runner that redraws a terminal — `pipe` stops reading the child.
 * `wrangler dev` then stops draining the workerd it supervises, workerd's
 * `write()` to the pipe fails, and the runtime dies mid-suite:
 * `kj/async-io-unix.c++: disconnected: ::write(...): Broken pipe`. Every spec
 * after that meets `ERR_CONNECTION_REFUSED`.
 *
 * Copying each chunk on `data` keeps the child's pipe drained no matter how
 * slow the consumer is; the backlog becomes memory in this short-lived process
 * instead of a dead Worker runtime.
 */
function forwardOutput(child: ChildProcess): void {
  child.stdout?.on("data", (chunk: Buffer) => void process.stdout.write(chunk));
  child.stderr?.on("data", (chunk: Buffer) => void process.stderr.write(chunk));
}

function processFailure(child: ChildProcess, label: string): Promise<never> {
  return new Promise<never>((_, fail) => {
    child.once("exit", (code) =>
      fail(new Error(`${label} exited early with code ${code}`)),
    );
    child.once("error", fail);
  });
}

async function waitForHttpServer(baseUrl: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastFailure = "no attempt was made";
  while (Date.now() < deadline) {
    try {
      await fetch(baseUrl);
      return;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((sleep) => setTimeout(sleep, 250));
  }
  throw new Error(`Timed out waiting for ${baseUrl}: ${lastFailure}`);
}
