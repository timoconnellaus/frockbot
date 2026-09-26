import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PLUGIN_MODULE_RUNTIME_JS_BASE64_V1,
  type PluginModuleTryRequestV1,
} from "@frockbot/core/contracts";

import {
  denoRunArgsV1,
  moduleEnvironmentV1,
  type ModulePathsV1,
} from "./sandbox.ts";
import {
  fitModuleTryResultV1,
  moduleDenialsV1,
  runModuleTryV1,
} from "./try.ts";

const RUNTIME = join(import.meta.dir, "runtime.ts");

const SOURCE = `
export const calls = {
  echo: async (input, ctx) => {
    ctx.log("log", "echoing");
    await ctx.emit("message", { text: input.text }, { key: "m-1" });
    return { input, last: await ctx.lastKey("message"), cursor: await ctx.store.get("cursor") };
  },
  script: (_input, ctx) => ctx.appleEvents.run("com.apple.iChat", "tell app"),
  die: () => process.exit(3),
};
export async function start(ctx) {
  if ((await ctx.store.get("mode")) === "listen") {
    await ctx.emit("message", { text: "from start" }, { key: "m-2" });
  }
}
`;

function request(
  action: PluginModuleTryRequestV1["action"],
  overrides: Partial<PluginModuleTryRequestV1> = {},
): PluginModuleTryRequestV1 {
  return {
    module: {
      id: "bridge",
      read: [],
      net: [],
      appleEvents: ["com.apple.iChat"],
      calls: ["echo", "script", "die"],
      events: ["message"],
    },
    code: SOURCE,
    action,
    waitMs: 5_000,
    startMs: 10_000,
    lastKeys: { message: "m-0" },
    store: { cursor: 7 },
    ...overrides,
  };
}

/** The module under Bun, as the supervisor's own tests run it. */
async function underBun(tried: PluginModuleTryRequestV1) {
  const directory = await mkdtemp(join(tmpdir(), "module-try-"));
  const code = join(directory, "module.ts");
  await writeFile(code, tried.code, "utf8");
  return runModuleTryV1(tried, {
    spawn: () => spawn(process.execPath, [RUNTIME, code]),
  });
}

describe("a module try", () => {
  test("a call answers with its value, what it emitted and what it logged", async () => {
    const result = await underBun(
      request({ call: "echo", input: { text: "hi" } }),
    );
    expect(result.call).toEqual({
      ok: true,
      value: { input: { text: "hi" }, last: "m-0", cursor: 7 },
    });
    expect(result.events).toEqual([
      { event: "message", key: "m-1", payload: { text: "hi" } },
    ]);
    expect(result.logs).toEqual([{ level: "log", text: "echoing" }]);
    expect(result.denials).toEqual([]);
  });

  test("a call the module does not declare is refused", async () => {
    const result = await underBun(request({ call: "send", input: null }));
    expect(result.call).toEqual({
      ok: false,
      error: 'the module declares no call "send"',
    });
  });

  test("Apple Events say they run only on the Mac", async () => {
    const result = await underBun(request({ call: "script", input: null }));
    expect(result.call).toMatchObject({
      ok: false,
      error: expect.stringContaining("run only on the person's Mac"),
    });
  });

  test("an event is played by the module's start", async () => {
    const result = await underBun(
      request({ event: "message" }, { store: { mode: "listen" } }),
    );
    expect(result.heard).toBe(true);
    expect(result.events).toEqual([
      { event: "message", key: "m-2", payload: { text: "from start" } },
    ]);
  });

  test("a module that dies says how, and is not restarted", async () => {
    const result = await underBun(request({ call: "die", input: null }));
    expect(result.call).toMatchObject({ ok: false });
    expect(result.exited).toContain("exited with code 3");
  });

  test("waits no longer than it was told for an event that never comes", async () => {
    const started = Date.now();
    const result = await underBun(
      request({ event: "message" }, { waitMs: 300, startMs: 0 }),
    );
    expect(result.heard).toBe(false);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("what Deno refused", () => {
  test("is read from Deno's own words, wherever they appear", () => {
    expect(
      moduleDenialsV1([
        'Requires read access to "/home/box/secret.db", run again with the --allow-read flag',
        'NotCapable: Requires net access to "example.com:443", run again with the --allow-net flag',
        'Requires read access to "/home/box/secret.db", run again with the --allow-read flag',
        "an ordinary log line",
      ]),
    ).toEqual(['read "/home/box/secret.db"', 'net "example.com:443"']);
  });
});

describe("a try's result", () => {
  test("fits one line, cutting logs first and saying so", () => {
    const fitted = fitModuleTryResultV1(
      {
        call: { ok: true, value: "x".repeat(20_000) },
        events: [],
        logs: Array.from({ length: 100 }, (_, index) => ({
          level: "log" as const,
          text: `${index} ${"y".repeat(600)}`,
        })),
        denials: [],
      },
      16_000,
    );
    expect(
      new TextEncoder().encode(JSON.stringify(fitted)).byteLength,
    ).toBeLessThanOrEqual(16_000);
    expect(fitted.logs.at(-1)?.text.startsWith("99 ")).toBe(true);
    expect(fitted.trimmed).toContain("the call's value, as JSON");
  });
});

// With a Deno binary on hand, the try runs as it does on a Computer: the
// bundled runtime, under the flags the declaration generates, and a read
// outside the declaration is refused and reported.
const DENO = process.env.FROCKBOT_TEST_DENO;
describe.skipIf(!DENO)("a module try under Deno", () => {
  test("a read outside the declaration is a denial", async () => {
    const directory = await mkdtemp(join(tmpdir(), "module-try-deno-"));
    const allowed = join(directory, "allowed.txt");
    const secret = join(directory, "secret.txt");
    await writeFile(allowed, "yes", "utf8");
    await writeFile(secret, "no", "utf8");
    const paths: ModulePathsV1 = {
      deno: DENO!,
      runtime: join(directory, "runtime.js"),
      code: join(directory, "module.js"),
      data: directory,
    };
    await writeFile(
      paths.runtime,
      Buffer.from(PLUGIN_MODULE_RUNTIME_JS_BASE64_V1, "base64"),
    );
    const tried = request(
      { call: "read", input: null },
      {
        module: {
          id: "reader",
          read: [allowed],
          net: [],
          appleEvents: [],
          calls: ["read"],
          events: [],
        },
        code: `import { readFileSync } from "node:fs";
export const calls = {
  read: () => {
    const allowed = readFileSync(${JSON.stringify(allowed)}, "utf8");
    try { readFileSync(${JSON.stringify(secret)}, "utf8"); } catch (error) { console.error(error.message); }
    return allowed;
  },
};`,
      },
    );
    await writeFile(paths.code, tried.code, "utf8");
    const result = await runModuleTryV1(tried, {
      spawn: () =>
        spawn(DENO!, denoRunArgsV1(tried.module, paths), {
          env: moduleEnvironmentV1(paths),
          cwd: directory,
        }),
    });
    expect(result.call).toEqual({ ok: true, value: "yes" });
    expect(result.denials).toEqual([`read "${secret}"`]);
  });
});
