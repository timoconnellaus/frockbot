import { describe, expect, test } from "bun:test";
import type {
  BotCapabilitiesStub,
  TurnTypeV1,
  BotIsolateEntrypoint,
  IsolateToolInvocationV1,
  ToolDefinition,
  ToolExecutionContext,
} from "@frockbot/kernel-contracts";
import type { PackageDescriptor } from "./index.ts";
import {
  botIsolateAdmissionCeilingV1,
  BotIsolateContributionHost,
  botIsolateModuleSetHashV1,
  raceDeadline,
  type BotIsolateHostOptions,
  type BotIsolateLoadedWorker,
  type BotIsolateWorkerCode,
} from "./isolate-host.ts";
import { decodeFrockBotManifest } from "./manifest.ts";

const CONTENT_HASH = "a".repeat(64);

function manifest() {
  return decodeFrockBotManifest({
    schemaVersion: 3,
    id: "bot-authored",
    displayName: "Bot authored",
    version: "0.0.1",
    compatibility: { frockbot: "^0.0.1" },
    dependencies: {},
    contributions: { runtime: { entry: "./runtime.js" } },
    permissions: [],
  });
}

function descriptor(): PackageDescriptor {
  return {
    specifier: "@bot/authored",
    manifest: manifest(),
    artifact: {
      contentHash: CONTENT_HASH,
      size: 12,
      mediaType: "application/javascript",
      bundlerVersion: "0.2.3",
    },
  };
}

interface RecordedLoad {
  loaderId: string;
  code: BotIsolateWorkerCode;
}

function fakeIsolate(
  entrypoint: Partial<BotIsolateEntrypoint>,
  loads: RecordedLoad[],
) {
  return {
    get(
      loaderId: string,
      callback: () => Promise<BotIsolateWorkerCode>,
    ): BotIsolateLoadedWorker {
      void callback().then((code) => loads.push({ loaderId, code }));
      return {
        getEntrypoint: () =>
          ({
            health: () => Promise.reject(new Error("health was not stubbed")),
            execute: () => Promise.reject(new Error("execute was not stubbed")),
            ...entrypoint,
          }) as BotIsolateEntrypoint,
      };
    },
  };
}

function healthy(
  tools = [
    {
      name: "reverse_text",
      description: "Reverses text",
      inputSchema: { type: "object" },
      idempotent: true,
    },
  ],
) {
  return {
    schemaVersion: 1 as const,
    ok: true,
    packageId: "bot-authored",
    contractVersion: 1 as const,
    tools,
  };
}

const BINDING_DIGEST = "c".repeat(64);

function host(
  overrides: Partial<BotIsolateHostOptions> & {
    entrypoint?: Partial<BotIsolateEntrypoint>;
  } = {},
) {
  const loads: RecordedLoad[] = [];
  const registered: ToolDefinition[] = [];
  const ceilings: (readonly TurnTypeV1[] | undefined)[] = [];
  const { entrypoint, ...rest } = overrides;
  const options: BotIsolateHostOptions = {
    loader: fakeIsolate(
      entrypoint ?? { health: () => Promise.resolve(healthy()) },
      loads,
    ),
    artifacts: {
      loadPackageArtifact: () => Promise.resolve("export const tools = [];"),
    },
    tools: {
      register: (definition, registration) => {
        registered.push(definition);
        ceilings.push(registration?.admissionCeiling);
        return () => {
          const index = registered.indexOf(definition);
          if (index >= 0) registered.splice(index, 1);
        };
      },
    },
    userId: "user-1",
    botId: "bot-1",
    sessionId: "session-1",
    runId: "run-1",
    turnId: "turn-1",
    generationId: "gen-1",
    capabilities: {} as BotCapabilitiesStub,
    bindingDigest: BINDING_DIGEST,
    compatibilityDate: "2026-08-27",
    ...rest,
  };
  return {
    host: new BotIsolateContributionHost(options),
    loads,
    registered,
    ceilings,
  };
}

function executionContext(): ToolExecutionContext {
  return {
    botId: "bot-1",
    agentId: "bot-1",
    sessionId: "session-1",
    compositionGenerationId: "gen-1",
    turnType: "chat" as const,
    effectId: "tool:1:1:0",
    signal: new AbortController().signal,
  };
}

