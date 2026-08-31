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
  COMPUTER_REFRESH_FINGERPRINT,
  COMPUTER_REFRESH_STAMP,
  computerSpriteNameSourceV1,
  computerSpriteNameV1,
  DOCTOR_LOG,
  DOCTOR_MARKER,
  DOCTOR_REPORT_SCHEMA_VERSION,
  DOCTOR_SCRIPT,
  PROVISION_PHASES,
  REFERENCE_DOCS_VERSION,
  REFERENCE_ROOT,
  RUNTIME_ROOT,
  SCRATCH_ROOT,
} from "@frockbot/computer-host-runtime";

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
  if (command[1] === "logs") return `${stdout}${stderr}`;
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

/**
 * What a cold Computer is allowed to cost, measured rather than guessed.
 *
 * Measured at **166 s**, **135 s**, and **120 s** on 2026-09-01, each over a single
 * connection, once the run
 * held the Sprite awake with a Tasks-API task and stopped asking the
 * distribution for a browser: `apt-get update` 6 s, the desktop packages 82 s,
 * Playwright's Chromium build about a minute, and the rest cold-start first
 * reads. The budget is a wide margin over that — the point is to fail
 * when a regression puts the install back into the ten-minute bound (ADR
 * 0004), not to police a minute either way on a shared archive.
 */
const COLD_OPEN_BUDGET_SECONDS = 8 * 60;

/**
 * What a warm Computer is allowed to cost.
 *
 * A second `open` runs the ensure script and nothing else; it was measured at
 * **463 ms**, **348 ms**, and **355 ms**. Anything approaching this budget means a
 * phase marker was lost and the Computer is reinstalling itself.
 */
const WARM_OPEN_BUDGET_MS = 30_000;

let coldAttempts = 0;

/**
 * Opens a cold Computer, reconnecting if the connection is cut under us.
 *
 * Bun's `fetch` gives up on a request after five minutes, and installing a
 * desktop stack can take longer than that — which makes this the live
 * rehearsal of a rule rather than a workaround for a test runner:
 * "Connections to the Computer are expected to drop on every pause; every
 * Computer client reconnects and resumes rather than treating a dropped
 * connection as failure." The install is detached and its phase markers are on
 * the Sprite, so the next `open` joins the run in progress instead of
 * starting a second one. Nothing is provisioned twice, however many times the
 * client has to come back.
 */
async function openCold(): Promise<
  ReturnType<typeof decodeComputerHostOpenResultV1>
