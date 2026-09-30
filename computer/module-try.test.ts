import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentRuntimeHarness,
  frockbotToolCall,
} from "@frockbot/app/testkit";
import {
  PLUGIN_MODULE_RUNTIME_JS_BASE64_V1,
  PLUGIN_MODULE_TRY_DENO_V1,
  PLUGIN_MODULE_TRY_RUNNER_JS_BASE64_V1,
} from "@frockbot/core/contracts";
import { COMPUTER_HOST_LIMITS } from "@frockbot/computer/host-protocol";
import type { ComputerHostV1 } from "@frockbot/computer/core/host";
import { createComputerAgentFeature } from "./agent.js";
import {
  PLUGIN_MODULE_TRY_SCRIPT_V1,
  type ComputerPluginModulesSeamV1,
} from "./module-try.js";

const DENO = process.env.FROCKBOT_TEST_DENO;

/**
 * A Computer that is this machine: each command runs here under bash, so the
 * try's own script, runner and runtime run exactly as they would on a
 * Computer. `MODULE_TRY_DENO` names the Deno to use instead of fetching one.
 */
function localHost(opened: string[]): ComputerHostV1 {
  return {
    id: "fixture",
    capabilities: { viewerFrameOrigins: [], availability: "always" },
    open: async (identity, tenant, assignment) => {
      opened.push("open");
      return {
        assignment,
        identity,
        tenant,
        capabilities: { viewerFrameOrigins: [], availability: "always" },
        exec: {
          execute: async (request) => {
            const ran = spawnSync(request.executable, request.args ?? [], {
              input: request.stdin,
              env: {
                ...process.env,
                ...request.env,
                ...(DENO ? { MODULE_TRY_DENO: DENO } : {}),
              },
              timeout: request.timeoutMs,
            });
            return {
              exitCode: ran.status,
              stdout: new Uint8Array(ran.stdout),
              stderr: new Uint8Array(ran.stderr),
              outputTruncated: false,
            };
          },
        },
        close: () => Promise.resolve(),
      };
    },
  };
}

async function mounted(modules: ComputerPluginModulesSeamV1) {
  const opened: string[] = [];
  const harness = createAgentRuntimeHarness();
  harness.computers.register(localHost(opened));
  await harness.mount(
    createComputerAgentFeature({
      userId: "user-1",
      productName: "FrockBot",
      defaultProviderId: "fixture",
      pluginModules: modules,
    }),
  );
  const call = async (input: unknown) => {
    const context = {
      botId: "bot-1",
      agentId: "run-1",
      compositionGenerationId: "bootstrap",
      turnType: "chat" as const,
      sessionId: "session-1",
      effectId: "tool:1:1:0",
      signal: new AbortController().signal,
    };
    const prepared = await harness.tools.prepare(
      frockbotToolCall("plugin_module_try", input, crypto.randomUUID()),
      context,
    );
    if (prepared.kind !== "ready") return prepared.result;
    return harness.tools.executePrepared(prepared, context);
  };
  return { harness, opened, call };
}

const BRIDGE = {
  id: "bridge",
  platforms: ["macos" as const],
  read: [],
  net: [],
  appleEvents: [],
  calls: ["search"],
  events: ["message"],
};

describe("plugin_module_try", () => {
  test("refuses a malformed try before building anything or waking a Computer", async () => {
    const asked: unknown[] = [];
    const { harness, opened, call } = await mounted({
      moduleToTry: async (input) => {
        asked.push(input);
        return { failure: "unreachable" };
      },
    });
    expect(
      await call({ pluginId: "beeper", call: "search", event: "message" }),
    ).toMatchObject({
      isError: true,
      content: "name exactly one of call (with its input) or event",
    });
    expect(
      await call({ pluginId: "beeper", call: "search", waitMs: 60_000 }),
    ).toMatchObject({
      isError: true,
      content: expect.stringContaining("waitMs"),
    });
    expect(asked).toEqual([]);
    expect(opened).toEqual([]);
    await harness.dispose();
  });

  test("an undeclared call is refused by the authoring host and no Computer wakes", async () => {
    const { harness, opened, call } = await mounted({
      moduleToTry: async (input) => {
        expect(input).toEqual({
          pluginId: "beeper",
          action: { call: "send", input: { text: "hi" } },
        });
        return {
          failure:
            'the module "bridge" declares no call "send"; it declares [search], and a desktop refuses any other',
        };
      },
    });
    expect(
      await call({ pluginId: "beeper", call: "send", input: { text: "hi" } }),
    ).toEqual({
      isError: true,
      content:
        'the module "bridge" declares no call "send"; it declares [search], and a desktop refuses any other',
    });
    expect(opened).toEqual([]);
    await harness.dispose();
  });

  test("the command it runs on the Computer is valid bash", () => {
    const checked = spawnSync("bash", ["-n"], {
      input: PLUGIN_MODULE_TRY_SCRIPT_V1,
    });
    expect(checked.stderr.toString()).toBe("");
    expect(checked.status).toBe(0);
  });

  test("the runner and runtime each fit one environment variable of an exec", () => {
    for (const value of [
      PLUGIN_MODULE_TRY_RUNNER_JS_BASE64_V1,
      PLUGIN_MODULE_RUNTIME_JS_BASE64_V1,
    ]) {
      expect(value.length).toBeLessThanOrEqual(COMPUTER_HOST_LIMITS.envValue);
    }
  });

  test("fetches the same Deno the Mac app ships", async () => {
    const pinned = await readFile(
      join(import.meta.dir, "../scripts/fetch-deno.py"),
      "utf8",
    );
    expect(pinned).toContain(
      `VERSION = "${PLUGIN_MODULE_TRY_DENO_V1.version}"`,
    );
    for (const [target, sha256] of Object.entries(
      PLUGIN_MODULE_TRY_DENO_V1.sha256,
    )) {
      expect(pinned).toContain(`"${target}": "${sha256}"`);
    }
  });

  // End to end on this machine, with the Deno the platform's tests name.
  test.skipIf(!DENO)(
    "runs the module under Deno and reports what its declaration refused",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "module-try-tool-"));
      const secret = join(directory, "chat.db");
      await writeFile(secret, "private", "utf8");
      const { harness, opened, call } = await mounted({
        moduleToTry: async () => ({
          pluginId: "beeper",
          module: BRIDGE,
          code: `import { readFileSync } from "node:fs";
export const calls = {
  search: async (input, ctx) => {
    await ctx.emit("message", { text: input.q }, { key: "m-1" });
    return readFileSync(${JSON.stringify(secret)}, "utf8");
  },
};`,
        }),
      });
      const result = await call({
        pluginId: "beeper",
        call: "search",
        input: { q: "hi" },
      });
      expect(result.isError).toBe(false);
      const body = JSON.parse(result.content) as Record<string, unknown>;
      expect(body.module).toBe("beeper/bridge");
      expect(body.call).toMatchObject({
        ok: false,
        error: expect.stringContaining("Requires read access"),
      });
      expect(body.denials).toEqual([`read "${secret}"`]);
      expect(body.events).toEqual([
        { event: "message", key: "m-1", payload: { text: "hi" } },
      ]);
      expect(opened).toEqual(["open"]);
      await harness.dispose();
    },
    60_000,
  );
});
