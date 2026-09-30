import { describe, expect, test } from "bun:test";
import {
  defaultSetupChoicesV1,
  presetChoicesV1,
  setupFragmentV1,
  type SetupChoicesV1,
} from "@frockbot/core/setup-choices";
import { catalogProvidersV1 } from "@frockbot/providers/catalog/registry";
import { setupOptionsV1 } from "./options.js";
import { reviewSetupV1 } from "./review.js";
import { setupCarryOverRoutesV1 } from "./backend.js";
import { setupScriptV1 } from "./page.js";

const options = setupOptionsV1();
const none = { connectedProviders: new Set<string>(), plan: undefined };
const preset = (id: string) =>
  presetChoicesV1(
    options,
    options.presets.find((entry) => entry.id === id)!,
  );
const serialized = (choices: SetupChoicesV1) => ({
  v: 1,
  ...choices,
});
const chatOn = (provider: string, model: string): SetupChoicesV1 => {
  const base = defaultSetupChoicesV1(options);
  return {
    ...base,
    ai: "custom",
    jobs: { ...base.jobs, chat: { provider, model } },
  };
};

describe("reviewing a setup chosen on frockbot.com", () => {
  test("FrockBot's own setup is ready, on Standard", () => {
    const review = reviewSetupV1(
      serialized(defaultSetupChoicesV1(options)),
      none,
    );
    expect(review.rows.every((row) => row.need === "ready")).toBe(true);
    expect(review.plan).toEqual({
      suggested: "standard",
      checkout: "standard",
      label: "Standard, 7-day trial",
    });
    expect(review.defaultModel).toBeUndefined();
  });

  test("each part says what it still needs", () => {
    const review = reviewSetupV1(serialized(preset("bring-my-keys")), none);
    const need = Object.fromEntries(
      review.rows.map((row) => [row.name, row.need]),
    );
    expect(need).toMatchObject({
      Computer: "ready",
      "Chat and jobs": "key",
      Coding: "coming-soon",
      Jev: "ready",
      "Voice calls": "coming-soon",
      Dictation: "coming-soon",
      Images: "coming-soon",
      "Web search": "ready",
      "Connected apps": "ready",
    });
    const coding = review.rows.find((row) => row.name === "Coding")!;
    expect(coding.note).toBe("Coming soon. Frock AI handles it for now.");
    // A sign-in provider asks for a sign-in, not a key.
    const openrouter = reviewSetupV1(
      serialized(
        chatOn(
          "openrouter",
          options.providers.chat.find((p) => p.id === "openrouter")!
            .models![0]![0],
        ),
      ),
      none,
    );
    expect(openrouter.rows.find((row) => row.key === "job:chat")).toMatchObject(
      {
        need: "sign-in",
        provider: "openrouter",
      },
    );
  });

  test("a connected provider is ready and becomes the account's default model", () => {
    const choices = chatOn("openai", "gpt-5.5");
    const before = reviewSetupV1(serialized(choices), none);
    expect(before.defaultModel).toBeUndefined();
    const after = reviewSetupV1(serialized(choices), {
      connectedProviders: new Set(["openai"]),
      plan: "standard",
    });
    expect(after.rows.find((row) => row.key === "job:chat")!.need).toBe(
      "ready",
    );
    expect(after.defaultModel).toEqual({
      provider: "openai",
      model: "gpt-5.5",
    });
    expect(after.plan.checkout).toBeUndefined();
  });

  test("checkout starts on the suggested plan unless the account's plan covers it", () => {
    const allMine = serialized(preset("all-mine"));
    expect(reviewSetupV1(allMine, none).plan.checkout).toBe("byo");
    expect(
      reviewSetupV1(allMine, { ...none, plan: "plus" }).plan.checkout,
    ).toBeUndefined();
    expect(
      reviewSetupV1(serialized(defaultSetupChoicesV1(options)), {
        ...none,
        plan: "byo",
      }).plan.checkout,
    ).toBe("standard");
  });

  test("a provider that needs more than a key is finished in the app", () => {
    const needing = catalogProvidersV1.find(
      (p) => p.connectionSettings.length,
    )!;
    const model = options.providers.chat.find((p) => p.id === needing.id)!
      .models![0]![0];
    const review = reviewSetupV1(serialized(chatOn(needing.id, model)), none);
    expect(review.rows.find((row) => row.key === "job:chat")).toMatchObject({
      need: "key",
      finishInApp: true,
    });
  });

  test("a retired choice falls back and the review says so", () => {
    const review = reviewSetupV1(
      { v: 1, computer: "retired", ai: "frock" },
      none,
    );
    expect(review.rows.find((row) => row.key === "computer")!.choice).toBe(
      "FrockBot’s computer",
    );
    expect(review.notes).toHaveLength(1);
  });
});

describe("the /setup routes", () => {
  const routes = setupCarryOverRoutesV1({ productName: "FrockBot" });
  const url = (path: string) => new URL(`https://bot.frockbot.com${path}`);

  test("the page, its script and its styles are public and locked down", async () => {
    for (const path of ["/setup", "/setup.js", "/setup.css"]) {
      const response = await routes.publicRoute(
        new Request(url(path)),
        url(path),
      );
      expect(response?.status).toBe(200);
      expect(response?.headers.get("content-security-policy")).toContain(
        "script-src 'self'",
      );
    }
    const page = await (await routes.publicRoute(
      new Request(url("/setup")),
      url("/setup"),
    ))!.text();
    expect(page).toContain("Set up FrockBot the way you chose");
    expect(page).toContain("Apply this setup");
    expect(page).toContain("Start on Frock AI instead");
    expect(page).not.toMatch(/<script>|\sstyle=/);
  });

  test("the script keeps the fragment before anything can redirect", () => {
    const capture = setupScriptV1.indexOf("store.set(setup)");
    for (const leaves of ["location.assign", "/api/auth/sign-in/social"])
      expect(capture).toBeLessThan(setupScriptV1.indexOf(leaves));
    expect(setupScriptV1).toContain("history.replaceState");
    // Nothing is applied until the person asks.
    expect(setupScriptV1.indexOf("user/set-account-model")).toBeGreaterThan(
      setupScriptV1.indexOf("el('apply').onclick"),
    );
  });

  test("the review needs a signed-in User and reads the carried setup", async () => {
    const choices = chatOn("openai", "gpt-5.5");
    const body = JSON.stringify({
      setup: setupFragmentV1(choices).slice("setup=".length),
      connectedProviders: ["openai"],
      plan: "standard",
    });
    const post = () =>
      new Request(url("/api/setup/review"), { method: "POST", body });
    expect(await routes.route(post(), url("/api/setup/review"), {})).toBe(
      undefined,
    );
    const response = await routes.route(post(), url("/api/setup/review"), {
      userId: "user-1",
    });
    expect(response?.status).toBe(200);
    expect(
      ((await response!.json()) as { defaultModel: unknown }).defaultModel,
    ).toEqual({
      provider: "openai",
      model: "gpt-5.5",
    });
    const bad = await routes.route(
      new Request(url("/api/setup/review"), {
        method: "POST",
        body: JSON.stringify({ setup: 1, connectedProviders: [] }),
      }),
      url("/api/setup/review"),
      { userId: "user-1" },
    );
    expect(bad?.status).toBe(400);
  });
});
