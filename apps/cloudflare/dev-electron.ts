import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cloudflareRoot = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = resolve(cloudflareRoot, "../..");
const desktopRoot = resolve(repositoryRoot, "apps/desktop");
const developmentHost = process.env.FROCKBOT_DEV_HOST ?? "127.0.0.1";
const workerUrl = `http://${developmentHost}:8787`;
const rendererUrl = `http://${developmentHost}:5173`;
const children: Bun.Subprocess[] = [];
let stopping = false;

async function run(command: string[], cwd: string): Promise<void> {
  const process = Bun.spawn(command, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} exited with code ${exitCode}`);
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

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

try {
  await run(["bun", "run", "artifact:build"], cloudflareRoot);
  await run(
    [
      "bunx",
      "wrangler",
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

  const worker = spawn(
    [
      "bunx",
      "wrangler",
      "dev",
      "--port",
      "8787",
      "--var",
      "ALLOW_DEVELOPMENT_AUTH:true",
    ],
    cloudflareRoot,
  );
  const renderer = spawn(
    ["bunx", "vite", "--host", "127.0.0.1"],
    cloudflareRoot,
  );
  await Promise.all([
    waitFor(`${workerUrl}/`, {
      "x-frockbot-user-id": "development",
    }),
    waitFor(`${rendererUrl}/`),
  ]);
  const electron = spawn(["bunx", "electron-vite", "dev"], desktopRoot, {
    FROCKBOT_APPLICATION_URL: `${rendererUrl}/`,
    FROCKBOT_AUTH_BASE_URL: workerUrl,
  });

  const exitCode = await Promise.race([
    worker.exited,
    renderer.exited,
    electron.exited,
  ]);
  stop();
  await Promise.all(children.map((child) => child.exited));
  process.exitCode = exitCode;
} catch (error) {
  stop();
  throw error;
}
