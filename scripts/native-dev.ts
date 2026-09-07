#!/usr/bin/env bun
/**
 * The phone app against a local stack, on an Android emulator you can sign
 * in to — so a change is smoke-tested here, not in production.
 *
 *   bun scripts/native-dev.ts up       build, seed, serve, boot, install
 *   bun scripts/native-dev.ts serve    restart the Workers on the existing state
 *   bun scripts/native-dev.ts app      rebuild and reinstall the app alone
 *   bun scripts/native-dev.ts seed     re-seed the development User's Bot and model
 *   bun scripts/native-dev.ts smoke    sign in, send a message, expect a reply
 *   bun scripts/native-dev.ts down     stop everything this script started
 *   bun scripts/native-dev.ts status
 *
 * What runs, and how it reaches production parity:
 *
 *   - The app Worker under `wrangler dev --env development` — the same workerd
 *     as production, local R2/D1/Durable Objects under `.native-dev/`, and the
 *     remote AI, Vectorize and memory bindings when wrangler is signed in.
 *   - With `SPRITES_TOKEN`, the Computer host — real Sprites — under its own
 *     `wrangler dev`, because a service binding resolves only through the dev
 *     registry.
 *   - The emulator borrows the host's loopback through `adb reverse`. The app
 *     is a debug build pointed at it with `--dart-define`, and it signs in
 *     through the Worker's development door instead of Google: the one
 *     deliberate departure from production, and one production refuses to
 *     enable.
 *   - The development User gets a Bot and, with `OLLAMA_API_KEY` in
 *     `apps/cloudflare/.dev.vars`, an Ollama Cloud connection set as the
 *     account model — the same provider production runs.
 */
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cloudflareRoot = resolve(root, "apps/cloudflare");
const computerHostRoot = resolve(root, "apps/computer-host");
const nativeRoot = resolve(root, "apps/native");
const stateDir = resolve(root, ".native-dev");
const persistDir = resolve(stateDir, "wrangler-state");
const logDir = process.env.CLAUDE_JOB_DIR
  ? resolve(process.env.CLAUDE_JOB_DIR, "tmp", "native-dev")
  : resolve(stateDir, "logs");
const mainCheckout =
  process.env.FROCKBOT_MAIN_CHECKOUT ??
  resolve(process.env.HOME ?? "", "repos/grokbot-headless");

// Off the dogfood stack's ports, so both can run.
const workerPort = process.env.FROCKBOT_NATIVE_WORKER_PORT ?? "8797";
const computerHostPort = process.env.FROCKBOT_NATIVE_COMPUTER_PORT ?? "8799";
// One origin for everyone: `adb reverse` lends the emulator the host's
// loopback, so the app, the Worker and `BETTER_AUTH_URL` all name this — and
// `wrangler dev` rewrites every request URL to its bound address anyway, so
// a `10.0.2.2` origin would fail the native auth origin check.
const hostOrigin = `http://127.0.0.1:${workerPort}`;
const emulatorOrigin = hostOrigin;
// Three `wrangler dev` sessions each default their inspector to 9229; the
// second and third fail to bind and never start.
const inspectorPort = (port: string) => String(Number(port) + 1000);

const DEVELOPMENT_USER = "development";
const DEVELOPMENT_HEADERS = { "x-frockbot-user-id": DEVELOPMENT_USER };
const BOT_ID = "dev-bot";
const BOT_NAME = "Dev Bot";
const MODEL = process.env.FROCKBOT_DEV_MODEL ?? "glm-5.3-flash:cloud";
const APP = "com.frockbot.mobile";
const APK = resolve(nativeRoot, "build/app/outputs/flutter-apk/app-debug.apk");

const sdk =
  process.env.ANDROID_HOME ??
  resolve(process.env.HOME ?? "", "Library/Android/sdk");
const adbBinary = resolve(sdk, "platform-tools/adb");
const emulatorBinary = resolve(sdk, "emulator/emulator");

const artifactBucket = "frockbot-application-artifacts";

mkdirSync(stateDir, { recursive: true });
mkdirSync(logDir, { recursive: true });

