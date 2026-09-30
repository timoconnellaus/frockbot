import { describe, expect, test } from "bun:test";
import {
  chatOf,
  jobsOf,
  localModelEndpoint,
  localModelPort,
  macsOf,
  matchProviders,
  needsYouOf,
  providersOf,
  suggestPlan,
  usageRowsOf,
  type Billing,
  type CatalogRow,
  type Settings,
} from "./model.ts";

const row = (
  packageId: string,
  displayName: string,
  installed = false,
): CatalogRow => ({
  packageId,
  connectionTypeId: `${packageId}-account`,
  displayName,
  kind: "model",
  authorization: "api-key",
  connected: 0,
  mayConnect: installed,
  installed,
});

const catalog = [
  row("provider-mistral", "Mistral"),
  row("provider-anthropic", "Anthropic", true),
  row("provider-openai", "OpenAI", true),
  row("provider-cerebras", "Cerebras"),
];

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    revision: 3,
    profile: { name: "Member" },
    packages: [],
    platformModel: { connectionId: "flock", providerModelId: "@frock/auto" },
    connections: [
      {
        connectionId: "flock",
        packageId: "provider-flock-ai",
        connectionTypeId: "flock-ai",
        displayName: "Frock AI",
        state: "ready",
        modelCatalog: {
          state: "fresh",
          models: [{ providerModelId: "@frock/auto", displayName: "Auto" }],
        },
      },
      {
        connectionId: "openai-1",
        packageId: "provider-openai",
        connectionTypeId: "provider-openai-account",
        displayName: "OpenAI",
        state: "ready",
        authorization: { kind: "api-key" },
        modelCatalog: {
          state: "fresh",
          models: [{ providerModelId: "gpt-5.5", displayName: "GPT-5.5" }],
        },
      },
    ],
    ...overrides,
  };
}

describe("providers", () => {
  test("FrockBot's own first, then the popular ones in order, then the rest by name", () => {
    const names = providersOf(settings(), catalog).map(
      (p) => `${p.group}:${p.name}`,
    );
    expect(names).toEqual([
      "frockbot:Frock AI",
      "popular:OpenAI",
      "popular:Anthropic",
      "all:Cerebras",
      "all:Mistral",
    ]);
  });

  test("say whether they are connected", () => {
    const providers = providersOf(settings(), catalog);
    expect(providers.find((p) => p.name === "OpenAI")?.state).toBe("connected");
    expect(providers.find((p) => p.name === "Anthropic")?.state).toBe(
      "not-connected",
    );
  });

  test("are found by what a person types", () => {
    const found = matchProviders(providersOf(settings(), catalog), "mis");
    expect(found.map((p) => p.name)).toEqual(["Mistral"]);
  });
});

describe("chat", () => {
  test("is Frock AI until a model of the person's own is chosen", () => {
    const providers = providersOf(settings(), catalog);
    expect(chatOf(settings(), providers).mode).toBe("frock");
    const chosen = settings({
      accountModel: { connectionId: "openai-1", providerModelId: "gpt-5.5" },
    });
    const chat = chatOf(chosen, providersOf(chosen, catalog));
    expect(chat.mode).toBe("custom");
    expect(chat.model?.displayName).toBe("GPT-5.5");
    expect(chat.failure).toBeUndefined();
  });

  test("says when its provider refused the key, and the overview asks for the fix", () => {
    const base = settings();
    const broken = settings({
      accountModel: { connectionId: "openai-1", providerModelId: "gpt-5.5" },
      connections: base.connections.map((c) =>
        c.connectionId === "openai-1"
          ? { ...c, state: "failed" as const, failure: "The key was refused." }
          : c,
      ),
    });
    const providers = providersOf(broken, catalog);
    const chat = chatOf(broken, providers);
    expect(chat.failure).toBe("The key was refused.");
    const needs = needsYouOf(broken, providers, chat, undefined);
    expect(needs).toHaveLength(1);
    expect(needs[0]!.page).toBe("ai");
    const jobs = jobsOf(broken, providers, chat);
    expect(jobs.chat[0]!.failure).toBe("The key was refused.");
    expect(jobs.chat.find((job) => job.id === "writing")?.follows).toBe(true);
  });
});

