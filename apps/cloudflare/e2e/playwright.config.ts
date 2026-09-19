// The browser end-to-end project.
//
// One browser, one app Worker, and one auxiliary Frock AI RPC Worker: the
// specs share those processes and the fake providers, and each takes a fresh
// `?as_user=` identity so no two ever meet in one User Durable Object.
// `e2e/harness.ts` is the `webServer`.
//
// The ports are reserved here rather than inside the harness so this process
// can hand stable addresses to the harness and the specs.
import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { reserveFreePort } from "./ports.ts";
import {
  e2eSuite,
  e2eTestSelection,
  publicationJourneyTimeoutMs,
  publicationSpecFiles,
  suiteNeedsAppletBuild,
} from "./suite.ts";
import type { E2EOptions } from "./fixtures.ts";

const cloudflareRoot = fileURLToPath(new URL("..", import.meta.url));

/** What the webServer is allowed to come up in, container build included. */
const webServerStartupMs = 900_000;

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
const frockAiPort = await stablePort("FROCKBOT_E2E_FROCK_AI_PORT");
const appletBuildPort = await stablePort("FROCKBOT_E2E_APPLET_BUILD_PORT");
const baseURL = `http://127.0.0.1:${port}`;
const suite = e2eSuite();
const appletBuild = suiteNeedsAppletBuild(suite);

// A lane's clock has to reach every stage it sanctions: the webServer's
// startup, then each of its journeys' own budget. A publication spec file is
// one journey, and the lane runs them one after another in one process, so
// every one of them counts.
const publicationRunMs =
  publicationSpecFiles.length * publicationJourneyTimeoutMs +
  webServerStartupMs;

// Specs and the webServer run in separate processes. Record the suite's
// infrastructure requirement once so both answer the same question.
process.env.FROCKBOT_E2E_APPLET_BUILD = appletBuild ? "1" : "0";

export default defineConfig<object, E2EOptions>({
  testDir: ".",
  // Not `*.spec.ts`: root `bun test` — and therefore the pre-commit hook —
  // matches `*.spec.ts` as well as `*.test.ts`, and a Playwright spec loaded by
  // Bun's runner throws. `*.e2e.ts` keeps this layer out by construction, the
  // way `*.integration.ts` and `*.workerd.ts` already do.
  ...e2eTestSelection(suite),
  // A file is one indivisible group: the specs inside a file share a page and
  // an account where they say so, and Playwright would otherwise hand two of
  // them to different workers.
  fullyParallel: false,
  // Files, on the other hand, no longer share anything a run can see. Every
  // test takes a fresh `?as_user=` identity, and the fake provider's chat mode
  // is keyed by the endpoint the test's own Connection points at
  // (`e2eOllamaEndpointV1`), so one spec's `unauthorized` is invisible to the
  // rest. What is left in common is the app Worker and the browser, which
  // several files can use at once.
  //
  // The core corpus is sharded across four CI runners, each with two cores, so
  // the parallelism there is between runners; locally it is between workers.
  // Publication owns one real build service, so the lane that holds its two
  // journeys runs them serially: neither can tear down a content-addressed
  // image under the other.
  workers: suite === "publication" || process.env.CI ? 1 : 4,
  forbidOnly: !!process.env.CI,
  // The old blanket retries were for a wrangler crash that is now patched and
  // supervised. They turned deterministic regressions into thirty-minute
  // runs and let genuine flakes report green. A failure stays failed.
  retries: 0,
  // Once two independent claims are red the release is already blocked and
  // the retained traces are enough to diagnose it. Stopping there prevents a
  // shared helper regression from spending every test's timeout in a shard.
  maxFailures: process.env.CI ? 2 : 0,
  // Exit through Playwright, not GitHub's job SIGTERM, so reporters can finish
  // their blob and the diagnostic steps can upload it. This clock includes
  // webServer startup, and the publication lane's is its startup allowance
  // plus every journey it runs: a run in which each stays inside its own
  // fifteen minutes is not cut off by a shard-sized budget underneath them.
  globalTimeout: process.env.CI
    ? appletBuild
      ? publicationRunMs
      : 20 * 60_000
    : 0,
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
  // `balanced-shard-reporter` is a reporter only because that is where
  // Playwright lets sharding be taken over; it prints nothing. Without it one
  // runner is handed a third of the suite — see `shard-plan.ts`.
  reporter: process.env.CI
    ? [
        ["./balanced-shard-reporter.ts"],
        ["list"],
        ["blob", { outputDir: "blob-report" }],
      ]
    : [["./balanced-shard-reporter.ts"], ["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    ollamaServerUrl: `http://127.0.0.1:${ollamaPort}`,
    // Dictation needs a microphone, and a headless browser has none. Chromium
    // synthesises one: a generated tone on a fake capture device, and a
    // permission prompt that answers itself. The transcript is the fake
    // upstream's business, not the audio's — no real transcriber would make
    // words of a tone — so this only has to make frames flow.
    permissions: ["microphone"],
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "bun e2e/serve.ts",
    cwd: cloudflareRoot,
    // `/favicon.ico` is one of the gateway's public asset paths, so it needs no
    // identity header — which `webServer.url` cannot send. It is served by the
    // loaded artifact, so a 200 here already proves the artifact was built,
    // seeded into R2 and loaded. The harness additionally waits for
    // `/app-manifest` under a real identity before it reports ready.
    url: `${baseURL}/favicon.ico`,
    // The Applet build service is a container app, and `wrangler dev` builds
    // its image on start. That is minutes on a cold Docker cache and seconds
    // afterwards, and it happens before the app Worker is up.
    timeout: webServerStartupMs,
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
      FROCKBOT_E2E_FROCK_AI_PORT: String(frockAiPort),
      FROCKBOT_E2E_APPLET_BUILD_PORT: String(appletBuildPort),
      FROCKBOT_E2E_APPLET_BUILD: appletBuild ? "1" : "0",
    },
  },
});