function say(message: string): void {
  console.log(`\x1b[1;36m[native-dev]\x1b[0m ${message}`);
}
function warn(message: string): void {
  console.error(`\x1b[1;33m[native-dev]\x1b[0m ${message}`);
}
function die(message: string): never {
  console.error(`\x1b[1;31m[native-dev]\x1b[0m ${message}`);
  process.exit(1);
  throw new Error(message);
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function run(
  command: string[],
  options: { cwd?: string; quiet?: boolean; check?: boolean } = {},
): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(command, {
    cwd: options.cwd ?? root,
    stdout: options.quiet ? "pipe" : "inherit",
    stderr: options.quiet ? "pipe" : "inherit",
    env: process.env,
  });
  const stdout = options.quiet ? (result.stdout?.toString() ?? "") : "";
  const stderr = options.quiet ? (result.stderr?.toString() ?? "") : "";
  if (options.check !== false && result.exitCode !== 0) {
    die(`${command.join(" ")} exited ${result.exitCode}\n${stderr}`);
  }
  return { code: result.exitCode, stdout, stderr };
}

// ------------------------------------------------------------- .dev.vars

function readVars(path: string): Map<string, string> {
  const vars = new Map<string, string>();
  if (!existsSync(path)) return vars;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) vars.set(match[1]!, match[2]!.replace(/^"(.*)"$/, "$1"));
  }
  return vars;
}

function ensureDevVars(): Map<string, string> {
  const target = resolve(cloudflareRoot, ".dev.vars");
  if (!existsSync(target)) {
    const source = resolve(mainCheckout, "apps/cloudflare/.dev.vars");
    if (!existsSync(source)) {
      die(
        `${target} is missing. Copy .dev.vars.example and fill it in; without CREDENTIAL_KEYRING the User Durable Object cannot start.`,
      );
    }
    say(`copying .dev.vars from ${mainCheckout}`);
    copyFileSync(source, target);
  }
  const vars = readVars(target);
  if (!vars.get("CREDENTIAL_KEYRING"))
    die("CREDENTIAL_KEYRING is not set in apps/cloudflare/.dev.vars");

  // The Computer host and the app Worker share one token. Minted once here
  // and written to both files; neither is committed.
  if (vars.get("SPRITES_TOKEN")) {
    let token = vars.get("COMPUTER_HOST_TOKEN");
    if (!token) {
      token = randomBytes(32).toString("hex");
      appendFileSync(target, `\nCOMPUTER_HOST_TOKEN=${token}\n`);
      vars.set("COMPUTER_HOST_TOKEN", token);
      say("minted COMPUTER_HOST_TOKEN into apps/cloudflare/.dev.vars");
    }
    const hostVars = resolve(computerHostRoot, ".dev.vars");
    const current = readVars(hostVars);
    if (
      current.get("SPRITES_TOKEN") !== vars.get("SPRITES_TOKEN") ||
      current.get("COMPUTER_HOST_TOKEN") !== token
    ) {
      writeFileSync(
        hostVars,
        `SPRITES_TOKEN=${vars.get("SPRITES_TOKEN")}\nCOMPUTER_HOST_TOKEN=${token}\n`,
      );
      say("wrote apps/computer-host/.dev.vars");
    }
  }
  return vars;
}

// ------------------------------------------------------------- processes

function pidFile(name: string): string {
  return resolve(stateDir, `${name}.pid`);
}

function processTree(pid: number): number[] {
  const children = run(["pgrep", "-P", String(pid)], {
    quiet: true,
    check: false,
  })
    .stdout.split("\n")
    .filter(Boolean)
    .map(Number);
  return [...children.flatMap(processTree), pid];
}

