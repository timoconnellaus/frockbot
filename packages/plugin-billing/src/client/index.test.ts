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

const BILLING = {
  schemaVersion: 1,
  plan: "basic",
  subscriptionStatus: "active",
  currentPeriodStart: "2026-09-01T00:00:00.000Z",
  currentPeriodEnd: "2026-10-01T00:00:00.000Z",
  allowanceMicros: 20_000_000,
  allowanceUsedMicros: 1_250_000,
  allowanceRemainingMicros: 18_750_000,
  creditBalanceMicros: 25_000_000,
  availableMicros: 43_750_000,
  canStartTurn: true,
  history: [
    {
      eventId: "evt_credit",
      type: "checkout.session.completed",
      occurredAt: "2026-09-04T12:00:00.000Z",
      amountMicros: 25_000_000,
      description: "$25 credit purchase",
    },
  ],
} as const;

function mount(): {
  state: { value: UsageClientStateV1 };
  slots: ClientSlotRegistration[];
  calls: string[];
  opened: string[];
} {
  const slots: ClientSlotRegistration[] = [];
  const calls: string[] = [];
  const opened: string[] = [];
  let state: unknown;
  const context: ClientPluginContext = {
    transport: {
      turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
      hostedRequest: (path, method, body) => {
        calls.push(path);
        if (path === "/api/usage") return Promise.resolve(REPORT);
        if (path === "/api/billing") return Promise.resolve(BILLING);
        if (method === "POST" && body) {
          return Promise.resolve({
            schemaVersion: 1,
            url: "https://checkout.stripe.test/session",
          });
        }
        return Promise.reject(new Error("unexpected request"));
      },
      openExternalAuthorization: (url) => {
        opened.push(url);
        return Promise.resolve();
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
  return {
    state: state as { value: UsageClientStateV1 },
    slots,
    calls,
    opened,
  };
}

describe("billing client contribution", () => {
  test("mounts the account report and per-Bot line in Settings", () => {
    expect(mount().slots.map((slot) => slot.slot)).toEqual([
      "frockbot.user-settings-primary-sections",
      "frockbot.user-settings-primary-sections",
      "frockbot.bot-settings-primary-sections",
      "frockbot.composer-notices",
    ]);
  });

  test("loads and decodes the Usage report", async () => {
    const mounted = mount();
    await mounted.state.value.load();
    expect(mounted.calls).toEqual(["/api/usage", "/api/billing"]);
    expect(mounted.state.value.report?.currentMonthCostMicros).toBe(1_250_000);
    expect(mounted.state.value.report?.bots[0]?.id).toBe("bot-a");
    expect(mounted.state.value.billing?.creditBalanceMicros).toBe(25_000_000);
  });

  test("opens hosted Checkout from the Billing view", async () => {
    const mounted = mount();
    await mounted.state.value.buyCredits(2_500);

    expect(mounted.calls).toEqual(["/api/billing/checkout"]);
    expect(mounted.opened).toEqual(["https://checkout.stripe.test/session"]);
  });

  test("formats dollars and compact model names for the rendered view", () => {
    expect(formatCostV1(1_250_000)).toBe("$1.25");
    expect(shortModelNameV1("ollama-cloud/glm-5.3-flash:cloud")).toBe(
      "glm-5.3-flash:cloud",
    );
  });
});
