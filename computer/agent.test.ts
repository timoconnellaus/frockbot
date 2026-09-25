import { frockbotToolCall, discoverFrockbotTools } from "@frockbot/app/testkit";
import { describe, expect, test } from "bun:test";
import { ComputerError } from "@frockbot/computer/core";
import {
  type ComputerHostV1,
  type ComputerHostCapabilitiesV1,
} from "@frockbot/computer/core/host";
import {
  type AgentRuntimeHarness,
  createAgentRuntimeHarness,
} from "@frockbot/app/testkit";
import { createFakeComputerHostV1 } from "@frockbot/computer/fake";
import {
  browserResultTextV1,
  COMPUTER_OVERLOADED_TOOL_MESSAGE_V1,
  createComputerAgentFeature,
  HUMAN_CONTROL_PROMPT_LINE,
  type ComputerSecretFillSeamV1,
} from "./agent.js";
import { COMPUTER_CONTROL_RECORD_KEY } from "./control-record.js";

/** A host that offers nothing beyond the operations under test. */
const TEST_HOST_CAPABILITIES: ComputerHostCapabilitiesV1 = {
  viewerFrameOrigins: [],
};

async function execute(
  harness: AgentRuntimeHarness,
  name: string,
  input: unknown,
) {
  const context = {
    botId: "bot-1",
    agentId: "run-9",
    compositionGenerationId: "bootstrap",
    turnType: "chat" as const,
    sessionId: "session-1",
    effectId: "tool:1:1:0",
    signal: new AbortController().signal,
  };
  const prepared = await harness.tools.prepare(
    frockbotToolCall(name, input, crypto.randomUUID()),
    context,
  );
  if (prepared.kind !== "ready") throw new Error(prepared.result.content);
  return harness.tools.executePrepared(prepared, context);
}

