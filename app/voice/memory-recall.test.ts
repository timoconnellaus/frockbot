import { describe, expect, test } from "bun:test";
import { buildGeminiLiveSetupV1 } from "./gemini-live.ts";
import { VOICE_FUNCTION_DECLARATIONS_V1 } from "./assistant.ts";
import {
  VOICE_AUTOMATIC_PREANSWER_RECALL_V1,
  VoiceMemoryPrefetchCacheV1,
  voiceMemoryRequiresReopenV1,
} from "./memory-recall.ts";
import { encodeGeminiToolResponseV1 } from "./gemini-live.ts";

describe("voice memory recall", () => {
  test("memory tools are blocking and other tools stay non-blocking", () => {
    const frame = buildGeminiLiveSetupV1({
      systemInstruction: "You are Sunny.",
      functionDeclarations: VOICE_FUNCTION_DECLARATIONS_V1,
    });
    const tools = frame.setup as {
      tools: Array<{
        functionDeclarations: Array<{ name: string; behavior?: string }>;
      }>;
    };
    const declarations = tools.tools[0]?.functionDeclarations ?? [];
    const search = declarations.find((item) => item.name === "memory_search");
    const subagent = declarations.find((item) => item.name === "subagent");
    expect(search?.behavior).toBeUndefined();
    expect(subagent?.behavior).toBe("NON_BLOCKING");
  });

  test("a function response uses the real call id", () => {
    const frame = encodeGeminiToolResponseV1([
      {
        id: "fn-9",
        name: "memory_search",
        response: { result: "The kiln is in Wollongong." },
      },
    ]);
    expect(JSON.stringify(frame)).toContain("fn-9");
    expect(JSON.stringify(frame)).not.toContain("NON_BLOCKING");
  });

  test("prefetch is consumed by the same attempt and discarded when it is replaced", async () => {
    const cache = new VoiceMemoryPrefetchCacheV1<string>();
    cache.start("attempt-1", "where is the kiln", async () => "studio");
    cache.replace("attempt-2");
    expect(cache.take("attempt-1", "where is the kiln")).toBeUndefined();
    cache.start("attempt-2", "where is the kiln", async () => "studio");
    const taken = cache.take("attempt-2", "where is the kiln");
    expect(await taken).toBe("studio");
    expect(cache.take("attempt-2", "where is the kiln")).toBeUndefined();
    cache.start("attempt-2", "other", async () => "nope");
    cache.cancel("attempt-2");
    expect(cache.take("attempt-2", "other")).toBeUndefined();
  });

  test("a changed core epoch requires a clean reopen", () => {
    expect(
      voiceMemoryRequiresReopenV1({
        injectedEpoch: "1",
        currentEpoch: "2",
        injectedMembership: "school",
        currentMembership: "school",
      }),
    ).toBe(true);
    expect(
      voiceMemoryRequiresReopenV1({
        injectedEpoch: "1",
        currentEpoch: "1",
        injectedMembership: "school",
        currentMembership: "school",
      }),
    ).toBe(false);
  });

  test("automatic pre-answer recall is an open limitation", () => {
    expect(VOICE_AUTOMATIC_PREANSWER_RECALL_V1).toBe("unsupported");
  });
});
