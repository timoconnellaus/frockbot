/**
 * `bun run dev:cloudflare` — the gateway Worker under `wrangler dev`, after a
 * fresh artifact build. The child is killed when this process stops, so no
 * wrangler is left holding a port.
 */
import { fileURLToPath } from "node:url";

const cloudflareRoot = fileURLToPath(new URL(".", import.meta.url));
const workerPort = process.env.FROCKBOT_DEV_WORKER_PORT ?? "8787";

const build = Bun.spawn(["bun", "run", "artifact:build"], {
  cwd: cloudflareRoot,
  stdout: "inherit",
  stderr: "inherit",
});
if ((await build.exited) !== 0) process.exit(1);

const worker = Bun.spawn(
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
    "--var",
    "ALLOW_DEVELOPMENT_AUTH:true",
  ],
  {
    cwd: cloudflareRoot,
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
  },
);
const stop = () => worker.kill();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("exit", stop);
await worker.exited;
