import { describe, expect, test } from "bun:test";
import { webSearchEffectIdV1 } from "./contract.ts";

const CALL = {
  botId: "bot-1",
  sessionId: "user-1:bot-1",
  effectId: "tool:1:1:0",
};

describe("webSearchEffectIdV1", () => {
  test("is the same identity when the same call is re-dispatched", async () => {
    const id = await webSearchEffectIdV1(CALL);
    expect(id).toMatch(/^web-search-[0-9a-f]{32}$/);
    expect(await webSearchEffectIdV1(CALL)).toBe(id);
  });

  test("differs for the same effect in another Session or another Bot", async () => {
    // A charge is keyed across the whole account, and a tool
    // call's effect id restarts in every Session and repeats across Bots.
    const id = await webSearchEffectIdV1(CALL);
    expect(
      await webSearchEffectIdV1({ ...CALL, sessionId: "routine:daily" }),
    ).not.toBe(id);
    expect(await webSearchEffectIdV1({ ...CALL, botId: "bot-2" })).not.toBe(id);
  });
});
