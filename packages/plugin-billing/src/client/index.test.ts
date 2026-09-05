import { describe, expect, test } from "bun:test";
import type {
  ClientPluginContext,
  ClientSlotRegistration,
} from "@frockbot/client-core";
import { billingClientPlugin } from "./index.js";
import { formatCostV1, shortModelNameV1 } from "./format.js";
import { usageStateKey, type UsageClientStateV1 } from "./state.js";

const REPORT = {
  schemaVersion: 1,
  month: "2026-09",
  currentMonthCostMicros: 1_250_000,
  lifetimeCostMicros: 2_000_000,
  currentMonthInputTokens: 100,
  currentMonthOutputTokens: 20,
  currentMonthVoiceSeconds: 30,
  estimatedCalls: 1,
  unknownPriceCalls: 0,
  bots: [
    {
      id: "bot-a",
      costMicros: 1_250_000,
      inputTokens: 100,
      outputTokens: 20,
      voiceSeconds: 0,
      estimatedCalls: 1,
      unknownPriceCalls: 0,
    },
  ],
  models: [],
  days: Array.from({ length: 30 }, (_, offset) => ({
    day: `2026-09-${String(offset + 1).padStart(2, "0")}`,
    costMicros: offset,
  })),
};

function mount(): {
  state: { value: UsageClientStateV1 };
  slots: ClientSlotRegistration[];
  calls: string[];
} {
  const slots: ClientSlotRegistration[] = [];
  const calls: string[] = [];
  let state: unknown;
  const context: ClientPluginContext = {
    transport: {
      turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
      hostedRequest: (path) => {
        calls.push(path);
        return Promise.resolve(REPORT);
      },
    },
    inject: () => {
      throw new Error("unexpected client provider");
    },
    provide: (key, value) => {
      if (key === usageStateKey) state = value;
      return () => {};
    },
    slot: (registration) => {
      slots.push(registration);
      return () => slots.splice(slots.indexOf(registration), 1);
    },
  };
  billingClientPlugin(context);
  return { state: state as { value: UsageClientStateV1 }, slots, calls };
}

describe("billing client contribution", () => {
  test("mounts the account report and per-Bot line in Settings", () => {
    expect(mount().slots.map((slot) => slot.slot)).toEqual([
      "frockbot.user-settings-primary-sections",
      "frockbot.bot-settings-primary-sections",
    ]);
  });

  test("loads and decodes the Usage report", async () => {
    const mounted = mount();
    await mounted.state.value.load();
    expect(mounted.calls).toEqual(["/api/usage"]);
    expect(mounted.state.value.report?.currentMonthCostMicros).toBe(1_250_000);
    expect(mounted.state.value.report?.bots[0]?.id).toBe("bot-a");
  });

  test("says a real sub-cent amount rather than rounding it to nothing", () => {
    // Two short platform-model Turns: real spend, well under a cent.
    expect(formatCostV1(21_226)).toBe("$0.02");
    expect(formatCostV1(10_613)).toBe("$0.01");
    expect(formatCostV1(300)).toBe("<$0.01");
    expect(formatCostV1(9_999)).toBe("<$0.01");
    // Nothing spent is a different fact from a little spent.
    expect(formatCostV1(0)).toBe("$0.00");
    expect(formatCostV1(10_000)).toBe("$0.01");
  });

  test("formats dollars and compact model names for the rendered view", () => {
    expect(formatCostV1(1_250_000)).toBe("$1.25");
    expect(shortModelNameV1("ollama-cloud/glm-5.3-flash:cloud")).toBe(
      "glm-5.3-flash:cloud",
    );
  });
});
