/**
 * The opt-in live test: the production container image, built by Docker and
 * run against a real, disposable Fly Sprite.
 *
 * It exists for the one thing no fake can prove. ADR 0004 records a measured
 * HTTP 431 from Fly when a ~2.5 KB provisioning script travelled on a
 * command's argv, and the whole shape of this host — `bash -s`, script on
 * stdin, bytes through the filesystem API — is the answer to it. Only a real
 * Sprite can say whether the answer works, so this test sends a script far
 * larger than the one that failed and asserts exit 0.
 *
 * Run it with Docker available and `SPRITES_TOKEN` in a gitignored
 * `.dev.vars`:
 *
 *     bun run --filter @frockbot/computer-host test:live
 *
 * The Sprite is named `frockbot-test-<runId>-…` and deleted in a `finally`.
 * Every `frockbot-test-` Sprite is swept at the end, so a killed run leaks
 * nothing beyond the next one.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SpritesClient } from "@fly/sprites";
import WebSocket from "ws";
import {
  COMPUTER_HOST_ROUTES,
  COMPUTER_HOST_TOKEN_HEADER,
  ComputerHostExecFrameReaderV1,
  decodeComputerHostExecResultV1,
  decodeComputerHostFileReadResultV1,
  decodeComputerHostOpenResultV1,
  type ComputerHostExecFrameV1,
  type ComputerHostOperationV1,
} from "@frockbot/computer-host-protocol";
import {
  COMPUTER_RUNTIME_FILES,
  computerSpriteNameSourceV1,
  computerSpriteNameV1,
  ENSURE_AGENT_SCRIPT,
  RUNTIME_ROOT,
} from "@frockbot/computer-host-runtime";
import { COMPUTER_HOST_STATE_PATH } from "./container/computer.ts";

Object.defineProperty(globalThis, "WebSocket", { value: WebSocket });

const root = import.meta.dirname;
const repositoryRoot = resolve(root, "../..");
const port = 18_080;
const origin = `http://127.0.0.1:${port}`;
const runId = randomUUID().replaceAll("-", "").slice(0, 8);
const spriteBase = `frockbot-test-${runId}`;
const containerName = `frockbot-computer-host-live-${runId}`;
const imageTag = `frockbot-computer-host-live:${runId}`;
const userId = "live-user";
const botId = "live-bot";
const hostToken = randomUUID();
const spriteName = computerSpriteNameV1(
  userId,
  createHash("sha256").update(computerSpriteNameSourceV1(userId)).digest("hex"),
  spriteBase,
);

/** Never printed, never logged, never passed on a command line. */
async function spritesToken(): Promise<string> {
  for (const path of [
    resolve(root, ".dev.vars"),
    resolve(repositoryRoot, "apps/cloudflare/.dev.vars"),
  ]) {
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const match = source.match(/^\s*SPRITES_TOKEN\s*=\s*"?([^"\r\n]+)"?\s*$/m);
    if (match?.[1]) return match[1];
  }
  throw new Error(
    "Add SPRITES_TOKEN to apps/cloudflare/.dev.vars before running the live test",
  );
}

async function run(
  command: string[],
  options: { env?: Record<string, string>; quiet?: boolean } = {},
): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
    ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  if (code !== 0) {
    throw new Error(
      `${command[0]} ${command[1]} failed (${code}): ${stderr.slice(-2_000)}`,
    );
  }
  if (!options.quiet && stderr.trim()) process.stderr.write(`${stderr}\n`);
  return stdout;
}

function body(
  operation: ComputerHostOperationV1,
  effectId: string,
): Record<string, unknown> {
  const { kind, ...rest } = operation;
  void kind;
  return {
    version: 1,
    effectId,
    identity: { userId },
    tenant: { botId },
    credentialRef: `sprites:user:${userId}`,
    ...rest,
  };
}

async function call(
  route: string,
  operation: ComputerHostOperationV1,
  effectId = `effect-${randomUUID()}`,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${origin}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [COMPUTER_HOST_TOKEN_HEADER]: hostToken,
    },
    body: JSON.stringify(body(operation, effectId)),
    ...(signal ? { signal } : {}),
  });
}