describe("Bot isolate contribution host", () => {
  test("refuses a member with no artifact", async () => {
    const { host: subject } = host();
    const { artifact: _artifact, ...firstParty } = descriptor();
    expect(await subject.prepare(firstParty)).toBeUndefined();
  });

  test("loads with egress disabled and exactly two modules", async () => {
    const { host: subject, loads } = host();
    await subject.prepare(descriptor());
    expect(loads).toHaveLength(1);
    const code = loads[0]!.code;
    expect(code.globalOutbound).toBeNull();
    expect(Object.keys(code.modules).sort()).toEqual([
      "index.js",
      "package.js",
    ]);
    expect(Object.keys(code.env).sort()).toEqual(["CAPABILITIES", "IDENTITY"]);
    expect(code.mainModule).toBe("index.js");
    expect(code.limits).toEqual({ cpuMs: 5_000, subRequests: 5 });
  });

  test("a caller that omits the binding digest does not compile", () => {
    // @ts-expect-error the binding digest is required: an isolate loaded with
    // no digest of its granted bindings would share a loader id across
    // enabled bindings and generations.
    void botIsolateModuleSetHashV1(CONTENT_HASH);
    expect(true).toBe(true);
  });

  test("a different binding digest is a different loader id", async () => {
    const { host: subject, loads } = host();
    await subject.prepare(descriptor());
    const other = host({ bindingDigest: "d".repeat(64) });
    await other.host.prepare(descriptor());
    expect(loads[0]!.loaderId).not.toBe(other.loads[0]!.loaderId);
  });

  test("reuses the loader id only for the same Bot, generation, and enabled set", async () => {
    const { host: subject, loads } = host();
    await subject.prepare(descriptor());
    const same = host();
    await same.host.prepare(descriptor());
    const expected = await botIsolateModuleSetHashV1(
      CONTENT_HASH,
      BINDING_DIGEST,
    );
    expect(loads[0]!.loaderId).toBe(`bot-package:user-1:${expected}`);
    expect(same.loads[0]!.loaderId).toBe(loads[0]!.loaderId);
  });

  test("changes the loader id with the Bot, generation, or enabled set", async () => {
    const first = host();
    const otherBot = host({ botId: "bot-2", bindingDigest: "d".repeat(64) });
    const otherGeneration = host({
      generationId: "gen-2",
      bindingDigest: "e".repeat(64),
    });
    const otherEnabledSet = host({ bindingDigest: "f".repeat(64) });

    await Promise.all([
      first.host.prepare(descriptor()),
      otherBot.host.prepare(descriptor()),
      otherGeneration.host.prepare(descriptor()),
      otherEnabledSet.host.prepare(descriptor()),
    ]);

    const loaderIds = [
      first.loads[0]!.loaderId,
      otherBot.loads[0]!.loaderId,
      otherGeneration.loads[0]!.loaderId,
      otherEnabledSet.loads[0]!.loaderId,
    ];
    expect(new Set(loaderIds).size).toBe(loaderIds.length);
  });

  test("never shares a loader id across Users", async () => {
    const first = host();
    const otherUser = host({ userId: "user-2" });

    await Promise.all([
      first.host.prepare(descriptor()),
      otherUser.host.prepare(descriptor()),
    ]);

    expect(first.loads[0]!.loaderId).toMatch(
      /^bot-package:user-1:[0-9a-f]{64}$/,
    );
    expect(otherUser.loads[0]!.loaderId).toMatch(
      /^bot-package:user-2:[0-9a-f]{64}$/,
    );
    expect(otherUser.loads[0]!.loaderId).not.toBe(first.loads[0]!.loaderId);
  });

  test("health failure is a prepare failure with a diagnostic", async () => {
    const { host: subject } = host({
      entrypoint: {
        health: () =>
          Promise.reject(
            new Error(
              "Failed to start Worker:\nUncaught SyntaxError: Unexpected end of input\n  at package.js:4",
            ),
          ),
      },
    });
    await expect(subject.prepare(descriptor())).rejects.toThrow(
      /failed to mount in its isolate.*package\.js:4/s,
    );
  });

  test("rejects an isolate claiming another package's identity", async () => {
    const { host: subject } = host({
      entrypoint: {
        health: () => Promise.resolve({ ...healthy(), packageId: "other" }),
      },
    });
    await expect(subject.prepare(descriptor())).rejects.toThrow(
      /different package id/,
    );
  });

  test("rejects an isolate that declares no tools", async () => {
    const { host: subject } = host({
      entrypoint: { health: () => Promise.resolve(healthy([])) },
    });
    await expect(subject.prepare(descriptor())).rejects.toThrow(/unhealthy/);
  });

  test("registers one tool per health entry and executes it over RPC", async () => {
    let seen: IsolateToolInvocationV1 | undefined;
    const { host: subject, registered } = host({
      entrypoint: {
        health: () => Promise.resolve(healthy()),
        execute: (invocation) => {
          seen = invocation;
          return Promise.resolve({
            schemaVersion: 1 as const,
            content: "ba",
            isError: false,
          });
        },
      },
    });
    const prepared = await subject.prepare(descriptor());
    const active = await prepared!.commit();
    expect(registered).toHaveLength(1);
    expect(registered[0]!.name).toBe("reverse_text");
    expect(registered[0]!.idempotent).toBe(true);

    const result = await registered[0]!.execute(
      { text: "ab" },
      executionContext(),
    );
    expect(result).toEqual({ content: "ba", isError: false });
    expect(seen?.deadlineMs).toBe(15_000);
    expect(seen?.generationId).toBe("gen-1");

    await active.dispose();
    expect(registered).toHaveLength(0);
  });

  test("an undecodable isolate result is a tool error, not a throw", async () => {
    const { host: subject, registered } = host({
      entrypoint: {
        health: () => Promise.resolve(healthy()),
        execute: () => Promise.resolve({ content: "ba" } as never),
      },
    });
    const prepared = await subject.prepare(descriptor());
    await prepared!.commit();
    expect(await registered[0]!.execute({}, executionContext())).toMatchObject({
      isError: true,
    });
  });

  test("an unavailable artifact names the package and the hash", async () => {
    const { host: subject } = host({
      artifacts: {
        loadPackageArtifact: () => Promise.reject(new Error("not found")),
      },
    });
    await expect(subject.prepare(descriptor())).rejects.toThrow(
      new RegExp(`"bot-authored" artifact "${CONTENT_HASH}" is unavailable`),
    );
  });
});

