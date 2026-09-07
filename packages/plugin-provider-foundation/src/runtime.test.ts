import { describe, expect, test } from "bun:test";
import {
  type LlmStreamEvent,
  type NormalizedModelRequest,
} from "@frockbot/kernel-contracts";
import { createAgentRuntimeHarness } from "@frockbot/plugin-testkit";
import foundationProviderFeature, {
  classifyFoundationFailureV1,
  FOUNDATION_MODEL,
  FOUNDATION_PROVIDER,
} from "./runtime.js";

const request: NormalizedModelRequest = {
  requestId: "request",
  provider: FOUNDATION_PROVIDER,
  model: FOUNDATION_MODEL,
  system: "",
  messages: [{ role: "user", content: "hello" }],
  tools: [],
};

async function collect(
  source: AsyncIterable<LlmStreamEvent>,
): Promise<LlmStreamEvent[]> {
  const events: LlmStreamEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

describe("foundation provider feature", () => {
  test("classifies its only pre-stream failure shape as unknown", () => {
    const failure = classifyFoundationFailureV1(new Error("local failure"));
    expect(failure.classification).toBe("unknown");
    expect(failure.providerReason).toBe("local failure");
  });
  test("registers deterministic provider behavior for its mounted lifetime", async () => {
    const runtime = createAgentRuntimeHarness();
    await runtime.mount(foundationProviderFeature);

    expect(
      await collect(runtime.llm.stream(request, new AbortController().signal)),
    ).toEqual([
      { type: "text-delta", text: "Built-in model: " },
      { type: "text-delta", text: "hello" },
      { type: "finish", reason: "completed" },
    ]);

    await runtime.dispose();
    let failure: unknown;
    try {
      runtime.llm.stream(request, new AbortController().signal);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
  });
});
