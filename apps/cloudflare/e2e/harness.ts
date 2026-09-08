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
// The Applet build service is real too: `apps/applet-build` runs under its own
// `wrangler dev` in the same dev service registry, so the app's `APPLET_BUILD`
// binding resolves and an Applet is compiled by the container production
// compiles it with. That needs Docker; `appletBuildAvailableV1` says whether
// this machine has it, and the one spec that builds an Applet fails with that
// sentence rather than passing without having built anything.
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
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
 * on 2026-08-31, and the same one `test/harness/miniflare.ts` reproduces for
 * the workerd layers: the catalog reads answer 200 for any key at all, and
 * only `POST /api/chat` and `POST /v1/chat/completions` authenticate.
 * Reproducing that asymmetry is what lets a spec prove a Connection is
 * validated by an inference call and not by a catalog read.
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

/**
 * The endpoint root one test's Connection points at.
 *
 * A path under the fake server's origin rather than the origin itself, so the
 * chat mode a spec switches on — `unauthorized`, `slow`, `streaming` — belongs
 * to that spec alone and the specs can run in parallel. An Ollama-compatible
 * endpoint behind a path prefix is a shape the product already supports:
 * `decodeOllamaApiBaseUrl` keeps the pathname, and every call composes onto it.
 */
export function e2eOllamaEndpointV1(serverUrl: string, scope: string): string {
  return `${serverUrl.replace(/\/+$/, "")}/s/${encodeURIComponent(scope)}`;
}

export function startFakeOllama(port: number): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  // Keyed by the scope in the endpoint the request arrived on. A request that
  // names no scope — nothing in the suite sends one — reads the shared default.
  const chatModes = new Map<string, FakeOllamaChatMode>();

  const server: Server = createHttpServer((request, response) => {
    const raw = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    const scoped = /^\/s\/([^/]+)(\/.*)?$/.exec(raw.pathname);
    const scope = scoped ? decodeURIComponent(scoped[1]) : "";
    const url = new URL(
      `${scoped ? (scoped[2] ?? "/") : raw.pathname}${raw.search}`,
      `http://127.0.0.1:${port}`,
    );
    const chatMode = chatModes.get(scope) ?? "ok";
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
        const mode: FakeOllamaChatMode =
          requested === "unauthorized" ||
          requested === "slow" ||
          requested === "streaming"
            ? requested
            : "ok";
        chatModes.set(scope, mode);
        json(200, { mode });
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

/** The bearer token `/api/debug/*` accepts in an end-to-end run. */
export const E2E_DEBUG_TOKEN = "e2e-debug-token";

/** The `--persist-to` directory of the run listening on `port`. */
export function e2ePersistDirectory(port: number): string {
  return join(tmpdir(), `frockbot-e2e-${port}`);
}

/** The shared secret the app Worker and the build service present each other. */
export const E2E_APPLET_BUILD_TOKEN = "e2e-applet-build-token";

/**
 * Whether this machine can run the Applet build service.
 *
 * `wrangler dev` builds and runs the container's image, which needs a running
 * Docker daemon. A spec calls this to say so out loud: an Applet build that
 * cannot happen is a spec that fails with the reason, never one that quietly
 * proves nothing.
 */
export function appletBuildAvailableV1(): boolean {
  return (
    spawnSync("docker", ["info"], { stdio: "ignore", timeout: 30_000 })
      .status === 0
  );
}

export interface HarnessOptions {
  /** The port `wrangler dev` listens on. */
  port: number;
  /** The port the fake Ollama server listens on. */
  ollamaPort: number;
  /** The port the auxiliary Frock AI RPC Worker listens on. */
  frockAiPort: number;
  /** The port the Applet build service listens on, when Docker can run it. */
  appletBuildPort: number;
}

export interface RunningHarness {
  baseUrl: string;
  ollamaUrl: string;
  frockAiUrl: string;
  /** The file both `wrangler dev` processes are teed into. */
  logFile: string;
  /** Absent when Docker is not running and the build service was not started. */
  appletBuildUrl?: string;
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
    options.appletBuildPort,
  ]);
  const workerInspectorPort = await reserveFreePort({ taken: reservedHere });
  const frockAiInspectorPort = await reserveFreePort({ taken: reservedHere });
  const appletBuildInspectorPort = await reserveFreePort({
    taken: reservedHere,
  });

  let ollama: Awaited<ReturnType<typeof startFakeOllama>> | undefined;
  let frockAi: SupervisedProcess | undefined;
  let appletBuild: SupervisedProcess | undefined;
  let worker: SupervisedProcess | undefined;

  const stop = async (): Promise<void> => {
    if (worker) await worker.stop();
    if (appletBuild) await appletBuild.stop();
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

  const spawnAppletBuild = (): ChildProcess =>
    spawn(
      "bunx",
      [
        "wrangler",
        "dev",
        "--ip",
        "127.0.0.1",
        "--port",
        String(options.appletBuildPort),
        "--inspector-port",
        String(appletBuildInspectorPort),
        // The same secret the app Worker presents, and the container re-checks.
        "--var",
        `APPLET_BUILD_TOKEN:${E2E_APPLET_BUILD_TOKEN}`,
        "--persist-to",
        persistDirectory,
        "--log-level",
        "warn",
      ],
      {
        cwd: resolve(cloudflareRoot, "../applet-build"),
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
        `BETTER_AUTH_URL:http://127.0.0.1:${options.port}`,
        "--var",
        `CREDENTIAL_KEYRING:${E2E_CREDENTIAL_KEYRING}`,
        // No Computer: the Sprite is unreachable from workerd and no spec
        // touches it. An empty token is what production hands a Worker with
        // no Computer configured.
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
        // The Applet build service, when this machine has Docker. The binding
        // is declared either way; without the token the app refuses a publish
        // with "the build service is unavailable" rather than calling a
        // service that is not there.
        "--var",
        `APPLET_BUILD_TOKEN:${E2E_APPLET_BUILD_TOKEN}`,
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

    // Before the app Worker, so the dev service registry already has the
    // service its APPLET_BUILD binding names.
    const appletBuildUrl = `http://127.0.0.1:${options.appletBuildPort}`;
    if (appletBuildAvailableV1()) {
      const supervisedAppletBuild = superviseProcess({
        label: "Applet build wrangler dev",
        spawnChild: spawnAppletBuild,
        // `/healthz` is the Worker's own route: it answers without starting a
        // container, so this waits for the Worker and the image build, not for
        // a cold container start.
        waitUntilReady: () => waitForHttpServer(`${appletBuildUrl}/healthz`),
        stopChild: stopProcessTree,
        forwardOutput,
        report: note,
      });
      appletBuild = supervisedAppletBuild;
      await supervisedAppletBuild.start();
    } else {
      note(
        "Docker is not running, so the Applet build service was not started and APPLET_BUILD reads [not connected].",
      );
    }

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
      ...(appletBuild ? { appletBuildUrl } : {}),
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
