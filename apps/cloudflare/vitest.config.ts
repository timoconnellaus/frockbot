import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

function readDevVariable(name: string): string | undefined {
  let source: string;
  try {
    source = readFileSync(resolve(import.meta.dirname, ".dev.vars"), "utf8");
  } catch {
    return undefined;
  }
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] !== name) continue;
    const value = match[2] ?? "";
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      return value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

const runLiveSpriteTest = process.env.FROCKBOT_RUN_LIVE_SPRITE_TEST === "1";
// The User Durable Object mounts the Credential Store Contribution the moment
// any User Contribution resolves, and `createBot` goes through it. The test
// worker is a production bootstrap, so it needs a keyring exactly as the
// deployed Worker does; this one is a test fixture and holds nothing real.
const testCredentialKeyring = JSON.stringify({
  schemaVersion: 1,
  currentKeyId: "primary",
  keys: { primary: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY" },
});
const spritesToken = runLiveSpriteTest
  ? (process.env.SPRITES_TOKEN ?? readDevVariable("SPRITES_TOKEN") ?? "")
  : "";

/**
 * The Bot and User Durable Objects reach Ollama Cloud through the global
 * `fetch` their Packages own, so the workerd harness stubs the provider at the
 * outbound seam rather than injecting a fetcher past the Package boundary. The
 * production request shapes are asserted by the Package's own tests; here the
 * stub only has to answer them.
 */
function ollamaCloudStub(request: Request): Response {
  const url = new URL(request.url);
  if (url.origin !== "https://ollama.com") {
    return new Response("outbound request is not allowed in tests", {
      status: 403,
    });
  }
  if (url.pathname === "/api/tags") {
    return Response.json({ models: [{ model: "glm-5.3-flash:cloud" }] });
  }
  if (url.pathname === "/api/show") {
    return Response.json({ capabilities: ["tools"], model_info: {} });
  }
  // `POST /api/chat` is the only endpoint that authenticates a key (see
  // docs/research/ollama-cloud-auth.md), so Connection validation probes it.
  if (url.pathname === "/api/chat") {
    return Response.json({
      model: "glm-5.3-flash:cloud",
      message: { role: "assistant", content: "H" },
      done: true,
      done_reason: "length",
      prompt_eval_count: 68,
      eval_count: 1,
    });
  }
  if (url.pathname === "/v1/chat/completions") {
    return new Response(
      'data: {"choices":[{"delta":{"content":"Ollama reply"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
        "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }
  return new Response("unexpected Ollama Cloud request", { status: 404 });
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/fly-compatibility-worker.ts",
      miniflare: {
        outboundService: (request: Request) =>
          Promise.resolve(ollamaCloudStub(request)),
        compatibilityDate: "2026-08-27",
        compatibilityFlags: ["nodejs_compat"],
        workerLoaders: {
          BOT_PACKAGES: {},
        },
        r2Buckets: ["APPLICATION_ARTIFACTS", "MEMORY_FILES"],
        durableObjects: {
          AUTHORING: "AuthoringProbe",
          BOT_ISOLATES: "BotIsolateProbe",
          BOT_STATES: "WorkerdBotState",
          COMPOSITIONS: "CompositionProbe",
          FLY_COMPATIBILITY: "FlyCompatibilityProbe",
          USER_CONFIGURATIONS: "UserConfiguration",
        },
        bindings: {
          CREDENTIAL_KEYRING: testCredentialKeyring,
          FROCKBOT_RUN_LIVE_SPRITE_TEST: runLiveSpriteTest ? "1" : "0",
          SPRITES_TOKEN: spritesToken,
          // A leak canary: a Bot isolate must never see a host binding.
          SECRET_TOKEN: "host-only-secret",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.workerd.ts"],
    testTimeout: 15 * 60_000,
  },
});
