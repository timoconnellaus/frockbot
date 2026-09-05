import { createComposioFake } from "../test/composio-fake.js";
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
// test-only branch. Frock AI is an auxiliary local Wrangler process,
// discovered through Wrangler's dev service registry and bound under `AI` at
// the Gateway and native-image seams.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer, type Server } from "node:http";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reserveFreePort } from "./ports.ts";
import {
  OutputTail,
  superviseProcess,
  type SupervisedProcess,
} from "./supervisor.ts";

export { reserveFreePort } from "./ports.ts";

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
 *
 * `streaming` answers with the same words, split across two deltas with a gap
 * between them, so the first half of the reply is durable while the Turn is
 * still running. It is the only way to see what a browser draws mid-sentence.
 */
export type FakeOllamaChatMode = "ok" | "unauthorized" | "slow" | "streaming";

/** How long `slow` holds a chat completion before it answers. */
export const E2E_SLOW_CHAT_DELAY_MS = 10_000;

/** The first delta `streaming` sends, and the gap before the rest follows. */
export const E2E_STREAMED_REPLY_HEAD = "Reply from the ";
export const E2E_STREAMED_REPLY_TAIL = "**local Ollama stub**.";
export const E2E_STREAM_GAP_MS = 8_000;

const READY_TIMEOUT_MS = 120_000;
const SHUTDOWN_GRACE_MS = 5_000;

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
  const composio = createComposioFake();

  const server: Server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith("/composio/")) {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const providerUrl = new URL(url);
        providerUrl.pathname = providerUrl.pathname.replace("/composio", "");
        void composio(
          new Request(providerUrl, {
            method: request.method,
            headers: {
              "x-api-key": String(request.headers["x-api-key"] ?? ""),
            },
            ...(request.method !== "GET"
              ? { body: Buffer.concat(chunks).toString("utf8") }
              : {}),
          }),
        )
          .then(async (result) => {
            response.writeHead(result.status, {
              "content-type": "application/json",
            });
            response.end(await result.text());
          })
          .catch(() => {
            response.writeHead(500);
            response.end("Provider stand-in failed");
          });
      });
      return;
    }
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
          requested === "unauthorized" ||
          requested === "slow" ||
          requested === "streaming"
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
      const streaming = chatMode === "streaming";
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
          } else if (streaming) {
            // Half the answer now, half after a gap: the words the person can
            // already read are durable while the Turn is still running.
            response.write(
              `data: ${JSON.stringify({
                choices: [{ delta: { content: E2E_STREAMED_REPLY_HEAD } }],
              })}\n\n`,
            );
            setTimeout(() => {
              response.write(
                `data: ${JSON.stringify({
                  choices: [{ delta: { content: E2E_STREAMED_REPLY_TAIL } }],
                })}\n\n`,
              );
              response.write(
                `data: ${JSON.stringify({
                  choices: [{ delta: {}, finish_reason: "stop" }],
                })}\n\n`,
              );
              response.write("data: [DONE]\n\n");
              response.end();
            }, E2E_STREAM_GAP_MS).unref();
            return;
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
  /** The port the auxiliary Frock AI RPC Worker listens on. */
  frockAiPort: number;
}

export interface RunningHarness {
  baseUrl: string;
  ollamaUrl: string;
  frockAiUrl: string;
  /** The file both `wrangler dev` processes are teed into. */
  logFile: string;
  /** How many times each supervised server has had to be restarted. */
  restarts(): { worker: number; frockAi: number };
  stop(): Promise<void>;
}

/**
 * Where the harness tees everything its children print.
 *
 * `wrangler dev`'s own debug log goes to `~/.config/.wrangler/logs`, which a CI
 * artifact upload cannot address — `actions/upload-artifact` does not expand
 * `~`, so that upload has silently produced nothing — and Playwright's
 * `[WebServer]` prefix in the job log is cut off at the point a shard fails. A
 * file inside the workspace is addressable by both.
 */
export function harnessLogDirectory(): string {
  return resolve(cloudflareRoot, "e2e/wrangler-logs");
}

