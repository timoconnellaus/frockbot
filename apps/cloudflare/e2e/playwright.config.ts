// The browser end-to-end project.
//
// One browser, one app Worker, and one auxiliary Flock AI RPC Worker: the
// specs share those processes and the fake providers, and each takes a fresh
// `?as_user=` identity so no two ever meet in one User Durable Object.
// `e2e/harness.ts` is the `webServer`.
//
// The ports are reserved here rather than inside the harness so this process
// can hand stable addresses to the harness and the specs.
import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { reserveFreePort } from "./ports.ts";
import type { E2EOptions } from "./fixtures.ts";

const cloudflareRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * Playwright loads this file once in the runner process and again in every
 * worker process, so a port reserved unconditionally would differ between the
 * server the harness starts and the address the specs navigate to. The first
 * load records its choice in the environment the workers inherit, which is the
 * same environment the harness reads.
 */
async function stablePort(name: string): Promise<number> {
  const existing = Number(process.env[name]);
  if (Number.isInteger(existing) && existing > 0) return existing;
  const port = await reserveFreePort();
  process.env[name] = String(port);
  return port;
}

const port = await stablePort("FROCKBOT_E2E_PORT");
const ollamaPort = await stablePort("FROCKBOT_E2E_OLLAMA_PORT");
const flockAiPort = await stablePort("FROCKBOT_E2E_FLOCK_AI_PORT");
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig<E2EOptions>({
  testDir: ".",
  // Not `*.spec.ts`: root `bun test` — and therefore the pre-commit hook —
  // matches `*.spec.ts` as well as `*.test.ts`, and a Playwright spec loaded by
  // Bun's runner throws. `*.e2e.ts` keeps this layer out by construction, the
  // way `*.integration.ts` and `*.workerd.ts` already do.
  testMatch: "**/*.e2e.ts",
  // The specs share one Worker and one fake provider whose chat mode a spec can
  // change, so they must not overlap.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // A single retry in CI distinguishes a real regression from a flaky
  // start-up; locally a failure should stay failed.
  retries: process.env.CI ? 1 : 0,
  // A CI runner is several times slower than a laptop, and the paths here are
  // the product's coldest: an application isolate load, a Durable Object start,
  // a Composition mount. The budget is for that, not for hiding a hang — a
  // genuinely stuck run still fails, just later.
  timeout: 240_000,
  expect: { timeout: 30_000 },
  outputDir: "test-results",
  // CI runs this project as several `--shard`s on separate runners, so no one
  // runner sees the whole suite and none of them can write the whole HTML
  // report. Each shard emits a blob instead, and CI merges the blobs into one
  // report when a shard fails.
  reporter: process.env.CI
    ? [["list"], ["blob", { outputDir: "blob-report" }]]
    : [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    ollamaBaseUrl: `http://127.0.0.1:${ollamaPort}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "bun e2e/serve.ts",
    cwd: cloudflareRoot,
    // `/app.js` is one of the gateway's public asset paths, so it needs no
    // identity header — which `webServer.url` cannot send. It is served by the
    // loaded artifact, so a 200 here already proves the artifact was built,
    // seeded into R2 and loaded. The harness additionally waits for
    // `/app-manifest` under a real identity before it reports ready.
    url: `${baseURL}/app.js`,
    timeout: 180_000,
    reuseExistingServer: false,
    // Playwright's default is an immediate SIGKILL of the server's process
    // group, which cannot reach `wrangler dev` — the harness deliberately puts
    // it in a group of its own so the whole tree can be signalled at once. A
    // graceful SIGTERM lets the harness run its own teardown instead, so no
    // workerd survives the run and the temporary `--persist-to` directory is
    // removed.
    gracefulShutdown: { signal: "SIGTERM", timeout: 20_000 },
    stdout: "pipe",
    stderr: "pipe",
    env: {
      FROCKBOT_E2E_PORT: String(port),
      FROCKBOT_E2E_OLLAMA_PORT: String(ollamaPort),
      FROCKBOT_E2E_FLOCK_AI_PORT: String(flockAiPort),
    },
  },
});