function killTree(pid: number): void {
  for (const each of processTree(pid)) {
    try {
      process.kill(each, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function startBackground(name: string, command: string[], cwd: string): void {
  const log = resolve(logDir, `${name}.log`);
  const fd = openSync(log, "a");
  const child = Bun.spawn(command, {
    cwd,
    env: process.env,
    stdin: "ignore",
    stdout: fd,
    stderr: fd,
  });
  child.unref();
  writeFileSync(pidFile(name), String(child.pid));
  say(`started ${name} (pid ${child.pid}, log ${log})`);
}

function down(): void {
  for (const name of ["worker", "computer-host"]) {
    const file = pidFile(name);
    if (!existsSync(file)) continue;
    const pid = Number(readFileSync(file, "utf8").trim());
    if (pid) killTree(pid);
    rmSync(file, { force: true });
  }
  // Backstop for a lost pid file: whoever holds this stack's own ports.
  for (const port of [workerPort, computerHostPort]) {
    const holders = run(["lsof", "-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
      quiet: true,
      check: false,
    })
      .stdout.split("\n")
      .filter(Boolean)
      .map(Number);
    for (const holder of holders) killTree(holder);
  }
}

async function waitFor(
  label: string,
  probe: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe().catch(() => false)) return;
    await sleep(1000);
  }
  die(`timed out waiting for ${label} — see ${logDir}`);
}

// ------------------------------------------------------------ build+seed

function wrangler(args: string[], cwd = cloudflareRoot): void {
  run(["bunx", "wrangler", ...args], { cwd, quiet: true });
}

function buildAndSeed(): void {
  say("building the foundation artifact");
  run(["bun", "run", "artifact:build"], { cwd: cloudflareRoot });

  say("seeding the foundation artifact into local R2");
  wrangler([
    "--env",
    "development",
    "r2",
    "object",
    "put",
    `${artifactBucket}/applications/foundation-v1.mjs`,
    "--file",
    "dist/artifacts/foundation-v1.mjs",
    "--local",
    "--persist-to",
    persistDir,
  ]);

  say("applying the local D1 auth migrations");
  wrangler([
    "--env",
    "development",
    "d1",
    "migrations",
    "apply",
    "frockbot-auth-development",
    "--local",
    "--persist-to",
    persistDir,
  ]);
}

// ---------------------------------------------------------------- serve

function cloudflareAuthenticated(): boolean {
  return (
    run(["bunx", "wrangler", "whoami"], {
      cwd: cloudflareRoot,
      quiet: true,
      check: false,
    }).code === 0
  );
}

async function serve(
  vars: Map<string, string>,
): Promise<{ model: string; computer: string }> {
  let computer = "off — no SPRITES_TOKEN in apps/cloudflare/.dev.vars";
  if (vars.get("SPRITES_TOKEN")) {
    startBackground(
      "computer-host",
      [
        "bunx",
        "wrangler",
        "dev",
        "--ip",
        "127.0.0.1",
        "--port",
        computerHostPort,
        "--inspector-port",
        inspectorPort(computerHostPort),
        "--persist-to",
        persistDir,
      ],
      computerHostRoot,
    );
    computer = `real Sprites through the Computer host on :${computerHostPort}`;
  }

  const remote = cloudflareAuthenticated();
  const model = remote
    ? "remote AI bindings are live"
    : "remote AI bindings are OFF (wrangler is not signed in) — only Ollama turns work";
  if (!remote) warn(model);
  startBackground(
    "worker",
    [
      "bunx",
      "wrangler",
      "dev",
      "--env",
      "development",
      "--ip",
      "127.0.0.1",
      "--port",
      workerPort,
      "--inspector-port",
      inspectorPort(workerPort),
      "--persist-to",
      persistDir,
      // The development door, on the origin the emulator reaches.
      "--var",
      "ALLOW_DEVELOPMENT_AUTH:true",
      "--var",
      `BETTER_AUTH_URL:${emulatorOrigin}`,
      "--var",
      "BETTER_AUTH_SECRET:native-development",
      ...(remote ? [] : ["--local"]),
    ],
    cloudflareRoot,
  );

  await waitFor(
    `the Worker on :${workerPort}`,
    async () =>
      (
        await fetch(`${hostOrigin}/app-manifest`, {
          headers: DEVELOPMENT_HEADERS,
        })
      ).ok,
    180_000,
  );
  if (vars.get("SPRITES_TOKEN")) {
    // The first start builds the container image; later ones are seconds.
    await waitFor(
      `the Computer host on :${computerHostPort}`,
      async () =>
        (await fetch(`http://127.0.0.1:${computerHostPort}/healthz`)).status >
        0,
      600_000,
    );
  }
  return { model, computer };
}

// ----------------------------------------------------------------- seed

async function api<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${hostOrigin}${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: {
      ...DEVELOPMENT_HEADERS,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await response.text();
  if (!response.ok)
    die(`${path} answered ${response.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text) as T;
}

const id = () => `native-dev-${randomBytes(6).toString("hex")}`;

async function seedDevelopmentUser(vars: Map<string, string>): Promise<string> {
  const directory = await api<{ revision: number; bots: { botId: string }[] }>(
    "/api/bots",
  );
  if (!directory.bots.some((bot) => bot.botId === BOT_ID)) {
    say(`creating "${BOT_NAME}" for the development User`);
    await api("/api/bots", {
      body: {
        schemaVersion: 1,
        type: "bot/create",
        commandId: id(),
        expectedRevision: directory.revision,
        botId: BOT_ID,
        name: BOT_NAME,
        description: "The local stack's Bot.",
      },
    });
  }

  const apiKey = vars.get("OLLAMA_API_KEY");
  if (!apiKey) {
    return "the platform model over the remote AI binding (real Workers AI cost) — add OLLAMA_API_KEY to apps/cloudflare/.dev.vars for Ollama Cloud";
  }
  const frame = await api<{
    revision: number;
    sections: { id: string; fields?: { id: string; value?: unknown }[] }[];
  }>("/api/settings/models");
  const bound = JSON.stringify(frame).includes(`"providerModelId":"${MODEL}"`);
  if (bound) return `Ollama Cloud · ${MODEL}`;

  say("connecting Ollama Cloud for the development User");
  const receipt = await api<{ connectionId: string; status: string }>(
    "/api/connections",
    {
      body: {
        schemaVersion: 1,
        type: "connection/create-api-key",
        commandId: id(),
        packageId: "provider-ollama-cloud",
        connectionTypeId: "ollama-cloud-account",
        label: "Ollama Cloud",
        apiKey,
      },
    },
  );
  if (receipt.status !== "applied")
    die(`the Ollama connection was ${receipt.status}`);
  say(`setting the account model to ${MODEL}`);
  await api("/api/settings/models", {
    body: {
      schemaVersion: 1,
      commandId: id(),
      expectedRevision: frame.revision,
      sectionId: "model",
      values: {
        "account-model": {
          connectionId: receipt.connectionId,
          providerModelId: MODEL,
        },
      },
      ownerId: DEVELOPMENT_USER,
    },
  });
  return `Ollama Cloud · ${MODEL}`;
}

// ------------------------------------------------------------- emulator

function adb(serial: string, ...args: string[]) {
  return run([adbBinary, "-s", serial, ...args], { quiet: true, check: false });
}

function emulatorSerial(): string | undefined {
  return run([adbBinary, "devices"], { quiet: true })
    .stdout.split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(
      (parts) => parts[0]?.startsWith("emulator-") && parts[1] === "device",
    )?.[0];
}

const avdHome =
  process.env.ANDROID_AVD_HOME ??
  resolve(process.env.HOME ?? "", ".android/avd");
const AVD = process.env.FROCKBOT_AVD ?? "frockbot-dev";

/**
 * The stack's own device. Created from the hardware profile of whichever AVD
 * already exists, with a data partition that fits a debug build beside
 * whatever else is installed: a shared AVD fills up, and the emulator only
 * grows userdata on a wipe, which would take the other apps' data with it.
 */
function ensureAvd(): string {
  const avds = run([emulatorBinary, "-list-avds"], { quiet: true })
    .stdout.split("\n")
    .filter(Boolean);
  if (avds.includes(AVD)) return AVD;
  const template = avds
    .map(
      (name) =>
        readFileSync(resolve(avdHome, `${name}.ini`), "utf8").match(
          /^path=(.+)$/m,
        )?.[1],
    )
    .find((path) => path && existsSync(resolve(path, "config.ini")));
  if (!template)
    die(
      "no Android Virtual Device to base one on: create any device in Android Studio's Device Manager",
    );
  const dir = resolve(avdHome, `${AVD}.avd`);
  mkdirSync(dir, { recursive: true });
  const config = readFileSync(resolve(template, "config.ini"), "utf8")
    .replace(/^AvdId=.*$/m, `AvdId=${AVD}`)
    .replace(/^avd\.ini\.displayname=.*$/m, "avd.ini.displayname=FrockBot dev")
    .replace(/^disk\.dataPartition\.size=.*$/m, "disk.dataPartition.size=16G");
  writeFileSync(resolve(dir, "config.ini"), config);
  writeFileSync(
    resolve(avdHome, `${AVD}.ini`),
    `avd.ini.encoding=UTF-8\npath=${dir}\npath.rel=avd/${AVD}.avd\ntarget=${config.match(/^target=(.*)$/m)?.[1] ?? readFileSync(resolve(avdHome, `${avds[0]}.ini`), "utf8").match(/^target=(.*)$/m)?.[1] ?? ""}\n`,
  );
  say(`created the "${AVD}" device from ${template}`);
  return AVD;
}

/** The emulator's 127.0.0.1:<port> reaches the host's. Lost on reboot. */
function reverseWorkerPort(serial: string): void {
  adb(serial, "reverse", `tcp:${workerPort}`, `tcp:${workerPort}`);
}

async function ensureEmulator(): Promise<string> {
  const running = emulatorSerial();
  if (running) {
    reverseWorkerPort(running);
    return running;
  }
  const avd = ensureAvd();
  say(`booting the emulator "${avd}"`);
  const fd = openSync(resolve(logDir, "emulator.log"), "a");
  Bun.spawn(
    [
      emulatorBinary,
      "-avd",
      avd,
      "-no-boot-anim",
      "-netdelay",
      "none",
      "-netspeed",
      "full",
    ],
    {
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
    },
  ).unref();
  let serial: string | undefined;
  await waitFor(
    "the emulator to appear",
    async () => Boolean((serial = emulatorSerial())),
    120_000,
  );
  await waitFor(
    "the emulator to boot",
    async () =>
      adb(serial!, "shell", "getprop", "sys.boot_completed").stdout.trim() ===
      "1",
    240_000,
  );
  reverseWorkerPort(serial!);
  return serial!;
}

function installedVersionCode(serial: string): number {
  const dump = adb(serial, "shell", "dumpsys", "package", APP).stdout;
  return Math.max(
    0,
    ...[...dump.matchAll(/versionCode=(\d+)/g)].map((m) => Number(m[1])),
  );
}

function installApp(serial: string): void {
  // The Gradle build upgrades whatever is installed, on the emulator as on
  // the Pixel: it refuses to build without knowing the installed versionCode.
  const installed = installedVersionCode(serial);
  process.env.FROCKBOT_INSTALLED_VERSION_CODE = String(installed);
  say(
    `building the debug app against the local stack (versionCode ${installed + 1})`,
  );
  run(
    [
      "flutter",
      "build",
      "apk",
      "--debug",
      `--build-number=${installed + 1}`,
      `--dart-define=FROCKBOT_ORIGIN=${emulatorOrigin}`,
      "--dart-define=FROCKBOT_DEV_AUTH=true",
    ],
    { cwd: nativeRoot },
  );
  say(`installing on ${serial}`);
  run([adbBinary, "-s", serial, "install", "-r", "-t", APK], { quiet: true });
}

// ---------------------------------------------------------------- smoke

interface Node {
  text: string;
  desc: string;
  hint: string;
  enabled: boolean;
  bounds: [number, number, number, number];
}

function dump(serial: string): Node[] {
  adb(serial, "shell", "uiautomator", "dump", "/data/local/tmp/native-dev.xml");
  const xml = adb(
    serial,
    "shell",
    "cat",
    "/data/local/tmp/native-dev.xml",
  ).stdout;
  const nodes: Node[] = [];
  for (const match of xml.matchAll(/<node [^>]*>/g)) {
    const attr = (name: string) =>
      (match[0].match(new RegExp(` ${name}="([^"]*)"`))?.[1] ?? "")
        .replaceAll("&#10;", "\n")
        .replaceAll("&quot;", '"')
        .replaceAll("&apos;", "'")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&");
    const bounds = [...attr("bounds").matchAll(/\d+/g)].map((m) =>
      Number(m[0]),
    );
    if (bounds.length !== 4) continue;
    nodes.push({
      text: attr("text"),
      desc: attr("content-desc"),
      hint: attr("hint"),
      enabled: attr("enabled") !== "false",
      bounds: bounds as Node["bounds"],
    });
  }
  return nodes;
}

function find(nodes: Node[], label: string): Node | undefined {
  // A list tile's label is its title, preview and badge on separate lines.
  return nodes.find((node) =>
    [node.text, node.desc, node.hint].some(
      (value) => value === label || value.split("\n")[0] === label,
    ),
  );
}

async function tap(
  serial: string,
  labels: string[],
  timeoutMs = 60_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const nodes = dump(serial);
    for (const label of labels) {
      const node = find(nodes, label);
      // A control that is on screen but disabled — the sign-in button while
      // the app is still restoring — swallows the tap; wait for it instead.
      if (!node?.enabled) continue;
      const [l, t, r, b] = node.bounds;
      adb(
        serial,
        "shell",
        "input",
        "tap",
        String((l + r) >> 1),
        String((t + b) >> 1),
      );
      return label;
    }
    await sleep(1000);
  }
  return die(
    `none of ${labels.map((l) => `"${l}"`).join(", ")} appeared on screen`,
  );
}