describe("computer agent contribution", () => {
  test("routes generic tools through the Bot's selected Computer provider", async () => {
    const calls: string[] = [];
    const provider: ComputerHostV1 = {
      id: "fixture",
      capabilities: TEST_HOST_CAPABILITIES,
      open: async (identity, tenant, assignment) => {
        calls.push(`open:${identity.userId}:${tenant.botId}`);
        return {
          assignment,
          identity,
          tenant,
          capabilities: TEST_HOST_CAPABILITIES,
          exec: {
            execute: async (request) => {
              calls.push(
                `exec:${request.executable}:${request.args?.join(" ")}`,
              );
              return {
                exitCode: 0,
                stdout: new TextEncoder().encode("/workspace/bot-1"),
                stderr: new Uint8Array(),
                outputTruncated: false,
              };
            },
          },
          browser: {
            perform: async (action) => {
              calls.push(`browser:${action.type}`);
              return { accessibilitySnapshot: "button: Continue" };
            },
          },
          close: () => Promise.resolve(),
        };
      },
    };
    const harness = createAgentRuntimeHarness();
    harness.computers.register(provider);
    await harness.mount(
      createComputerAgentFeature({
        userId: "user-1",
        defaultProviderId: "fixture",
      }),
    );

    const exec = await execute(harness, "computer_exec", { command: "pwd" });
    const browser = await execute(harness, "computer_browser", {
      action: "snapshot",
    });

    expect(exec).toMatchObject({ content: "/workspace/bot-1", isError: false });
    expect(browser).toMatchObject({
      content: "button: Continue",
      isError: false,
    });
    expect(calls).toEqual([
      "open:user-1:bot-1",
      "exec:/bin/bash:-lc pwd",
      "open:user-1:bot-1",
      "browser:snapshot",
    ]);
    await harness.dispose();
  });

  test("computer_browser says which field a click is missing and takes label as name", async () => {
    const calls: string[] = [];
    const provider: ComputerHostV1 = {
      id: "fixture",
      capabilities: TEST_HOST_CAPABILITIES,
      open: async (identity, tenant, assignment) => ({
        assignment,
        identity,
        tenant,
        capabilities: TEST_HOST_CAPABILITIES,
        exec: {
          execute: async () => ({
            exitCode: 0,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
            outputTruncated: false,
          }),
        },
        browser: {
          perform: async (action) => {
            calls.push(JSON.stringify(action));
            return { accessibilitySnapshot: 'checkbox "Mark done"' };
          },
        },
        close: () => Promise.resolve(),
      }),
    };
    const harness = createAgentRuntimeHarness();
    harness.computers.register(provider);
    await harness.mount(
      createComputerAgentFeature({
        userId: "user-1",
        defaultProviderId: "fixture",
      }),
    );

    // Bob's first three attempts on production, in order.
    const onlyName = await execute(harness, "computer_browser", {
      action: "click",
      name: "Add",
    });
    expect(onlyName.isError).toBe(true);
    expect(onlyName.content).toContain("role and name are both required");
    expect(onlyName.content).toContain('"role":"button"');

    const onlyLabel = await execute(harness, "computer_browser", {
      action: "click",
      label: "Add",
    });
    expect(onlyLabel.isError).toBe(true);

    const labelWithRole = await execute(harness, "computer_browser", {
      action: "click",
      label: "Mark done",
      role: "checkbox",
    });
    expect(labelWithRole.isError).toBe(false);
    expect(calls).toEqual([
      JSON.stringify({ type: "click", role: "checkbox", name: "Mark done" }),
    ]);

    const unknown = await execute(harness, "computer_browser", {
      action: "hover",
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toContain('"action" must be one of');
    await harness.dispose();
  });

  // Production, 2026-09-04: the model sent a `cwd` the tool did not have, the
  // key was dropped without a word, and `cat server.ts` ran in the home
  // directory. Four steps went into working that out. The directory is carried
  // now, and an argument the tool does not know is refused by name.
  test("computer_exec runs in the cwd it is given and names an argument it does not know", async () => {
    const requests: Array<{ cwd?: string; command?: string }> = [];
    const provider: ComputerHostV1 = {
      id: "fixture",
      capabilities: TEST_HOST_CAPABILITIES,
      open: async (identity, tenant, assignment) => ({
        assignment,
        identity,
        tenant,
        capabilities: TEST_HOST_CAPABILITIES,
        exec: {
          execute: async (request) => {
            requests.push({
              ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
              ...(request.args?.[1] === undefined
                ? {}
                : { command: request.args[1] }),
            });
            return {
              exitCode: 0,
              stdout: new TextEncoder().encode("server.ts ui.tsx"),
              stderr: new Uint8Array(),
              outputTruncated: false,
            };
          },
        },
        close: () => Promise.resolve(),
      }),
    };
    const harness = createAgentRuntimeHarness();
    harness.computers.register(provider);
    await harness.mount(
      createComputerAgentFeature({
        userId: "user-1",
        defaultProviderId: "fixture",
      }),
    );

    const listed = await execute(harness, "computer_exec", {
      command: "ls",
      cwd: "/home/box/agent-data/source/todo",
    });
    expect(listed).toMatchObject({
      content: "server.ts ui.tsx",
      isError: false,
    });
    expect(requests).toEqual([
      { cwd: "/home/box/agent-data/source/todo", command: "ls" },
    ]);

    const relative = await execute(harness, "computer_exec", {
      command: "ls",
      cwd: "todo",
    });
    expect(relative.isError).toBe(true);
    expect(relative.content).toContain('"cwd" must be an absolute path');

    const misspelled = await execute(harness, "computer_exec", {
      command: "ls",
      directory: "/home/box",
    });
    expect(misspelled.isError).toBe(true);
    expect(misspelled.content).toContain('"directory"');
    expect(misspelled.content).toContain('It takes "command"');
    // Refused, never run with the argument quietly dropped.
    expect(requests).toHaveLength(1);
    await harness.dispose();
  });

  test("computer_exec during an update returns an actionable tool failure", async () => {
    const provider: ComputerHostV1 = {
      id: "fixture",
      capabilities: TEST_HOST_CAPABILITIES,
      open: async (identity, tenant, assignment) => ({
        assignment,
        identity,
        tenant,
        capabilities: TEST_HOST_CAPABILITIES,
        exec: {
          execute: async () => {
            throw new ComputerError(
              "updating",
              "Updating the Computer runtime",
              true,
            );
          },
        },
        close: () => Promise.resolve(),
      }),
    };
    const harness = createAgentRuntimeHarness();
    harness.computers.register(provider);
    await harness.mount(
      createComputerAgentFeature({
        userId: "user-1",
        defaultProviderId: "fixture",
      }),
    );

    const result = await execute(harness, "computer_exec", { command: "pwd" });

    expect(result).toEqual({
      content:
        "The Computer is updating (Updating the Computer runtime); try again shortly",
      isError: true,
    });
    await harness.dispose();
  });

  test("computer_exec maps overloaded transport failures to one bounded plain reason", async () => {
    for (const message of [
      "Computer command failed: WebSocket keepalive timeout after 45000ms",
      "The Computer effect was cancelled",
    ]) {
      const provider: ComputerHostV1 = {
        id: "fixture",
        capabilities: TEST_HOST_CAPABILITIES,
        open: async (identity, tenant, assignment) => ({
          assignment,
          identity,
          tenant,
          capabilities: TEST_HOST_CAPABILITIES,
          exec: {
            execute: () => Promise.reject(new Error(message)),
          },
          close: () => Promise.resolve(),
        }),
      };
      const harness = createAgentRuntimeHarness();
      harness.computers.register(provider);
      await harness.mount(
        createComputerAgentFeature({
          userId: "user-1",
          defaultProviderId: "fixture",
        }),
      );

      await expect(
        execute(harness, "computer_exec", { command: "pwd" }),
      ).resolves.toEqual({
        content: COMPUTER_OVERLOADED_TOOL_MESSAGE_V1,
        isError: true,
      });
      expect(COMPUTER_OVERLOADED_TOOL_MESSAGE_V1.length).toBeLessThanOrEqual(
        160,
      );
      await harness.dispose();
    }
  });

  test("injects and records the human-control line only while the durable lease is fresh", async () => {
    const records = new Map<string, unknown>([
      [
        COMPUTER_CONTROL_RECORD_KEY,
        {
          version: 1,
          ownerId: "human:session-1",
          acquiredAt: "2026-09-02T00:00:00.000Z",
          expiresAt: "2026-09-02T00:01:30.000Z",
        },
      ],
    ]);
    let now = new Date("2026-09-02T00:00:30.000Z");
    const harness = createAgentRuntimeHarness();
    await harness.mount(
      createComputerAgentFeature({
        userId: "user-1",
        defaultProviderId: "fixture",
        controlRecords: {
          get: <T>(key: string) =>
            Promise.resolve(records.get(key) as T | undefined),
          now: () => now,
        },
      }),
    );
    const session = harness.sessions.create("session-1");
    const preStep = (turn: number) =>
      harness.hooks.preStep({ session } as never, [], turn, 1, () =>
        Promise.resolve({ kind: "enter" as const, inputs: [] }),
      );
    const assemble = () =>
      harness.systemPrompt.assemble({
        sessionId: "session-1",
        provider: "fixture",
        model: "fixture",
        turnType: "chat",
      });

    await preStep(1);
    expect((await assemble()).text).toContain(HUMAN_CONTROL_PROMPT_LINE);
    now = new Date("2026-09-02T00:02:00.000Z");
    await preStep(2);
    expect((await assemble()).text).not.toContain(HUMAN_CONTROL_PROMPT_LINE);

    const injected = session.activeRunJournal.filter(
      (event) => event.type === "computer/injected",
    );
    expect(injected).toMatchObject([
      {
        type: "computer/injected",
        turn: 1,
        text: HUMAN_CONTROL_PROMPT_LINE,
        ownerId: "human:session-1",
        expiresAt: "2026-09-02T00:01:30.000Z",
      },
      { type: "computer/injected", turn: 2, text: "" },
    ]);
    await harness.dispose();
  });

  test("human-control-active is a non-throwing actionable tool result", async () => {
    const provider: ComputerHostV1 = {
      id: "fixture",
      capabilities: TEST_HOST_CAPABILITIES,
      open: async (identity, tenant, assignment) => ({
        assignment,
        identity,
        tenant,
        capabilities: TEST_HOST_CAPABILITIES,
        exec: {
          execute: async () => {
            throw new ComputerError(
              "human-control-active",
              "held by human:session-1",
            );
          },
        },
        close: () => Promise.resolve(),
      }),
    };
    const harness = createAgentRuntimeHarness();
    harness.computers.register(provider);
    await harness.mount(
      createComputerAgentFeature({
        userId: "user-1",
        defaultProviderId: "fixture",
      }),
    );

    await expect(
      execute(harness, "computer_exec", { command: "pwd" }),
    ).resolves.toEqual({
      content: "held by human:session-1; do not retry this Turn",
      isError: true,
    });
    await harness.dispose();
  });

  test("an unconfigured deployment offers no Computer tool and no Computer prompt", async () => {
    const harness = createAgentRuntimeHarness();
    await harness.mount(
      createComputerAgentFeature({
        userId: "user-1",
        defaultProviderId: "fixture",
        configured: false,
      }),
    );

    const registered = harness.tools.registeredNames?.() ?? [];
    expect(registered.filter((name) => name.startsWith("computer_"))).toEqual(
      [],
    );
    const prompt = await harness.systemPrompt.assemble({
      sessionId: "session-1",
      provider: "fixture",
      model: "fixture",
      turnType: "chat",
    });
    expect(prompt.text).not.toContain("Persistent Computer");
    expect(prompt.text).not.toContain("computer_exec");
    await harness.dispose();
  });
});

describe("computer_browser filling a saved secret", () => {
  const SECRET_ID = `secret-${"a".repeat(32)}`;
  const VALUE = "hunter2-correct-horse-9f3a1c7e";

  async function mountFill(authorize: ComputerSecretFillSeamV1["authorize"]) {
    const host = createFakeComputerHostV1();
    const opened: string[] = [];
    const released: string[] = [];
    const secrets: ComputerSecretFillSeamV1 = {
      authorize,
      open: async ({ secretId, effectId }) => {
        expect(secretId).toBe(SECRET_ID);
        opened.push(effectId);
        return VALUE;
      },
      release: async ({ effectId }) => {
        released.push(effectId);
      },
    };
    const harness = createAgentRuntimeHarness();
    harness.computers.register(host);
    await harness.mount(
      createComputerAgentFeature({
        userId: "user-1",
        defaultProviderId: host.id,
        secrets,
      }),
    );
    return { harness, host, opened, released };
  }

  test("types a value the Bot is never given, and says only that it did", async () => {
    const { harness, host, opened, released } = await mountFill(async () => ({
      status: "granted",
      origin: "https://shop.example",
      label: "Shop login",
    }));
    await execute(harness, "computer_browser", {
      action: "navigate",
      url: "https://shop.example/login",
    });

    const filled = await execute(harness, "computer_browser", {
      action: "fill",
      label: "Password",
      secret: SECRET_ID,
    });
    const after = await execute(harness, "computer_browser", {
      action: "snapshot",
    });

    expect(filled.isError).toBe(false);
    expect(filled.content).toContain('Filled "Password"');
    expect(filled.content).not.toContain(VALUE);
    // The value reached the page, and the page is the only place it went.
    const page = host.computerFor({ userId: "user-1" }).page;
    expect(page.fields.get("Password")).toEqual({
      value: VALUE,
      secret: true,
    });
    expect(after.content).not.toContain(VALUE);
    // One lease for one action, settled whatever happened.
    expect(opened).toHaveLength(1);
    expect(released).toEqual(opened);
    await harness.dispose();
  });

  test("a fill the person must approve asks and ends the Turn, typing nothing", async () => {
    const { harness, opened } = await mountFill(async (request) => {
      expect(await request.pageOrigin()).toBe("https://shop.example");
      return { status: "asked", content: "Approval requested." };
    });
    await execute(harness, "computer_browser", {
      action: "navigate",
      url: "https://shop.example/checkout",
    });

    const asked = await execute(harness, "computer_browser", {
      action: "fill",
      label: "Card number",
      secret: SECRET_ID,
    });

    expect(asked).toMatchObject({
      content: "Approval requested.",
      isError: false,
      endsTurn: true,
    });
    expect(opened).toHaveLength(0);
    await harness.dispose();
  });

  test("a refusal from the page never carries the value back", async () => {
    const { harness, released } = await mountFill(async () => ({
      status: "granted",
      // Not where the page is: the host refuses at the moment it would type.
      origin: "https://elsewhere.example",
      label: "Shop login",
    }));
    await execute(harness, "computer_browser", {
      action: "navigate",
      url: "https://shop.example/login",
    });

    const refused = await execute(harness, "computer_browser", {
      action: "fill",
      label: "Password",
      secret: SECRET_ID,
    });

    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("Not filled");
    expect(refused.content).not.toContain(VALUE);
    expect(released).toHaveLength(1);
    await harness.dispose();
  });

  test("text and a secret together, or a secret with no authority, are refused", async () => {
    const { harness } = await mountFill(async () => ({
      status: "refused",
      content: "No.",
    }));
    const both = await execute(harness, "computer_browser", {
      action: "fill",
      label: "Password",
      text: "typed",
      secret: SECRET_ID,
    });
    expect(both.isError).toBe(true);
    await harness.dispose();

    const bare = createAgentRuntimeHarness();
    bare.computers.register(createFakeComputerHostV1());
    await bare.mount(
      createComputerAgentFeature({
        userId: "user-1",
        defaultProviderId: "fake-computer-host",
      }),
    );
    const unwired = await execute(bare, "computer_browser", {
      action: "fill",
      label: "Password",
      secret: SECRET_ID,
    });
    expect(unwired.isError).toBe(true);
    expect(unwired.content).toContain("cannot be filled here");
    await bare.dispose();
  });
});

describe("what a browser page is showing", () => {
  test("a page the judge names is said plainly, above where it is and its snapshot", async () => {
    const judged: unknown[] = [];
    const provider: ComputerHostV1 = {
      id: "fixture",
      capabilities: TEST_HOST_CAPABILITIES,
      open: async (identity, tenant, assignment) => ({
        assignment,
        identity,
        tenant,
        capabilities: TEST_HOST_CAPABILITIES,
        exec: {
          execute: async () => ({
            exitCode: 0,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
            outputTruncated: false,
          }),
        },
        browser: {
          perform: async () => ({
            url: "https://accounts.example.com/login",
            title: "Sign in",
            accessibilitySnapshot: 'textbox "Email"\nbutton "Continue"',
          }),
        },
        close: () => Promise.resolve(),
      }),
    };
    const harness = createAgentRuntimeHarness();
    harness.computers.register(provider);
    await harness.mount(
      createComputerAgentFeature({
        userId: "user-1",
        defaultProviderId: "fixture",
        judgePage: async (page) => {
          judged.push(page);
          return "sign_in";
        },
      }),
    );
    const result = await execute(harness, "computer_browser", {
      action: "navigate",
      url: "https://example.com/inbox",
    });
    expect(judged).toEqual([
      {
        url: "https://accounts.example.com/login",
        title: "Sign in",
        snapshot: 'textbox "Email"\nbutton "Continue"',
      },
    ]);
    expect(result.isError).toBe(false);
    const lines = String(result.content).split("\n");
    expect(lines[0]).toBe("Page: Sign in — https://accounts.example.com/login");
    expect(lines[1]).toContain("sign-in wall");
    expect(lines.slice(2)).toEqual([
      "",
      'textbox "Email"',
      'button "Continue"',
    ]);
    await harness.dispose();
  });

  test("a page that is itself, or that nobody judged, is its address and snapshot", () => {
    expect(
      browserResultTextV1({
        url: "https://example.com",
        title: "Example",
        snapshot: 'heading "Example"',
        state: "ready",
      }),
    ).toBe('Page: Example — https://example.com\n\nheading "Example"');
    expect(browserResultTextV1({ snapshot: 'button "Go"' })).toBe(
      'button "Go"',
    );
    expect(browserResultTextV1({ snapshot: "", state: "captcha" })).toContain(
      "Do not try to solve or get around it",
    );
  });
});