describe("the Durable Object side of the deadline", () => {
  test("resolves work inside the deadline", async () => {
    await expect(raceDeadline(() => Promise.resolve(1), 1_000)).resolves.toBe(
      1,
    );
  });

  test("rejects work that outlives the deadline", async () => {
    await expect(raceDeadline(() => new Promise(() => {}), 10)).rejects.toThrow(
      /exceeded its deadline of 10ms/,
    );
  });

  test("rejects immediately when the Turn is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      raceDeadline(() => new Promise(() => {}), 10_000, controller.signal),
    ).rejects.toThrow(/was cancelled/);
  });

  test("rejects when the Turn is cancelled mid-flight", async () => {
    const controller = new AbortController();
    const pending = raceDeadline(
      () => new Promise(() => {}),
      10_000,
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow(/was cancelled/);
  });

  test("refuses a deadline outside the contract bound", async () => {
    await expect(raceDeadline(() => Promise.resolve(1), 0)).rejects.toThrow(
      /out of range/,
    );
  });
});

describe("the manifest bounds the turn types an isolate's tools reach", () => {
  const bounded = (capabilities: unknown[]) =>
    decodeFrockBotManifest({
      schemaVersion: 4,
      id: "bot-authored",
      displayName: "Bot authored",
      version: "0.0.1",
      compatibility: { frockbot: "^0.0.1" },
      dependencies: {},
      contributions: { runtime: { entry: "./runtime.js" } },
      permissions: [],
      configuration: { capabilities },
    });

  test("reads the ceiling from the Capabilities that contribute tools", () => {
    expect(botIsolateAdmissionCeilingV1(manifest())).toBeUndefined();
    expect(
      botIsolateAdmissionCeilingV1(
        bounded([
          {
            id: "automation-only",
            kind: "tool",
            connectionTypes: [],
            admission: { turnTypes: ["automation"] },
          },
        ]),
      ),
    ).toEqual(["automation"]);
    // A model Capability says nothing about which turns a tool reaches.
    expect(
      botIsolateAdmissionCeilingV1(
        bounded([{ id: "models", kind: "model", connectionTypes: [] }]),
      ),
    ).toBeUndefined();
    // One unbounded tool Capability leaves the Package's tools unbounded.
    expect(
      botIsolateAdmissionCeilingV1(
        bounded([
          {
            id: "automation-only",
            kind: "tool",
            connectionTypes: [],
            admission: { turnTypes: ["automation"] },
          },
          { id: "work", kind: "tool", connectionTypes: [] },
        ]),
      ),
    ).toBeUndefined();
  });

  test("passes the ceiling to the registry at registration", async () => {
    const { host: subject, ceilings } = host({
      entrypoint: { health: () => Promise.resolve(healthy()) },
    });

    const prepared = await subject.prepare({
      ...descriptor(),
      manifest: bounded([
        {
          id: "automation-only",
          kind: "tool",
          connectionTypes: [],
          admission: { turnTypes: ["automation"] },
        },
      ]),
    });
    await prepared!.commit();

    expect(ceilings).toEqual([["automation"]]);
  });

  test("registers with no ceiling when the manifest declares none", async () => {
    const { host: subject, ceilings } = host({
      entrypoint: { health: () => Promise.resolve(healthy()) },
    });

    const prepared = await subject.prepare(descriptor());
    await prepared!.commit();

    expect(ceilings).toEqual([undefined]);
  });
});
