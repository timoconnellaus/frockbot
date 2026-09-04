/**
 * `bun run dev:cloudflare` — the gateway Worker plus the Workers it binds to.
 *
 * `wrangler dev --env development` alone leaves `PACKAGE_BUNDLER` unresolved.
 * A service binding resolves only through the dev service registry, which
 * publishes Workers that are themselves running under `wrangler dev` on this
 * machine, so the bundler needs a session of its own — the same shape the
 * end-to-end harness uses for the Frock AI fake (`e2e/harness.ts`). Without it
 * `package_author` writes `package/author-intent`, cannot reach the bundler,
 * and refuses with `Worker "frockbot-cloudflare-bundler" not found`: journey 4
 * is unrunnable on the documented local target (finding F5b).
 *
 * Both children are killed when this process stops, so no wrangler is left
 * holding a port. Nothing else on the machine is signalled.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cloudflareRoot = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = resolve(cloudflareRoot, "../..");
const bundlerPort = process.env.FROCKBOT_DEV_BUNDLER_PORT ?? "8788";
const workerPort = process.env.FROCKBOT_DEV_WORKER_PORT ?? "8787";

const children: Bun.Subprocess[] = [];
let stopping = false;

function stop(): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("exit", stop);

function spawn(command: string[], cwd: string): Bun.Subprocess {
  const child = Bun.spawn(command, {
    cwd,
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
  });
  children.push(child);
  return child;
}

const build = Bun.spawn(["bun", "run", "artifact:build"], {
  cwd: cloudflareRoot,
  stdout: "inherit",
  stderr: "inherit",
});
if ((await build.exited) !== 0) process.exit(1);

// No `--env`: the bundler's `wrangler.jsonc` declares no environments, and
// `--env development` would register it as `frockbot-cloudflare-bundler-
// development`, a name no binding names. Spawned in its own directory so
// `bunx` resolves that app's wrangler; the repository root's hoisted 4.93 has
// an older workerd than the bundler's compatibility date and refuses to start.
const bundler = spawn(
  [
    "bunx",
    "wrangler",
    "dev",
    "--ip",
    "127.0.0.1",
    "--port",
    bundlerPort,
    "--local",
  ],
  resolve(repositoryRoot, "apps/cloudflare-bundler"),
);

const worker = spawn(
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
  cloudflareRoot,
);

// Either child exiting takes the whole session down, so a bundler that failed
// to start is noticed rather than silently absent.
await Promise.race([worker.exited, bundler.exited]);
stop();
