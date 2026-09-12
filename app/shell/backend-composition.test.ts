// An Applet member contributes no module and nothing to health-check, so the
// only thing this seam does with it is register its tools. What matters is
// *which* generation those tools reach: the description handed to the model
// names the pinned generation, and the call names it too, so the Applet
// Durable Object executes that generation or refuses. A DTO that carried only
// the Applet id let a publish landing mid-Turn run new code behind the schema
// and provenance the model was shown.
import { describe, expect, test } from "bun:test";
import {
  decodePluginDescriptorV1,
  ISOLATE_CONTRACT_VERSION,
  type BotCapabilitiesStub,
  type PluginWorkerEntrypoint,
} from "@frockbot/core/contracts";
import {
  compositionArtifactSetHashV1,
  decodeCompositionGenerationV1,
  type CompositionAppletMemberV1,
  type CompositionGenerationV1,
  type CompositionMemberV1,
} from "@frockbot/core/durable";
import type { BotIsolateLoader } from "@frockbot/frock-compose";
import { createShellCompositionHost } from "./backend-composition.js";

const USER = "user-1";
const APPLET = "applet-1";

const APPLET_MEMBER: CompositionAppletMemberV1 = {
  kind: "applet",
  appletId: APPLET,
  generationId: "2026-09-05T00:00:00.000Z:A",
  tools: [
    {
      name: "add_todo",
      description: "Add a todo",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
      },
    },
  ],
  provenance: {
    kind: "user",
    packageId: APPLET,
    version: "2026-09-05T00:00:00.000Z:A",
    userId: USER,
    authoredAt: "2026-09-05T00:00:00.000Z",
  },
};

async function generationWithApplet(): Promise<CompositionGenerationV1> {
  const members: CompositionMemberV1[] = [];
  const applets = [APPLET_MEMBER];
  const artifactSetHash = await compositionArtifactSetHashV1(members, applets);
  return decodeCompositionGenerationV1({
    schemaVersion: 1,
    generationId: `2026-09-05T00:00:00.000Z:${artifactSetHash.slice(0, 16)}`,
    artifactSetHash,
    createdAt: "2026-09-05T00:00:00.000Z",
    origin: { kind: "bootstrap" },
    members,
    applets,
    status: "active",
  });
}

describe("Applet tools mounted into a Turn's Composition", () => {
  test("the call carries the generation the Turn pinned, not just the Applet id", async () => {
    const calls: Array<{ appletId: string; generationId: string }> = [];
    const generation = await generationWithApplet();
    const { signal } = new AbortController();
    const mounted = await createShellCompositionHost({
      botId: "bot-1",
      sessionId: `${USER}:bot-1`,
      sessionEvents: [],
      admitEffect: () => Promise.resolve(true),
      applets: {
        invokeTool: (request) => {
          calls.push({
            appletId: request.appletId,
            generationId: request.generationId,
          });
          return Promise.resolve({ status: "ok" as const, content: "added" });
        },
      },
    }).mount(generation, signal);
    try {
      await mounted.verify(signal);
      const schema = mounted.runtime.services.tools
        .schemas({ turnType: "chat" })
        .find((entry) => entry.name === "add_todo");
      expect(schema).toBeDefined();
      // The pin the model is shown, and the pin the call carries, are one
      // string. If they ever diverge the Turn stops being reconstructable.
      expect(schema?.description).toContain(APPLET_MEMBER.generationId);

      const call = { id: "call-1", name: "add_todo", input: { title: "milk" } };
      const context = {
        botId: "bot-1",
        agentId: "bot-1",
        sessionId: `${USER}:bot-1`,
        compositionGenerationId: generation.generationId,
        effectId: "effect-1",
        toolCall: call,
        turnType: "chat" as const,
        signal,
      };
      const prepared = await mounted.runtime.services.tools.prepare(
        call,
        context,
      );
      expect(prepared.kind).toBe("ready");
      const outcome = await mounted.runtime.services.tools.executePrepared(
        prepared as Extract<typeof prepared, { kind: "ready" }>,
        context,
      );
      expect(outcome).toMatchObject({ isError: false });
      expect(calls).toEqual([
        { appletId: APPLET, generationId: APPLET_MEMBER.generationId },
      ]);
    } finally {
      await mounted.dispose();
    }
  });
});


