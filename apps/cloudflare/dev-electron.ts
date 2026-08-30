import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveAndroidDevelopmentTarget,
  type AndroidDevelopmentTarget,
} from "../mobile/dev-target.ts";

const cloudflareRoot = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = resolve(cloudflareRoot, "../..");
const desktopRoot = resolve(repositoryRoot, "apps/desktop");
const mobileRoot = resolve(repositoryRoot, "apps/mobile");
const androidRoot = resolve(mobileRoot, "android");
const desktopRendererUrl = "http://127.0.0.1:5173";
const children: Bun.Subprocess[] = [];
let stopping = false;

async function run(
  command: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} exited with code ${exitCode}`);
  }
}

async function output(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} exited with code ${exitCode}: ${stderr.trim()}`,
    );
  }
  return stdout;
}

async function detectAndroidTarget(): Promise<
  AndroidDevelopmentTarget | undefined
> {
  if (!Bun.which("adb")) return undefined;

  try {
    const adbDevices = await output(["adb", "devices"], repositoryRoot);
    if (!/^\S+\s+device\s*$/m.test(adbDevices)) return undefined;
    if (!Bun.which("tailscale")) {
      console.warn(
        "Connected Android device found, but Tailscale is unavailable; skipping phone install.",
      );
      return undefined;
    }

    return resolveAndroidDevelopmentTarget({
      adbDevices,
      tailscaleIpv4: await output(["tailscale", "ip", "-4"], repositoryRoot),
      preferredDeviceSerial: process.env.ANDROID_SERIAL,
    });
  } catch (error) {
    console.warn(
      `Skipping connected Android device: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

async function waitFor(url: string, headers?: HeadersInit): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return;
    } catch {
      // The development server is still starting.
    }
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function spawn(command: string[], cwd: string, env?: Record<string, string>) {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  children.push(child);
  return child;
}

function stop(): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
}

async function installAndroidApp(
  target: AndroidDevelopmentTarget,
): Promise<void> {
  const apk = resolve(androidRoot, "app/build/outputs/apk/debug/app-debug.apk");
  await run(["./gradlew", ":app:assembleDebug"], androidRoot);
  await run(
    ["adb", "-s", target.deviceSerial, "install", "-r", apk],
    repositoryRoot,
  );
  await run(
    [
      "adb",
      "-s",
      target.deviceSerial,
      "shell",
      "am",
      "start",
      "-S",
      "-n",
      "com.frockbot.mobile/.MainActivity",
    ],
    repositoryRoot,
  );
  console.log(
    `Installed FrockBot on ${target.deviceSerial}; live reload uses ${target.rendererUrl}.`,
  );
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

try {
  const androidTarget = await detectAndroidTarget();
  const developmentHost =
    androidTarget?.tailscaleHost ??
    process.env.FROCKBOT_DEV_HOST ??
    "127.0.0.1";
  const workerUrl = `http://${developmentHost}:8787`;

  if (androidTarget) {
    const mobileEnvironment = {
      FROCKBOT_MOBILE_DEV_SERVER_URL: androidTarget.rendererUrl,
      VITE_FROCKBOT_GATEWAY_URL: androidTarget.gatewayUrl,
    };
    await run(["bun", "run", "build"], mobileRoot, mobileEnvironment);
    await run(
      ["bunx", "cap", "sync", "android"],
      mobileRoot,
      mobileEnvironment,
    );
  }

  await run(["bun", "run", "artifact:build"], cloudflareRoot);
  await run(
    [
      "bunx",
      "wrangler",
      "--env",
      "development",
      "r2",
      "object",
      "put",
      "frockbot-application-artifacts/applications/foundation-v1.mjs",
      "--file",
      "dist/artifacts/foundation-v1.mjs",
      "--local",
    ],
    cloudflareRoot,
  );

  const workerCommand = [
    "bunx",
    "wrangler",
    "dev",
    "--env",
    "development",
    "--ip",
    developmentHost,
    "--port",
    "8787",
    "--var",
    "ALLOW_DEVELOPMENT_AUTH:true",
  ];
  if (androidTarget) {
    workerCommand.push(
      "--var",
      `ALLOWED_CLIENT_ORIGINS:${androidTarget.rendererUrl}`,
    );
  }
  const worker = spawn(workerCommand, cloudflareRoot);
  const renderer = spawn(
    ["bunx", "vite", "--host", "127.0.0.1"],
    cloudflareRoot,
    { FROCKBOT_DEV_GATEWAY_URL: workerUrl },
  );
  const mobileRenderer = androidTarget
    ? spawn(
        ["bunx", "vite", "--host", androidTarget.tailscaleHost],
        mobileRoot,
        { VITE_FROCKBOT_GATEWAY_URL: androidTarget.gatewayUrl },
      )
    : undefined;

  await Promise.all([
    waitFor(`${workerUrl}/`, {
      "x-frockbot-user-id": "development",
    }),
    waitFor(`${desktopRendererUrl}/`),
    ...(androidTarget ? [waitFor(`${androidTarget.rendererUrl}/`)] : []),
  ]);

  const electron = spawn(["bunx", "electron-vite", "dev"], desktopRoot, {
    FROCKBOT_APPLICATION_URL: `${desktopRendererUrl}/`,
    FROCKBOT_AUTH_BASE_URL: desktopRendererUrl,
  });
  if (androidTarget) {
    let installFailure: unknown;
    try {
      await installAndroidApp(androidTarget);
    } catch (error) {
      installFailure = error;
    }
    if (installFailure) {
      console.warn(
        `Android install failed without stopping desktop development: ${installFailure instanceof Error ? installFailure.message : String(installFailure)}`,
      );
    }
  }

  const exitCode = await Promise.race(
    [worker, renderer, electron, mobileRenderer]
      .filter((child) => child !== undefined)
      .map((child) => child.exited),
  );
  stop();
  await Promise.all(children.map((child) => child.exited));
  process.exitCode = exitCode;
} catch (error) {
  stop();
  throw error;
}