const billing: Billing = {
  includedMicros: 10_000_000,
  purchasedMicros: 0,
  canSpend: true,
  subscribed: true,
  includedGrantedMicros: 20_000_000,
  plan: {
    subscriptions: [
      {
        id: "standard",
        name: "Standard",
        monthlyCents: 2000,
        includedMicros: 20_000_000,
      },
      {
        id: "plus",
        name: "Plus",
        monthlyCents: 5000,
        includedMicros: 60_000_000,
      },
    ],
    trial: null,
    topUpCents: [1000],
  },
  trial: null,
  subscription: { planId: "standard", status: "active", periodEnd: 0 },
  metered: true,
  paymentsAvailable: true,
  actions: [],
};

describe("plans", () => {
  test("suggest the one that covers what the account spends, and say why", () => {
    const providers = providersOf(settings(), catalog);
    const chat = chatOf(settings(), providers);
    expect(suggestPlan(chat, billing, 5_000_000).planId).toBe("standard");
    const heavy = suggestPlan(chat, billing, 30_000_000);
    expect(heavy.planId).toBe("plus");
    expect(heavy.why).toContain("US$30.00");
  });

  test("with no own computer, a Custom account still suits a plan with credit, and says when BYO would do", () => {
    const withByo: Billing = {
      ...billing,
      plan: {
        ...billing.plan,
        subscriptions: [
          {
            id: "byo",
            name: "BYO",
            monthlyCents: 500,
            includedMicros: 0,
            trial: false,
            jevFairUseMicros: 2_000_000,
          },
          ...billing.plan.subscriptions,
        ],
      },
    };
    const chosen = settings({
      accountModel: { connectionId: "openai-1", providerModelId: "gpt-5.5" },
    });
    const chat = chatOf(chosen, providersOf(chosen, catalog));
    const suggestion = suggestPlan(chat, withByo, 1_000_000);
    expect(suggestion.planId).toBe("standard");
    expect(suggestion.why).toContain("BYO would be enough");
  });

  test("list Jev as included and the person's own accounts as paid to them", () => {
    const providers = providersOf(settings(), catalog);
    const rows = usageRowsOf(
      {
        totalMicros: 1,
        groups: [
          {
            key: "computer",
            label: "Computer",
            chargeMicros: 8_800_000,
            operations: 1,
          },
        ],
      },
      settings(),
      providers,
    );
    expect(rows).toEqual([
      { label: "Computer", amount: "US$8.80" },
      { label: "Jev", amount: "Included" },
      { label: "Your own OpenAI", amount: "Paid to them" },
    ]);
  });

  test("an account that cannot spend needs its owner", () => {
    const providers = providersOf(settings(), catalog);
    const needs = needsYouOf(
      settings(),
      providers,
      chatOf(settings(), providers),
      { ...billing, canSpend: false },
    );
    expect(needs.map((item) => item.page)).toEqual(["plan"]);
  });
});

describe("local models", () => {
  test("offers only the account's live Macs, connected first", () => {
    expect(
      macsOf({
        machines: [
          {
            machineId: "m1",
            label: "Old",
            platform: "macos",
            connected: false,
          },
          { machineId: "m2", label: "Box", platform: "linux", connected: true },
          {
            machineId: "m3",
            label: "Gone",
            platform: "macos",
            connected: false,
            revokedAt: "2026-09-01T00:00:00.000Z",
          },
          { machineId: "m4", label: "Now", platform: "macos", connected: true },
        ],
      }),
    ).toEqual([
      { machineId: "m4", label: "Now", connected: true },
      { machineId: "m1", label: "Old", connected: false },
    ]);
    expect(macsOf(null)).toEqual([]);
  });

  test("an endpoint is always on the Mac's loopback", () => {
    expect(localModelEndpoint(11434)).toBe("http://localhost:11434/v1");
    expect(localModelPort(" 8080 ")).toBe(8080);
    expect(localModelPort("0")).toBeUndefined();
    expect(localModelPort("70000")).toBeUndefined();
    expect(localModelPort("localhost")).toBeUndefined();
  });
});