function screenshot(serial: string, name: string): void {
  const file = resolve(logDir, `${name}.png`);
  const result = Bun.spawnSync(
    [adbBinary, "-s", serial, "exec-out", "screencap", "-p"],
    {
      stdout: "pipe",
    },
  );
  writeFileSync(file, result.stdout);
  say(`screenshot ${file}`);
}

async function smoke(): Promise<void> {
  const serial =
    emulatorSerial() ?? die("no running emulator — run `up` first");
  if (
    !(await fetch(`${hostOrigin}/app-manifest`, {
      headers: DEVELOPMENT_HEADERS,
    })
      .then((r) => r.ok)
      .catch(() => false))
  )
    die(`the Worker is not answering on ${hostOrigin} — run \`up\` first`);

  say("fresh app state, then sign in through the development door");
  reverseWorkerPort(serial);
  adb(serial, "shell", "pm", "clear", APP);
  adb(serial, "logcat", "-c");
  adb(serial, "shell", "am", "start", "-n", `${APP}/.MainActivity`);

  // The app opens the browser on the authorization URL and logs it (debug
  // builds only). The browser leg is completed from here — the same
  // `/native/authorize` request Chrome would make, then the same return
  // delivered to the app — so a fresh emulator's Chrome first-run never gets
  // in the way. A tap in the app's first frames is lost, so the tap is
  // repeated until the log line proves it landed.
  // Only the latest start is live: each one replaces the stored state, and
  // a return for an earlier one is refused as expired.
  const latestAuthorize = () =>
    [
      ...adb(serial, "logcat", "-d", "-s", "flutter").stdout.matchAll(
        /FROCKBOT_DEV_AUTHORIZE (\S+)/g,
      ),
    ].at(-1)?.[1];
  let authorize: string | undefined;
  for (let attempt = 0; attempt < 6 && !authorize; attempt++) {
    await tap(serial, ["Continue as local developer"], 90_000);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !authorize) {
      await sleep(1000);
      authorize = latestAuthorize();
    }
  }
  if (!authorize) die("the app never started sign-in — see the emulator");
  adb(serial, "shell", "am", "force-stop", "com.android.chrome");
  const returned = await fetch(authorize!, { redirect: "manual" });
  const location = returned.headers.get("location");
  if (returned.status !== 302 || !location?.startsWith("frockbot-dev://"))
    die(`/native/authorize answered ${returned.status} ${location ?? ""}`);
  // Quoted for the device's shell: an unquoted `&state=` would background
  // the command and hand the app a return with no state.
  adb(
    serial,
    "shell",
    "am",
    "start",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    `'${location}'`,
    APP,
  );

  say("waiting for the signed-in home, then opening the Bot");
  // The composer's accessibility hint; its visible placeholder is longer.
  const composer = "Message";
  await waitFor(
    "the signed-in home",
    async () => {
      const nodes = dump(serial);
      return Boolean(
        find(nodes, "Open navigation menu") || find(nodes, composer),
      );
    },
    90_000,
  );
  if (!find(dump(serial), composer)) {
    // A fresh sign-in lands on "Choose a Bot to begin" with the drawer closed.
    if (!find(dump(serial), BOT_NAME))
      await tap(serial, ["Open navigation menu"]);
    await tap(serial, [BOT_NAME]);
    await waitFor(
      "the conversation",
      async () => Boolean(find(dump(serial), composer)),
      60_000,
    );
  }
  screenshot(serial, "smoke-signed-in");

  const message = `Local smoke ${new Date().toISOString().slice(11, 19)}. Reply with one short sentence.`;
  say("sending a message");
  const before = new Set(
    dump(serial)
      .map((node) => node.text)
      .filter(Boolean),
  );
  await tap(serial, ["Message your Bot", "Message"]);
  adb(serial, "shell", "input", "text", message.replaceAll(" ", "%s"));
  await tap(serial, ["Send"]);

  const status = new Set([
    "Working…",
    "Waiting…",
    "Stopping…",
    "Stopped",
    "Checking whether your message went through…",
  ]);
  let reply: string | undefined;
  let outcome: string | undefined;
  await waitFor(
    "a reply from the Bot",
    async () => {
      const nodes = dump(serial);
      if (
        nodes.some((node) => node.text === "The reply couldn’t be completed.")
      )
        die("the Turn failed — see the Worker log");
      reply = nodes
        .map((node) => node.text)
        .find(
          (text) =>
            text && !before.has(text) && text !== message && !status.has(text),
        );
      if (reply) return true;
      // The Turn may have completed with the model's text in the run's outcome
      // and no bubble: plain assistant text is not rendered, only what the
      // Bot sends with `send_to_user` (issue #153).
      const runs = await api<{
        runs: { input?: string; status: string; outcome?: { text?: string } }[];
      }>(`/api/bots/${BOT_ID}/turns`);
      const run = runs.runs.find((each) => each.input === message);
      if (run?.status === "completed") outcome = run.outcome?.text ?? "";
      return outcome !== undefined;
    },
    300_000,
  );
  screenshot(serial, "smoke-replied");
  if (reply) {
    say(`the Bot replied: ${JSON.stringify(reply)}`);
    console.log("\nsmoke: PASS");
  } else {
    warn(
      `the Turn completed and the model answered ${JSON.stringify(outcome)}, but nothing reached the chat: the Bot did not call send_to_user (issue #153)`,
    );
    console.log("\nsmoke: PASS (silent reply)");
  }
}

