// The Applet half of the Composition a Turn mounts.
//
// An Applet member contributes no module and nothing to health-check, so the
// only thing this seam does with it is register its tools. What matters is
// *which* generation those tools reach: the description handed to the model
// names the pinned generation, and ADR 0038 requires the call to name it too,
// so the Applet Durable Object executes that generation or refuses. A DTO that
// carried only the Applet id let a publish landing mid-Turn run new code behind
// the schema and provenance the model was shown.
import { describe, expect, test } from "bun:test";
import {
  compositionArtifactSetHashV1,
  decodeCompositionGenerationV1,
  type CompositionAppletMemberV1,
  type CompositionGenerationV1,
} from "@frockbot/kernel-composition/generation";
import { createShellCompositionHost } from "./backend-composition.js";

const USER = "user-42";
const APPLET = `${USER}.${"a".repeat(32)}`;

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
  const members = [
    {
      packageId: "shell",
      specifier: "@frockbot/plugin-shell",
      version: "1.0.0",
      manifestHash: "c".repeat(64),
      provenance: {
        kind: "first-party" as const,
        packageId: "shell",
        version: "1.0.0",
      },
    },
  ];
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
      const schema = mounted.root.tools
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
      const prepared = await mounted.root.tools.prepare(call, context);
      expect(prepared.kind).toBe("ready");
      const outcome = await mounted.root.tools.executePrepared(
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
