import { describe, expect, test } from "bun:test";
import {
  emptyMemoryTurnRecallV1,
  noteMemoryRecallV1,
  planMemoryRecallV1,
  renderCanonicalMemoryInjectionV1,
  renderMemoryRequestMessagesV1,
} from "./context.ts";
import type { LlmMessage } from "@frockbot/core/contracts";

describe("chat memory context", () => {
  test("prepared core is clipped on section boundaries", () => {
    const block = "x".repeat(400);
    const injection = renderCanonicalMemoryInjectionV1({
      blocks: Array.from({ length: 8 }, (_, index) => ({
        scope: { kind: "bot", userId: "u", botId: "b" },
        text: block,
        manifest: [{ itemId: `i${index}`, generation: 1 }],
        generation: 1,
        policyVersion: 1,
      })),
      omissions: [],
      learnedAt: "2026-09-22",
    });
    expect(injection.facts.length).toBeLessThan(8);
    expect(injection.omissions.some((entry) => entry.reason.includes("1024"))).toBe(
      true,
    );
    expect(injection.text.startsWith("<memory>")).toBe(true);
  });

  test("recall blocks sit beside the latest user message and do not accumulate", () => {
    const state = emptyMemoryTurnRecallV1();
    const plan = planMemoryRecallV1({
      userText: "Where is the kiln?",
      toolTexts: [],
      state,
      step: 1,
    });
    expect(plan?.query).toContain("kiln");
    noteMemoryRecallV1(state, plan!.signature, [
      {
        scopeKey: "bot:u:b",
        itemId: "k",
        generation: 1,
        text: "The kiln is in Wollongong.",
      },
    ]);
    noteMemoryRecallV1(state, plan!.signature, [
      {
        scopeKey: "bot:u:b",
        itemId: "k",
        generation: 1,
        text: "The kiln is in Wollongong.",
      },
    ]);
    expect(state.blocks).toHaveLength(1);
    const messages: LlmMessage[] = [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "ok", toolCalls: [] },
      { role: "user", content: "Where is the kiln?" },
    ];
    const rendered = renderMemoryRequestMessagesV1(messages, {
      blocks: state.blocks,
      status: "complete",
      coreTokens: 10,
      active: () => true,
    });
    const recall = rendered.filter(
      (message) =>
        message.role === "user" && message.content.startsWith("<memory-recall"),
    );
    expect(recall).toHaveLength(1);
    expect(rendered.at(-1)).toEqual({
      role: "user",
      content: "Where is the kiln?",
    });
    const again = renderMemoryRequestMessagesV1(rendered, {
      blocks: state.blocks,
      status: "complete",
      coreTokens: 10,
      active: () => true,
    });
    expect(
      again.filter(
        (message) =>
          message.role === "user" &&
          message.content.startsWith("<memory-recall"),
      ),
    ).toHaveLength(1);
  });

  test("a withdrawn memory tool result stays paired and says unavailable", () => {
    const messages: LlmMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "memory_search", input: {} }],
      },
      {
        role: "tool",
        callId: "call-1",
        name: "memory_search",
        content: "memory-item bot:u:b item-1 2\nThe kiln is in Wollongong.",
        isError: false,
      },
    ];
    const rendered = renderMemoryRequestMessagesV1(messages, {
      blocks: [],
      status: "complete",
      coreTokens: 0,
      active: () => false,
    });
    const tool = rendered.find((message) => message.role === "tool");
    expect(tool).toMatchObject({
      role: "tool",
      callId: "call-1",
      name: "memory_search",
      content: "That memory is unavailable.",
      isError: true,
    });
  });

  test("recall blocks stop at the active token budget", () => {
    const first = "y".repeat(1_000);
    const second = "z".repeat(1_200);
    const rendered = renderMemoryRequestMessagesV1(
      [{ role: "user", content: "question" }],
      {
        blocks: [
          { scopeKey: "s", itemId: "1", generation: 1, text: first },
          { scopeKey: "s", itemId: "2", generation: 1, text: second },
        ],
        status: "partial",
        coreTokens: 0,
        active: () => true,
      },
    );
    const recall = rendered.find(
      (message) =>
        message.role === "user" && message.content.startsWith("<memory-recall"),
    );
    expect(recall?.content).not.toContain("small");
  });
});