> {
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    coldAttempts += 1;
    try {
      return decodeComputerHostOpenResultV1(
        await expectOk(
          await call(COMPUTER_HOST_ROUTES.open, { kind: "open" }),
          "open on a cold Computer",
        ),
      );
    } catch (error) {
      const dropped =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      if (!dropped || Date.now() >= deadline) throw error;
      process.stdout.write(
        "  the client's connection dropped mid-install; reconnecting\n",
      );
    }
  }
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
let failure: unknown;
let containerLog: ReturnType<typeof Bun.spawn> | undefined;

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

  // Nothing is seeded. The Sprite does not exist yet, so the container has to
  // create it and run the whole provisioning document — `apt-get` and all —
  // which is the exact path that used to die after 45 seconds of silence.
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
  // Follow the container's log for the life of the run. A container that dies
  // cannot be asked what happened, and a cold provisioning run is exactly when
  // it matters.
  containerLog = Bun.spawn(["docker", "logs", "--follow", containerName], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForHealth();

  // --- a cold Computer opens ----------------------------------------------
  // The defect this test exists to close: `@fly/sprites@0.1.0` gives up on a
  // WebSocket 45 s after the last inbound message and never pings, so the
  // single long exec that installed the desktop stack could not survive its
  // own success. Provisioning now runs detached and is polled, so this call
  // takes as long as `apt-get` takes and no connection has to live that long.
  process.stdout.write(
    `Opening a cold Computer (${spriteName}) — this provisions from scratch\n`,
  );
  const coldStarted = Date.now();
  const opened = await openCold();
  const coldSeconds = Math.round((Date.now() - coldStarted) / 1000);
  process.stdout.write(
    `  cold open took ${coldSeconds}s over ${coldAttempts} connection(s)\n`,
  );
  check(opened.spriteName === spriteName, "it provisioned this User's Sprite");
  check(
    opened.provisioning?.status === "complete",
    "it reports provisioning complete rather than silence",
  );
  check(
    opened.provisioning?.total === PROVISION_PHASES.length,
    `it reports all ${PROVISION_PHASES.length} provisioning phases`,
  );
  check(
    opened.provisioning !== undefined,
    "and it names the phases it went through rather than nothing at all",
  );
  check(
    opened.display === ":100",
    "the ensure script allocated the tenant a display slot",
  );
  check(opened.generation === 1, "the Computer records its first generation");
  check(
    coldSeconds < COLD_OPEN_BUDGET_SECONDS,
    `a cold Computer opens inside ${COLD_OPEN_BUDGET_SECONDS}s (took ${coldSeconds}s)`,
  );

  // Idempotence: the second open adopts what the first provisioned. Anything
  // else would mean a Bot's second turn reinstalled its own desktop.
  const adoptedStarted = Date.now();
  const adopted = decodeComputerHostOpenResultV1(
    await expectOk(
      await call(COMPUTER_HOST_ROUTES.open, { kind: "open" }),
      "second open",
    ),
  );
  const adoptedMs = Date.now() - adoptedStarted;
  check(
    adopted.provisioning === undefined,
    `a second open adopts the Computer and provisions nothing (${adoptedMs}ms)`,
  );
  check(
    adoptedMs < WARM_OPEN_BUDGET_MS,
    `and adopts it in seconds rather than minutes (${adoptedMs}ms, budget ${WARM_OPEN_BUDGET_MS}ms)`,
  );

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

  // --- the Computer's own self-check --------------------------------------
  // Before the screenshot section below, deliberately: that section starts an
  // Xvfb of its own on :100 with no browser behind it, and a bare display is
  // this test's artifact rather than a state a Computer reaches on its own.
  //
  // Everything about `computer_doctor` above this line is proven against a
  // fake or against the script run on a developer's laptop. What only a
  // freshly provisioned Sprite can answer is whether the checks pass *there*:
  // whether provisioning really created `/workspace`, installed the launcher
  // and its shims, wrote the reference set, and left a viewer gateway
  // listening. A failing check here is a real defect in the provisioning
  // document, which is why the PASS set is asserted and not merely the shape.
  const doctored = decodeComputerHostExecResultV1(
    await expectOk(
      await call(COMPUTER_HOST_ROUTES.exec, {
        kind: "exec",
        // The tenant this Computer allocated a directory to, taken from the
        // host's own answer rather than re-derived here.
        script: `${DOCTOR_SCRIPT} ${opened.directory.split("/").at(-1)} 1`,
        timeoutMs: 120_000,
        maxOutputBytes: 64 * 1_024,
        stream: false,
      }),
      "exec box-doctor",
    ),
  );
  const doctorOutput = Buffer.from(doctored.stdoutBase64, "base64").toString();
  const doctorLine = doctorOutput
    .split("\n")
    .find((candidate) => candidate.startsWith(DOCTOR_MARKER));
  check(
    doctorLine !== undefined,
    `box-doctor printed a report — ${doctorOutput.slice(0, 200).replace(/\n/g, " | ")}`,
  );
  const doctorReport = JSON.parse(doctorLine!.slice(DOCTOR_MARKER.length)) as {
    schemaVersion: number;
    generation: number;
    checks: { name: string; status: string; detail: string }[];
    browserIdentity: {
      userAgent: string;
      webdriver: boolean;
      brands: string[];
    } | null;
    summary: string;
  };
  check(
    doctorReport.schemaVersion === DOCTOR_REPORT_SCHEMA_VERSION &&
      doctorReport.checks.length >= 10,
    `its report carries ${doctorReport.checks.length} checks: ${doctorReport.summary}`,
  );
  const doctorFailures = doctorReport.checks.filter(
    (entry) => entry.status === "fail",
  );
  check(
    doctorFailures.length === 0,
    doctorFailures.length === 0
      ? `every check passes on a freshly provisioned Computer: ${doctorReport.summary}`
      : `checks failed: ${doctorFailures
          .map((entry) => `${entry.name} (${entry.detail})`)
          .join("; ")}`,
  );
  // Parity row 34b, and the only place the measurement can actually be taken:
  // what a real Sprite's browser announces itself as. This is the decision
  // input for whether `--user-agent` is ever added to the launcher's flag
  // list, so it is printed whether or not anything was running to ask.
  check(
    doctorReport.browserIdentity === null ||
      typeof doctorReport.browserIdentity.userAgent === "string",
    doctorReport.browserIdentity
      ? `the browser presents "${doctorReport.browserIdentity.userAgent}" (navigator.webdriver ${String(doctorReport.browserIdentity.webdriver)}; brands ${doctorReport.browserIdentity.brands.join(", ") || "none"})`
      : "no browser was answering CDP, so no identity was measured on this run",
  );
  // The log a human reads, in GrokBot's own format and at GrokBot's own path.
  const doctorLog = Buffer.from(
    decodeComputerHostFileReadResultV1(
      await expectOk(
        await call(COMPUTER_HOST_ROUTES["file/read"], {
          kind: "file/read",
          path: DOCTOR_LOG,
        }),
        "file/read box-doctor.log",
      ),
    ).bytesBase64,
    "base64",
  ).toString();
  check(
    doctorLog.includes("[box-doctor] PASS ") &&
      doctorLog.includes(`[box-doctor] SUMMARY ${doctorReport.summary}`),
    `${DOCTOR_LOG} holds the run's PASS lines and its SUMMARY`,
  );
  // The shared scratch, which no durable root covers and which the layout
  // phase creates: a Bot that cannot write here has no way to hand a file to
  // another of its User's Bots.
  const scratch = decodeComputerHostExecResultV1(
    await expectOk(
      await call(COMPUTER_HOST_ROUTES.exec, {
        kind: "exec",
        script: [
          `printf 'writable=%s\\n' "$(touch ${SCRATCH_ROOT}/live-${runId} && echo 1 || echo 0)"`,
          `rm -f ${SCRATCH_ROOT}/live-${runId}`,
        ].join("\n"),
        timeoutMs: 30_000,
        maxOutputBytes: 4_096,
        stream: false,
      }),
      "exec scratch",
    ),
  );
  check(
    Buffer.from(scratch.stdoutBase64, "base64")
      .toString()
      .includes("writable=1"),
    `${SCRATCH_ROOT} is shared scratch this Computer's tenants can write`,
  );

  // --- a real screenshot on a real Xvfb ------------------------------------
  // Everything else about `computer_screenshot` is proven against a fake. Two
  // things only a Sprite can answer: whether provisioning's apt list really
  // installs `scrot`, and whether a real Xvfb produces a decodable PNG. This
  // Sprite was provisioned from scratch above, so both are fair questions.
  const shotPath = `${RUNTIME_ROOT}/live-shot-${runId}.png`;
  const shot = decodeComputerHostExecResultV1(
    await expectOk(
      await call(COMPUTER_HOST_ROUTES.exec, {
        kind: "exec",
        script: [
          "export DISPLAY=:100",
          `printf 'scrot=%s\\n' "$(command -v scrot || echo MISSING)"`,
          // A display of this test's own, so the capture does not depend on a
          // desktop service this Sprite was never asked to start.
          "Xvfb :100 -screen 0 320x240x24 -nolisten tcp >/dev/null 2>&1 &",
          "for _ in $(seq 1 100); do xdpyinfo -display :100 >/dev/null 2>&1 && break; sleep 0.1; done",
          `rm -f ${shotPath}`,
          `scrot --overwrite ${shotPath} 2>&1 || printf 'scrot-failed=%s\\n' "$?"`,
          `printf 'size=%s\\n' "$(stat -c %s ${shotPath} 2>/dev/null || echo 0)"`,
        ].join("\n"),
        timeoutMs: 120_000,
        maxOutputBytes: 8 * 1_024,
        stream: false,
      }),
      "exec scrot",
    ),
  );
  const shotReport = Buffer.from(shot.stdoutBase64, "base64").toString();
  check(
    shotReport.includes("scrot=/") &&
      Number(/size=(\d+)/.exec(shotReport)?.[1] ?? 0) > 0,
    `provisioning installed scrot and it captured a real display — ${shotReport
      .trim()
      .replace(/\n/g, " | ")}`,
  );
  const shotBytes = Buffer.from(
    decodeComputerHostFileReadResultV1(
      await expectOk(
        await call(COMPUTER_HOST_ROUTES["file/read"], {
          kind: "file/read",
          path: shotPath,
        }),
        "file/read screenshot",
      ),
    ).bytesBase64,
    "base64",
  );
  check(
    shotBytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    `the capture is a PNG of ${shotBytes.length} bytes`,
  );
  check(
    shotBytes.readUInt32BE(16) > 0 && shotBytes.readUInt32BE(20) > 0,
    `its IHDR declares ${shotBytes.readUInt32BE(16)}x${shotBytes.readUInt32BE(20)}`,
  );

  // --- a background process that outlives its exec -------------------------
  // What no fake can answer: whether `setsid nohup` really detaches a command
  // from the exec that started it. The exec returns as soon as the pid file
  // exists; the process must still be there afterwards, and must still be
  // there after the container restart below, because a background process
  // belongs to the Computer and not to the connection that started it.
  const processId = `live-${runId}`;
  const processDir = `${RUNTIME_ROOT}/live-processes/${processId}`;
  const launch = decodeComputerHostExecResultV1(
    await expectOk(
      await call(COMPUTER_HOST_ROUTES.exec, {
        kind: "exec",
        script: [
          "set -eu",
          `DIR=${processDir}`,
          'mkdir -p "$DIR"',
          `setsid nohup bash -c 'for i in $(seq 1 600); do printf "tick-%s\\n" "$i"; sleep 1; done > "${processDir}/log"; printf "0\\n" > "${processDir}/exit"' >/dev/null 2>&1 &`,
          'printf "%s\\n" "$!" > "$DIR/pid"',
          'printf "pid=%s\\n" "$(cat "$DIR/pid")"',
        ].join("\n"),
        timeoutMs: 60_000,
        maxOutputBytes: 8 * 1_024,
        stream: false,
      }),
      "exec background launch",
    ),
  );
  const backgroundPid = Number(
    /pid=(\d+)/.exec(
      Buffer.from(launch.stdoutBase64, "base64").toString(),
    )?.[1],
  );
  check(
    launch.exitCode === 0 &&
      Number.isSafeInteger(backgroundPid) &&
      backgroundPid > 0,
    `a background launch returns immediately with pid ${String(backgroundPid)}`,
  );
  const stillAlive = decodeComputerHostExecResultV1(
    await expectOk(
      await call(COMPUTER_HOST_ROUTES.exec, {
        kind: "exec",
        script: [
          `printf 'alive=%s\\n' "$(kill -0 ${backgroundPid} 2>/dev/null && echo 1 || echo 0)"`,
          `printf 'log=%s\\n' "$(head -c 32 ${processDir}/log 2>/dev/null | tr -d '\\n')"`,
        ].join("\n"),
        timeoutMs: 30_000,
        maxOutputBytes: 4_096,
        stream: false,
      }),
      "exec background check",
    ),
  );
  const aliveReport = Buffer.from(stillAlive.stdoutBase64, "base64").toString();
  check(
    aliveReport.includes("alive=1"),
    `the process outlived the exec that started it — ${aliveReport.trim().replace(/\n/g, " | ")}`,
  );

  // --- reconstruction -----------------------------------------------------
  // The container is restarted, so its in-memory record of this Computer is
  // gone. A fresh SpritesClient inside it must re-derive everything from the
  // Sprite: same Sprite, same generation, same file, no reprovisioning.
  // The reference set is versioned precisely because provisioning
  // short-circuits: a Sprite with a state file is adopted and its provisioning
  // document never runs again. Deleting the version stamps here is what makes
  // the next `open` an honest test of the refresh — if it did not run, the
  // documents would still be missing after the restart below.
  await expectOk(
    await call(COMPUTER_HOST_ROUTES["file/delete"], {
      kind: "file/delete",
      path: `${REFERENCE_ROOT}/.version`,
      recursive: false,
    }),
    "file/delete reference version",
  );
  await expectOk(
    await call(COMPUTER_HOST_ROUTES["file/delete"], {
      kind: "file/delete",
      path: COMPUTER_REFRESH_STAMP,
      recursive: false,
    }),
    "file/delete refresh stamp",
  );

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
    "the tenant keeps the display slot it was allocated before the restart",
  );
  check(
    reopened.provisioning === undefined,
    "a restarted container provisions nothing it has already provisioned",
  );
  check(
    reopened.directory.endsWith(
      `/agents/${reopened.directory.split("/").at(-1)}`,
    ),
    "the tenant is answered with its own durable directory",
  );
  // The adopt path's refresh: an already-provisioned Computer gains this
  // build's reference set without being reprovisioned.
  const refreshedVersion = Buffer.from(
    decodeComputerHostFileReadResultV1(
      await expectOk(
        await call(COMPUTER_HOST_ROUTES["file/read"], {
          kind: "file/read",
          path: `${REFERENCE_ROOT}/.version`,
        }),
        "file/read reference version",
      ),
    ).bytesBase64,
    "base64",
  )
    .toString()
    .trim();
  check(
    refreshedVersion === REFERENCE_DOCS_VERSION,
    `an adopted Computer refreshed its reference set to ${refreshedVersion}`,
  );
  const refreshedStamp = Buffer.from(
    decodeComputerHostFileReadResultV1(
      await expectOk(
        await call(COMPUTER_HOST_ROUTES["file/read"], {
          kind: "file/read",
          path: COMPUTER_REFRESH_STAMP,
        }),
        "file/read refresh stamp",
      ),
    ).bytesBase64,
    "base64",
  )
    .toString()
    .trim();
  check(
    refreshedStamp === COMPUTER_REFRESH_FINGERPRINT,
    "and recorded this build's fingerprint, so the next open costs one read",
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

  // --- the background process across the restart ---------------------------
  // The container restarted; the Sprite did not. A process belongs to the
  // Computer, so it is still running — and stopping it reaches the whole group
  // rather than the shell that owns the pipeline.
  const afterRestartProcess = decodeComputerHostExecResultV1(
    await expectOk(
      await call(COMPUTER_HOST_ROUTES.exec, {
        kind: "exec",
        script: `printf 'alive=%s\\n' "$(kill -0 ${backgroundPid} 2>/dev/null && echo 1 || echo 0)"`,
        timeoutMs: 30_000,
        maxOutputBytes: 4_096,
        stream: false,
      }),
      "exec background check after restart",
    ),
  );
  check(
    Buffer.from(afterRestartProcess.stdoutBase64, "base64")
      .toString()
      .includes("alive=1"),
    "the background process survived the container restart",
  );
  const stopped = decodeComputerHostExecResultV1(
    await expectOk(
      await call(COMPUTER_HOST_ROUTES.exec, {
        kind: "exec",
        script: [
          `kill -TERM -${backgroundPid} 2>/dev/null || kill -TERM ${backgroundPid} 2>/dev/null || true`,
          `for _ in $(seq 1 50); do kill -0 ${backgroundPid} 2>/dev/null || break; sleep 0.1; done`,
          `if kill -0 ${backgroundPid} 2>/dev/null; then kill -KILL -${backgroundPid} 2>/dev/null || kill -KILL ${backgroundPid} 2>/dev/null || true; sleep 0.5; fi`,
          `printf 'alive=%s\\n' "$(kill -0 ${backgroundPid} 2>/dev/null && echo 1 || echo 0)"`,
        ].join("\n"),
        timeoutMs: 60_000,
        maxOutputBytes: 4_096,
        stream: false,
      }),
      "exec background stop",
    ),
  );
  check(
    Buffer.from(stopped.stdoutBase64, "base64").toString().includes("alive=0"),
    "TERM escalated to KILL ends the process group",
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

  process.stdout.write(
    `\nComputer host live test passed (cold open: ${coldSeconds}s over ${coldAttempts} connection(s))\n`,
  );
} catch (error) {
  // Printed here rather than left to the runner: a failure five minutes into
  // a cold provisioning run is worth exactly one legible paragraph.
  process.stderr.write(
    `\nComputer host live test FAILED: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`,
  );
  if (error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  failure = error;
} finally {
  if (started) {
    await run(["docker", "rm", "--force", containerName], {
      quiet: true,
    }).catch(() => undefined);
  }
  if (containerLog) {
    // Read after the container is gone, which is what ends `--follow`. A
    // container that died cannot be asked what happened, so the log is
    // collected for the life of the run rather than fetched afterwards.
    const [out, err] = await Promise.all([
      new Response(containerLog.stdout as ReadableStream).text(),
      new Response(containerLog.stderr as ReadableStream).text(),
    ]);
    const logs = `${out}${err}`.trim();
    if (failure && logs) process.stderr.write(`\ncontainer log:\n${logs}\n`);
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

if (failure) throw failure;