function pluginMember(id: string, contentHash: string): CompositionMemberV1 {
  return {
    packageId: id,
    version: "0.0.1",
    provenance: {
      kind: "user",
      packageId: id,
      version: "0.0.1",
      userId: USER,
      authoredAt: "2026-09-05T00:00:00.000Z",
    },
    artifact: {
      contentHash,
      size: 32,
      mediaType: "application/javascript",
      bundlerVersion: "1",
    },
    descriptor: decodePluginDescriptorV1({
      id,
      displayName: id,
      version: "0.0.1",
      contractVersion: ISOLATE_CONTRACT_VERSION,
      tools: [
        {
          name: `${id}_tool`,
          description: `${id} tool`,
          inputSchema: { type: "object" },
        },
      ],
      hooks: [],
      grants: [],
      contextKeys: ["user", "bot", "session"],
    }),
  };
}

async function generationWithPlugins(): Promise<CompositionGenerationV1> {
  const members = [
    pluginMember("good", "a".repeat(64)),
    pluginMember("bad", "b".repeat(64)),
  ];
  const artifactSetHash = await compositionArtifactSetHashV1(members, []);
  return decodeCompositionGenerationV1({
    schemaVersion: 1,
    generationId: `2026-09-05T00:00:00.000Z:${artifactSetHash.slice(0, 16)}`,
    artifactSetHash,
    createdAt: "2026-09-05T00:00:00.000Z",
    origin: { kind: "bootstrap" },
    members,
    status: "active",
  });
}

describe("a Plugin that the worker refuses", () => {
  // ADR 0026: a Plugin whose report differs from its descriptor fails alone.
  // Escalating that to the generation would quarantine nine healthy Plugins
  // because a tenth mis-declared one tool.
  test("fails alone: the generation still verifies and its siblings still mount", async () => {
    const generation = await generationWithPlugins();
    const { signal } = new AbortController();
    const entrypoint: PluginWorkerEntrypoint = {
      health: () =>
        Promise.resolve({
          schemaVersion: 1,
          contractVersion: ISOLATE_CONTRACT_VERSION,
          plugins: [
            {
              pluginId: "good",
              ok: true,
              tools: [
                {
                  name: "good_tool",
                  description: "good tool",
                  inputSchema: { type: "object" },
                  idempotent: true,
                },
              ],
              hooks: [],
              provides: [],
              consumes: [],
              triggers: [],
            },
            {
              pluginId: "bad",
              ok: false,
              reason: 'plugin "bad" must export an "execute" function',
              tools: [],
              hooks: [],
              provides: [],
              consumes: [],
              triggers: [],
            },
          ],
        }),
      hook: () =>
        Promise.resolve({ schemaVersion: 1, status: "unchanged", failures: [] }),
      execute: () =>
        Promise.resolve({ schemaVersion: 1, content: "ok", isError: false }),
      receiveTrigger: () =>
        Promise.resolve({ schemaVersion: 1, status: "drop" as const }),
    };
    const loader: BotIsolateLoader = {
      get: () => ({ getEntrypoint: () => entrypoint }),
    };
    const mounted = await createShellCompositionHost({
      botId: "bot-1",
      sessionId: `${USER}:bot-1`,
      sessionEvents: [],
      admitEffect: () => Promise.resolve(true),
      isolate: {
        userId: USER,
        runId: "run-1",
        turnId: "run-1",
        loader,
        artifacts: {
          loadPackageArtifact: () => Promise.resolve("export const tools = [];"),
        },
        capabilities: {} as BotCapabilitiesStub,
        bindingDigest: "c".repeat(64),
        compatibilityDate: "2026-01-01",
      },
    }).mount(generation, signal);
    try {
      await mounted.verify(signal);
      expect(
        mounted.pluginFailures.map((failure) => [
          failure.pluginId,
          failure.phase,
        ]),
      ).toEqual([["bad", "health"]]);
      const names = mounted.runtime.services.tools.registeredNames?.() ?? [];
      expect(names).toContain("good/good_tool");
      expect(names).not.toContain("bad/bad_tool");
    } finally {
      await mounted.dispose();
    }
  });
});