// --------------------------------------------------------------- status

function status(extra: { model?: string; computer?: string } = {}): void {
  const pid = (name: string) =>
    existsSync(pidFile(name))
      ? readFileSync(pidFile(name), "utf8").trim()
      : "-";
  console.log();
  say("stack");
  console.log(
    `  Worker         ${hostOrigin}   (pid ${pid("worker")}) — the emulator reaches it there too, via adb reverse`,
  );
  console.log(
    `  Computer host  http://127.0.0.1:${computerHostPort}   (pid ${pid("computer-host")})`,
  );
  console.log(`  Emulator       ${emulatorSerial() ?? "not running"}`);
  console.log(`  State          ${stateDir}`);
  console.log(`  Logs           ${logDir}`);
  if (extra.model) console.log(`  Model          ${extra.model}`);
  if (extra.computer) console.log(`  Computer       ${extra.computer}`);
  console.log();
  say("the app is signed in as the `development` User, an admin here.");
  console.log(`  Web:   open ${hostOrigin}/?as_user=${DEVELOPMENT_USER}`);
  console.log(
    `  Hot reload: adb reverse tcp:${workerPort} tcp:${workerPort} && cd apps/native && flutter run -d ${emulatorSerial() ?? "<emulator>"} \\`,
  );
  console.log(
    `      --dart-define=FROCKBOT_ORIGIN=${emulatorOrigin} --dart-define=FROCKBOT_DEV_AUTH=true`,
  );
  console.log(`  Stop:  bun scripts/native-dev.ts down`);
  console.log();
}

