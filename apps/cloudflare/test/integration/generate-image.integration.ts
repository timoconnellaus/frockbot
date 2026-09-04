// `generate_image` end to end, through the deployed door.
//
// `SELF.fetch` enters `src/index.ts`: gateway auth, the User Durable Object,
// the Worker Loader and the real artifact, then the Bot Durable Object, whose
// Agent loop runs the Turn. The stubbed model answers with a `generate_image`
// tool call; `env.AI` is an auxiliary Worker's RPC entrypoint (see
// `test/frock-ai-fake.ts`), so the production seam — `env.AI.run(model,
// input)` — is the one exercised.
//
// Three claims:
//  1. the durable `tool/result` names a Workspace path and carries no bytes;
//  2. the object is really in the durable-root store, and the Turn's
//     `image/generated` event names the generation it was written under;
//  3. replaying the same Turn command produces no second `run()` — "recovery
//     never silently duplicates ... tool calls", and this effect is billed.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generatedImageRootV1 } from "@frockbot/plugin-image/root";
import { workspaceObjectKeyV1 } from "@frockbot/workspace-store/keys";
import {
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  toolCallTriggerPrompt,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

interface StoredRun {
  events?: unknown[];
}

interface TurnView {
  runId: string;
  events: Array<{
    type: string;
    name?: string;
    content?: string;
    isError?: boolean;
  }>;
}

function botStub(userId: string, botId: string) {
  return env.BOT_STATES.get(env.BOT_STATES.idFromName(`${userId}:${botId}`));
}

async function runEvents(
  userId: string,
  botId: string,
  runId: string,
): Promise<Array<Record<string, unknown>>> {
  return runInDurableObject(botStub(userId, botId), async (_object, state) => {
    const stored = await state.storage.get<StoredRun>(`run:${runId}`);
    return Array.isArray(stored?.events)
      ? (stored.events as Array<Record<string, unknown>>)
      : [];
  });
}

/** What the fake `AI` binding has been asked to generate so far. */
async function modelCalls(): Promise<Array<{ model: string; prompt: string }>> {
  // SAFETY: the suite binds the same RPC entrypoint a second time under
  // `AI_PROBE` so the call log is reachable without widening production Env.
  const probe = (
    env as unknown as {
      AI_PROBE: {
        runCalls(): Promise<Array<{ model: string; prompt: string }>>;
      };
    }
  ).AI_PROBE;
  return await probe.runCalls();
}

describe("generating an image", () => {
  it("stores the image in the Workspace, names it in the durable result, and never generates twice for one command", async () => {
    const userId = freshUserId("generate-image");
    const botId = "generate-image-bot";
    await provisionThroughGateway({ userId, botId });

    const before = (await modelCalls()).length;
    const body = {
      schemaVersion: 1,
      commandId: "generate-image-1",
      text: toolCallTriggerPrompt([
        "generate_image",
        { prompt: "a red barn at dusk" },
      ]),
    };

    const turn = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/turns`, body),
    )) as TurnView;

    const result = turn.events.find((event) => event.type === "tool/result");
    expect(result, "the Turn made no generate_image call").toBeDefined();
    expect(result?.isError, result?.content).toBe(false);

    const parsed = JSON.parse(result?.content ?? "{}") as {
      path: string;
      root: string;
      generationId: string;
      contentHash: string;
      mimeType: string;
      width: number;
      height: number;
    };
    expect(parsed).toMatchObject({
      root: "package-declared:image/generated",
      mimeType: "image/png",
      width: 1,
      height: 1,
    });
    expect(parsed.path.startsWith(`${botId}/`)).toBe(true);
    // Bytes never enter the durable log: `tool/result.content` is replayed
    // into every later model request of the Turn.
    expect(result?.content ?? "").not.toContain("iVBOR");

    // The model was asked exactly once, for exactly this prompt.
    const afterFirst = await modelCalls();
    expect(afterFirst.length).toBe(before + 1);
    expect(afterFirst.at(-1)).toMatchObject({
      model: "@cf/black-forest-labs/flux-1-schnell",
      prompt: "a red barn at dusk",
    });

    // The file is really in the durable-root store, at the key the Workspace
    // layout puts it under.
    const key = workspaceObjectKeyV1(generatedImageRootV1(userId), parsed.path);
    const stored = await env.MEMORY_FILES.get(key);
    expect(stored, `no object at ${key}`).not.toBeNull();
    const bytes = new Uint8Array(await stored!.arrayBuffer());
    // A real PNG signature, so what was stored is the image and not a wrapper.
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

    // Intent before effect, and the generation the write produced, both in the
    // Bot's own durable log.
    const events = await runEvents(userId, botId, "generate-image-1");
    const types = events.map((event) => event.type);
    expect(types.indexOf("image/generate-intent")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("image/generate-intent")).toBeLessThan(
      types.indexOf("image/generated"),
    );
    expect(
      events.find((event) => event.type === "image/generated"),
    ).toMatchObject({
      path: parsed.path,
      generationId: parsed.generationId,
      contentHash: parsed.contentHash,
    });

    // The replay: the same command id, delivered again. Duplicate delivery
    // does not duplicate a billed effect.
    const replayed = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/turns`, body),
    )) as TurnView;
    const replayedResult = replayed.events.find(
      (event) => event.type === "tool/result",
    );
    expect(replayedResult?.content).toBe(result?.content);
    expect((await modelCalls()).length).toBe(before + 1);
  });
});
