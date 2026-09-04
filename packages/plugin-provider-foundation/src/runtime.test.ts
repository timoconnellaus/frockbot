import { describe, expect, test } from "bun:test";
import {
  type LlmStreamEvent,
  type NormalizedModelRequest,
} from "@frockbot/kernel-contracts";
import { LlmRegistry } from "@frockbot/plugin-models";
import {
  createPluginHarness,
  verifyPluginPackage,
} from "@frockbot/plugin-testkit";
import manifest from "../frockbot.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };
import foundationProviderPlugin, {
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

describe("foundation provider plugin", () => {
  test("classifies its only pre-stream failure shape as unknown", () => {
    const failure = classifyFoundationFailureV1(new Error("local failure"));
    expect(failure.classification).toBe("unknown");
    expect(failure.providerReason).toBe("local failure");
  });
  test("registers deterministic provider behavior for its fiber lifetime", async () => {
    const harness = await createPluginHarness([LlmRegistry]);
    const fiber = await harness.mount(foundationProviderPlugin);

    expect(
      await collect(
        harness.root.llm.stream(request, new AbortController().signal),
      ),
    ).toEqual([
      { type: "text-delta", text: "Cordis runtime: " },
      { type: "text-delta", text: "hello" },
      { type: "finish", reason: "completed" },
    ]);

    await fiber.dispose();
    let failure: unknown;
    try {
      harness.root.llm.stream(request, new AbortController().signal);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    await harness.dispose();
  });

  test("satisfies plugin package conventions", () => {
    expect(verifyPluginPackage({ packageJson, manifest })).toMatchObject({
      name: "@frockbot/plugin-provider-foundation",
      contributionKinds: ["runtime"],
    });
  });
});