async function up(): Promise<void> {
  const vars = ensureDevVars();
  down();
  buildAndSeed();
  const served = await serve(vars);
  const model = await seedDevelopmentUser(vars);
  const serial = await ensureEmulator();
  installApp(serial);
  adb(serial, "shell", "am", "start", "-n", `${APP}/.MainActivity`);
  status({ model, computer: served.computer });
}

switch (process.argv[2] ?? "up") {
  case "up":
    await up();
    break;
  case "serve": {
    // Restart the Workers on the existing state; no build, no seed.
    const vars = ensureDevVars();
    down();
    status(await serve(vars));
    break;
  }
  case "app": {
    // Rebuild and reinstall the app alone; the Workers keep running.
    const serial = await ensureEmulator();
    installApp(serial);
    adb(serial, "shell", "am", "start", "-n", `${APP}/.MainActivity`);
    break;
  }
  case "seed":
    // Re-seed the development User against a running stack: the Bot, and
    // the Ollama connection once OLLAMA_API_KEY lands in .dev.vars.
    say(
      await seedDevelopmentUser(readVars(resolve(cloudflareRoot, ".dev.vars"))),
    );
    break;
  case "smoke":
    await smoke();
    break;
  case "down":
    down();
    say("stopped");
    break;
  case "status":
    status();
    break;
  default:
    die(
      "usage: bun scripts/native-dev.ts [up|serve|app|seed|smoke|down|status]",
    );
}