/**
 * Build, seed, and serve. Every resource this creates is released by `stop()`,
 * including a `--persist-to` directory that is fresh for every run, so no
 * Durable Object, R2 object or D1 row survives from one run into the next.
 *
 * Both `wrangler dev` processes are supervised: an exit nobody asked for is
 * followed by a fresh one on the same port and the same `--persist-to`
 * directory. See `supervisor.ts` for why.
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

  const logDirectory = harnessLogDirectory();
  mkdirSync(logDirectory, { recursive: true });
  const logFile = join(logDirectory, `harness-${options.port}.log`);
  const log: WriteStream = createWriteStream(logFile, { flags: "a" });
  const note = (message: string): void => {
    process.stderr.write(`${message}\n`);
    log.write(`${message}\n`);
  };

  /**
   * Forward a child's output without ever letting a slow reader stall it.
   *
   * `stream.pipe(process.stdout)` honours backpressure: when the far end of
   * this process's own stdout is slow — Playwright's `webServer` pipe, itself
   * read by a workspace runner that redraws a terminal — `pipe` stops reading
   * the child. `wrangler dev` then stops draining the workerd it supervises,
   * workerd's `write()` to the pipe fails, and the runtime dies mid-suite:
   * `kj/async-io-unix.c++: disconnected: ::write(...): Broken pipe`.
   *
   * Copying each chunk on `data` keeps the child's pipe drained no matter how
   * slow the consumer is; the backlog becomes memory in this short-lived
   * process instead of a dead Worker runtime. Each chunk also reaches the log
   * file CI uploads and the tail the supervisor prints on a crash.
   */
  const forwardOutput = (child: ChildProcess, tail: OutputTail): void => {
    for (const [stream, sink] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ] as const) {
      stream?.on("data", (chunk: Buffer) => {
        sink.write(chunk);
        log.write(chunk);
        tail.write(String(chunk));
      });
    }
  };

  // An inspector port each, out of the same non-ephemeral window as the app
  // ports. Left unset, wrangler picks its own out of the kernel's ephemeral
  // range — which is exactly the collision this harness has been losing to.
  // The three ports the Playwright config already chose were reserved in a
  // different process, so they are absent from this one's ledger and would
  // otherwise be fair game — and none of them is bound yet, so a probe would
  // say they are free.
  const reservedHere = new Set([
    options.port,
    options.ollamaPort,
    options.frockAiPort,
  ]);
  const workerInspectorPort = await reserveFreePort({ taken: reservedHere });
  const frockAiInspectorPort = await reserveFreePort({ taken: reservedHere });

  let ollama: Awaited<ReturnType<typeof startFakeOllama>> | undefined;
  let frockAi: SupervisedProcess | undefined;
  let worker: SupervisedProcess | undefined;

  const stop = async (): Promise<void> => {
    if (worker) await worker.stop();
    if (frockAi) await frockAi.stop();
    if (ollama) await ollama.close();
    await new Promise<void>((closed) => log.end(closed));
    await rm(persistDirectory, { recursive: true, force: true });
  };

  const childEnvironment = {
    ...process.env,
    // Wrangler's own debug log, next to the harness's, so one artifact holds
    // both halves of a crash.
    WRANGLER_LOG_PATH: `${logDirectory}/`,
  };

  const spawnFrockAi = (): ChildProcess =>
    spawn(
      "bunx",
      [
        "wrangler",
        "dev",
        "--config",
        resolve(cloudflareRoot, "e2e/frock-ai-fake.wrangler.jsonc"),
        "--env",
        "e2e",
        "--ip",
        "127.0.0.1",
        "--port",
        String(options.frockAiPort),
        "--inspector-port",
        String(frockAiInspectorPort),
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
        env: childEnvironment,
      },
    );

  const spawnWorker = (): ChildProcess =>
    spawn(
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
        "--inspector-port",
        String(workerInspectorPort),
        // The gateway's development identity, the same one `bun run dev` and
        // the Electron shell use: `?as_user=` and `x-frockbot-user-id` stand in
        // for a Google session, so the layer needs no secret.
        "--var",
        "ALLOW_DEVELOPMENT_AUTH:true",
        "--var",
        "COMPOSIO_API_KEY:test-composio-backend-key",
        "--var",
        `COMPOSIO_TEST_URL:http://127.0.0.1:${options.ollamaPort}/composio/api/v3.1`,
        "--var",
        `BETTER_AUTH_URL:http://127.0.0.1:${options.port}`,
        "--var",
        "FROCKBOT_AUTHORIZATION_STATE_SECRET:e2e-composio-state-independent-secret-0123456789",

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
        // Dictation's provider, faked like every other one: the `VoiceSession`
        // object opens this instead of OpenAI or the AI Gateway, so the layer
        // needs no key and spends nothing. Production sets no such var.
        "--var",
        `VOICE_UPSTREAM_URL:ws://127.0.0.1:${options.frockAiPort}/v1/realtime`,
        "--var",
        // Gemini Live's fake provider. The test-only query also shortens the
        // production two-minute silence ceiling so the offline state is
        // observable without making the suite wait two minutes.
        `VOICE_ASSISTANT_UPSTREAM_URL:ws://127.0.0.1:${options.frockAiPort}/v1/gemini-live?frock_idle_ms=5000`,
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
        env: childEnvironment,
      },
    );

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

    const frockAiUrl = `http://127.0.0.1:${options.frockAiPort}`;
    const supervisedFrockAi = superviseProcess({
      label: "Frock AI fake wrangler dev",
      spawnChild: spawnFrockAi,
      waitUntilReady: () => waitForHttpServer(frockAiUrl),
      stopChild: stopProcessTree,
      forwardOutput,
      report: note,
    });
    frockAi = supervisedFrockAi;
    await supervisedFrockAi.start();

    const baseUrl = `http://127.0.0.1:${options.port}`;
    const supervisedWorker = superviseProcess({
      label: "FrockBot wrangler dev",
      spawnChild: spawnWorker,
      waitUntilReady: () => waitForManifest(baseUrl),
      stopChild: stopProcessTree,
      forwardOutput,
      report: note,
    });
    worker = supervisedWorker;
    await supervisedWorker.start();

    return {
      baseUrl,
      ollamaUrl: ollama.url,
      frockAiUrl,
      logFile,
      restarts: () => ({
        worker: supervisedWorker.restarts(),
        frockAi: supervisedFrockAi.restarts(),
      }),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
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