async function expectOk(response: Response, label: string): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${label} answered ${response.status}: ${text.slice(0, 500)}`,
    );
  }
  return JSON.parse(text);
}

async function waitForHealth(deadlineMs = 120_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) return;
    } catch {
      /* not listening yet */
    }
    await Bun.sleep(250);
  }
  throw new Error("Timed out waiting for the Computer host container");
}

async function readFrames(
  response: Response,
): Promise<ComputerHostExecFrameV1[]> {
  const reader = new ComputerHostExecFrameReaderV1();
  const frames: ComputerHostExecFrameV1[] = [];
  const stream = response.body?.getReader();
  if (!stream) return frames;
  for (;;) {
    const { done, value } = await stream.read();
    if (done) break;
    frames.push(...reader.push(value));
  }
  frames.push(...reader.end());
  return frames;
}

function decodeText(frames: ComputerHostExecFrameV1[], type: string): string {
  return frames
    .filter((frame) => frame.type === type)
    .map((frame) =>
      "dataBase64" in frame
        ? Buffer.from(frame.dataBase64, "base64").toString("utf8")
        : "",
    )
    .join("");
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
  process.stdout.write(`  ok  ${message}\n`);
}

const token = await spritesToken();
const client = new SpritesClient(token);
let started = false;

try {
  process.stdout.write(`Building the Computer host image (${imageTag})\n`);
  await run([
    "docker",
    "build",
    "--quiet",
    "-t",
    imageTag,
    "-f",
    "apps/computer-host/Dockerfile",
    ".",
  ]);

  // Create and seed the Sprite before the container ever sees it. Seeding the
  // host-state file is what makes the container adopt this Sprite instead of
  // spending ten minutes apt-installing a desktop, and it is itself the first
  // half of the filesystem round-trip.
  process.stdout.write(`Creating the disposable Sprite ${spriteName}\n`);
  const sprite = await client.createSprite(spriteName);
  const files = sprite.filesystem("/");
  await files.mkdir(RUNTIME_ROOT, { recursive: true });
  await files.writeFile(
    COMPUTER_HOST_STATE_PATH,
    `${JSON.stringify({ version: 1, generation: 1 })}\n`,
    { mode: 0o600 },
  );
  // The tenant-attachment half of the runtime, without the ten-minute apt
  // install the full provisioning script performs. `open` then exercises the
  // real ensure script — slot allocation under `flock`, the viewer token, the
  // per-Bot directories — which is the part a Computer's correctness rests on.
  const ensure = COMPUTER_RUNTIME_FILES.find(
    (file) => file.path === ENSURE_AGENT_SCRIPT,
  );
  if (!ensure)
    throw new Error("the Computer runtime declares no ensure script");
  await files.writeFile(ensure.path, ensure.content, { mode: ensure.mode });

  process.stdout.write("Starting the container\n");
  await run(
    [
      "docker",
      "run",
      "--detach",
      "--name",
      containerName,
      "--publish",
      `127.0.0.1:${port}:8080`,
      // Values, never arguments: the token must not reach any process table.
      "--env",
      "SPRITES_TOKEN",
      "--env",
      "COMPUTER_HOST_TOKEN",
      "--env",
      "FROCKBOT_SPRITE_NAME",
      imageTag,
    ],
    {
      env: {
        SPRITES_TOKEN: token,
        COMPUTER_HOST_TOKEN: hostToken,
        FROCKBOT_SPRITE_NAME: spriteBase,
      },
    },
  );
  started = true;
  await waitForHealth();

  // --- the 431 regression -------------------------------------------------
  // The script that failed on argv was ~1.9 KB and encoded to ~2.7 KB. This
  // one is an order of magnitude larger and travels on stdin.
  const marker = `frockbot-live-${runId}`;
  const filler = "# padding to prove the script is not an argument\n".repeat(
    400,
  );
  const largeScript = `${filler}printf %s ${marker}\n`;
  check(
    largeScript.length > 3_000,
    `the exercised script is ${largeScript.length} bytes, past the argv limit that answered 431`,
  );
  const execResult = decodeComputerHostExecResultV1(
    await expectOk(
      await call(COMPUTER_HOST_ROUTES.exec, {
        kind: "exec",
        script: largeScript,
        timeoutMs: 120_000,
        maxOutputBytes: 64 * 1_024,
        stream: false,
      }),
      "exec",
    ),
  );
  check(
    execResult.exitCode === 0,
    `a ${largeScript.length}-byte script over stdin exits 0`,
  );
  check(
    Buffer.from(execResult.stdoutBase64, "base64").toString() === marker,
    "its stdout comes back intact",
  );

  // --- streaming ----------------------------------------------------------
  const streamed = await call(COMPUTER_HOST_ROUTES.exec, {
    kind: "exec",
    script: [
      "for i in 1 2 3; do printf 'out%s\\n' \"$i\"; sleep 0.2; done",
      "printf 'problem\\n' >&2",
      "exit 3",
    ].join("\n"),
    timeoutMs: 60_000,
    maxOutputBytes: 64 * 1_024,
    stream: true,
  });
  const frames = await readFrames(streamed);
  check(
    decodeText(frames, "stdout").includes("out1") &&
      decodeText(frames, "stdout").includes("out3"),
    "streamed stdout arrives as NDJSON frames",
  );
  check(
    decodeText(frames, "stderr").includes("problem"),
    "streamed stderr arrives on its own frames",
  );
  const exitFrame = frames.at(-1);
  check(
    exitFrame?.type === "exit" && exitFrame.exitCode === 3,
    "the stream ends with the command's real exit code",
  );

  // --- cancellation -------------------------------------------------------
  const cancelId = `effect-${randomUUID()}`;
  const cancelled = call(
    COMPUTER_HOST_ROUTES.exec,
    {
      kind: "exec",
      script: "trap 'exit 73' TERM; printf ready\\n; while :; do sleep 1; done",
      timeoutMs: 120_000,
      maxOutputBytes: 4_096,
      stream: true,
    },
    cancelId,
  );
  await Bun.sleep(4_000);
  const cancelResponse = (await expectOk(
    await call(COMPUTER_HOST_ROUTES.cancel, { kind: "cancel" }, cancelId),
    "cancel",
  )) as { cancelled: boolean };
  check(cancelResponse.cancelled, "the host held the effect and cancelled it");
  const cancelFrames = await readFrames(await cancelled);
  check(
    cancelFrames.at(-1)?.type === "error" &&
      (cancelFrames.at(-1) as { code: string }).code === "aborted",
    "the cancelled command's stream ends with an aborted frame",
  );

  // --- filesystem round-trip ---------------------------------------------
  const filePath = `${RUNTIME_ROOT}/live-${runId}.txt`;
  const contents = `round-trip-${runId}`;
  await expectOk(
    await call(COMPUTER_HOST_ROUTES["file/write"], {
      kind: "file/write",
      path: filePath,
      bytesBase64: Buffer.from(contents).toString("base64"),
      mode: 0o600,
    }),
    "file/write",
  );
  const readBack = decodeComputerHostFileReadResultV1(
    await expectOk(
      await call(COMPUTER_HOST_ROUTES["file/read"], {
        kind: "file/read",
        path: filePath,
      }),
      "file/read",
    ),
  );
  check(
    Buffer.from(readBack.bytesBase64, "base64").toString() === contents,
    "bytes round-trip through the filesystem API",
  );

  // --- reconstruction -----------------------------------------------------
  // The container is restarted, so its in-memory record of this Computer is
  // gone. A fresh SpritesClient inside it must re-derive everything from the
  // Sprite: same Sprite, same generation, same file, no reprovisioning.
  process.stdout.write("Restarting the container to prove reconstruction\n");
  await run(["docker", "restart", containerName], { quiet: true });
  await waitForHealth();
  const reopened = decodeComputerHostOpenResultV1(
    await expectOk(
      await call(COMPUTER_HOST_ROUTES.open, { kind: "open" }),
      "open",
    ),
  );
  check(
    reopened.spriteName === spriteName,
    "a restarted container resolves the same Sprite for the same User",
  );
  check(
    reopened.generation === 1,
    "it adopts the recorded generation instead of provisioning again",
  );
  check(
    reopened.display === ":100",
    "the ensure script allocated the tenant a display slot on the shared Computer",
  );
  check(
    reopened.directory.endsWith(
      `/agents/${reopened.directory.split("/").at(-1)}`,
    ),
    "the tenant is answered with its own durable directory",
  );
  const afterRestart = decodeComputerHostFileReadResultV1(
    await expectOk(
      await call(COMPUTER_HOST_ROUTES["file/read"], {
        kind: "file/read",
        path: filePath,
      }),
      "file/read after restart",
    ),
  );
  check(
    Buffer.from(afterRestart.bytesBase64, "base64").toString() === contents,
    "the file written before the restart is still readable after it",
  );

  // --- authorization ------------------------------------------------------
  const unauthorized = await fetch(`${origin}${COMPUTER_HOST_ROUTES.open}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body({ kind: "open" }, "effect-unauthorized")),
  });
  check(
    unauthorized.status === 401,
    "the container refuses a request with no host token",
  );

  process.stdout.write("\nComputer host live test passed\n");
} finally {
  if (started) {
    await run(["docker", "rm", "--force", containerName], {
      quiet: true,
    }).catch(() => undefined);
  }
  await run(["docker", "image", "rm", "--force", imageTag], {
    quiet: true,
  }).catch(() => undefined);

  // This run's Sprite, then anything a killed run left behind. A leaked
  // Sprite costs money for as long as it exists, so the sweeper is part of
  // the test rather than an operational chore.
  try {
    await client.deleteSprite(spriteName);
  } catch (error) {
    process.stderr.write(
      `Could not delete ${spriteName}: ${error instanceof Error ? error.message : "unknown"}\n`,
    );
  }
  try {
    const leaked = await client.listAllSprites("frockbot-test-");
    for (const stale of leaked) {
      process.stdout.write(`Sweeping leaked Sprite ${stale.name}\n`);
      await client.deleteSprite(stale.name).catch(() => undefined);
    }
    if (leaked.length === 0) {
      process.stdout.write("No frockbot-test- Sprite remains\n");
    }
  } catch (error) {
    process.stderr.write(
      `Could not sweep frockbot-test- Sprites: ${error instanceof Error ? error.message : "unknown"}\n`,
    );
  }
}
