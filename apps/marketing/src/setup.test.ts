import { describe, expect, test } from "bun:test";
import { catalogProvidersV1 } from "../../../providers/catalog/registry";
import { COMPUTER_TARIFF } from "../../../app/billing/computer";
import {
  buildSetupOptions,
  renderChoicesModule,
  renderDefaultSetup,
  renderOptionsModule,
  renderAppOptionsModule,
  replaceSetupRegion,
} from "../scripts/render-setup";
import {
  SETUP_STORAGE_KEY_V1,
  defaultSetupChoicesV1,
  normalizeSetupChoicesV1,
  presetChoicesV1,
  readSavedSetupV1,
  readSetupFragmentV1,
  resolveSetupJobsV1,
  saveSetupV1,
  setupFragmentV1,
  setupProvidersV1,
  suggestSetupPlanV1,
  type SetupChoicesV1,
  type SetupOptionsV1,
} from "../../../core/setup-choices/index";

const publicFile = (path: string) =>
  Bun.file(new URL(`../public/${path}`, import.meta.url));
const options: SetupOptionsV1 = buildSetupOptions(
  await Bun.file(
    new URL("../content/setup-options.json", import.meta.url),
  ).json(),
);
const { describeSetup, APP_SETUP_URL, COMPUTER_RATE } = await import(
  new URL("../public/setup/result.js", import.meta.url).href
);
const { carryHref } = await import(
  new URL("../public/setup/setup.js", import.meta.url).href
);

const base = () => defaultSetupChoicesV1(options);
const withJob = (
  choices: SetupChoicesV1,
  job: string,
  provider: string,
  model?: string,
): SetupChoicesV1 => {
  const entry = options.jobs.find((candidate) => candidate.id === job)!;
  const chosen = setupProvidersV1(options, entry).find(
    (candidate) => candidate.id === provider,
  )!;
  return {
    ...choices,
    ai: "custom",
    jobs: {
      ...choices.jobs,
      [job]: {
        provider,
        model: model ?? chosen.models?.[0]?.[0] ?? "",
      },
    },
  };
};

/** Every setup a single choice can make, from each starting point. */
function everySetup(): SetupChoicesV1[] {
  const starts = [
    base(),
    ...options.presets.map((preset) => presetChoicesV1(options, preset)),
  ];
  const setups: SetupChoicesV1[] = [...starts];
  for (const start of starts) {
    for (const part of ["host", "computer", "search", "apps"] as const) {
      for (const option of options[part])
        setups.push({ ...start, [part]: option.id });
    }
    for (const job of options.jobs) {
      for (const provider of setupProvidersV1(options, job))
        setups.push(withJob(start, job.id, provider.id));
    }
  }
  return setups;
}

describe("setup options", () => {
  test("the chooser offers every provider the product supports", () => {
    const chat = options.providers.chat.map((provider) => provider.id);
    for (const provider of catalogProvidersV1)
      expect(chat).toContain(provider.id);
    // Models come from the provider catalog, not from this file.
    const openai = options.providers.chat.find(
      (entry) => entry.id === "openai",
    )!;
    expect(openai.models!.length).toBeGreaterThan(10);
  });

  test("the published modules and the page's default setup are current", async () => {
    expect(await publicFile("setup/choices.generated.js").text()).toBe(
      await renderChoicesModule(),
    );
    expect(await publicFile("setup/options.generated.js").text()).toBe(
      renderOptionsModule(options),
    );
    expect(
      await Bun.file(
        new URL("../../../app/setup/options.generated.ts", import.meta.url),
      ).text(),
    ).toBe(renderAppOptionsModule(options));
    const page = await publicFile("setup/index.html").text();
    expect(page).toBe(
      replaceSetupRegion(page, await renderDefaultSetup(options)),
    );
  });

  test("the page runs under the site's CSP: no inline script or style", async () => {
    for (const path of ["setup/index.html", "index.html"]) {
      const page = await publicFile(path).text();
      expect(page).not.toMatch(/\sstyle="/);
      expect(page).not.toMatch(/<style/);
      for (const script of page.matchAll(/<script\b[^>]*>/g))
        expect(script[0]).toContain("src=");
    }
    const sources = await Promise.all(
      ["view.js", "result.js", "setup.js"].map((file) =>
        publicFile(`setup/${file}`).text(),
      ),
    );
    for (const source of sources) expect(source).not.toMatch(/style="/);
  });

  // The plan prices are the payments Package's to hold: its own tests read them.
  test("the computer rate is billing's", () => {
    expect(COMPUTER_RATE).toBe(
      `US$${COMPUTER_TARIFF.activeUsdPerHour.toFixed(2)} per active hour`,
    );
  });
});

describe("the result panel", () => {
  test("a coming-soon option is never offered as a step to follow", () => {
    for (const choices of everySetup()) {
      const result = describeSetup(choices, options);
      const status = new Map<string, string>(
        result.parts.map((part: { key: string; status: string }) => [
          part.key,
          part.status,
        ]),
      );
      for (const step of result.steps)
        for (const key of step.parts) expect(status.get(key)).toBe("available");
      const later = new Set(
        result.later.map((item: { key: string }) => item.key),
      );
      for (const part of result.parts) {
        if (part.status !== "coming-soon") continue;
        const covered =
          later.has(part.key) ||
          // One line covers every FrockBot part a self-hosted install links.
          (choices.host !== "cloud" && part.ours);
        expect(covered).toBe(true);
      }
    }
  });

  test("steps name nothing the options mark coming soon", () => {
    const soonNames = [
      ...(["host", "computer", "search", "apps"] as const).flatMap((part) =>
        options[part]
          .filter((o) => o.status === "coming-soon")
          .map((o) => o.name),
      ),
    ];
    for (const choices of everySetup()) {
      for (const step of describeSetup(choices, options).steps)
        for (const name of soonNames) expect(step.text).not.toContain(name);
    }
  });

  test("the suggested plan follows the setup", () => {
    const plan = (choices: SetupChoicesV1) =>
      suggestSetupPlanV1(choices, options);
    expect(plan(base())).toBe("standard");
    const own = withJob({ ...base(), computer: "server" }, "chat", "openai");
    expect(plan(own)).toBe("byo");
    // Frock AI for any chat job keeps it on Standard.
    expect(plan(withJob(own, "coding", "frock", "@frock/coding"))).toBe(
      "standard",
    );
    expect(plan({ ...own, computer: "frockbot" })).toBe("standard");
    // Self-hosted: no plan, unless connected apps come from FrockBot.
    expect(plan({ ...own, host: "own", apps: "composio" })).toBe("none");
    expect(plan({ ...own, host: "own", apps: "frock" })).toBe("byo");
    expect(plan({ ...base(), host: "own", apps: "frock" })).toBe("byo");
  });

  test("self-hosting does not move AI away from Frock AI", () => {
    const choices = { ...base(), host: "own" };
    expect(choices.ai).toBe("frock");
    const resolved = resolveSetupJobsV1(choices, options);
    for (const job of options.jobs)
      expect(resolved[job.id]!.provider).toBe("frock");
  });

  test("writing and the other chat jobs follow chat", () => {
    const choices = withJob(base(), "chat", "openai", "gpt-5.5");
    const resolved = resolveSetupJobsV1(choices, options);
    for (const job of ["writing", "coding", "summaries"])
      expect(resolved[job]).toEqual({
        provider: "openai",
        model: "gpt-5.5",
        followsChat: true,
      });
    expect(resolved.jev!.provider).toBe("frock");
  });

  test("costs are split into credit, the person's accounts and free", () => {
    const allMine = presetChoicesV1(
      options,
      options.presets.find((preset) => preset.id === "all-mine")!,
    );
    const costs = describeSetup(allMine, options).costs.map(
      (cost: { label: string }) => cost.label,
    );
    expect(costs).toEqual(["Your accounts", "Free"]);
    expect(
      describeSetup(base(), options).costs.map(
        (cost: { label: string }) => cost.label,
      ),
    ).toEqual(["From credit"]);
  });

  test("the call to action carries the setup in the fragment, never the query", () => {
    const choices = withJob(base(), "chat", "anthropic");
    const result = describeSetup(choices, options);
    const href = carryHref(result.cta.href, choices, result.cta.carry);
    const url = new URL(href);
    expect(`${url.origin}${url.pathname}`).toBe(APP_SETUP_URL);
    expect(url.search).toBe("");
    const carried = normalizeSetupChoicesV1(
      readSetupFragmentV1(url.hash),
      options,
    );
    expect(carried).toEqual({ choices, notes: [] });
    // Keys never travel: the format has nowhere to hold one.
    expect(JSON.stringify(readSetupFragmentV1(url.hash))).not.toMatch(
      /key|secret|token/i,
    );
  });
});

describe("the shared setup format", () => {
  test("an unknown or retired value falls back to FrockBot's, with a note", () => {
    const { choices, notes } = normalizeSetupChoicesV1(
      {
        v: 1,
        host: "cloud",
        computer: "a-retired-host",
        ai: "custom",
        jobs: {
          chat: { provider: "a-retired-provider", model: "x" },
          coding: { provider: "openai", model: "a-retired-model" },
        },
        search: "brave",
        apps: "composio",
      },
      options,
    );
    expect(choices.computer).toBe("frockbot");
    expect(choices.jobs.chat).toEqual(base().jobs.chat!);
    expect(choices.jobs.coding).toEqual({ provider: "same" });
    expect(choices.search).toBe("brave");
    expect(notes).toHaveLength(3);
  });

  test("a setup in another version starts from FrockBot's, and says so", () => {
    expect(normalizeSetupChoicesV1({ v: 2, host: "own" }, options)).toEqual({
      choices: base(),
      notes: [expect.stringContaining("format")],
    });
    expect(normalizeSetupChoicesV1(undefined, options)).toEqual({
      choices: base(),
      notes: [],
    });
    expect(readSetupFragmentV1("#setup=!!!")).toEqual({ v: 0 });
    expect(readSetupFragmentV1("#other=1")).toBeUndefined();
  });

  test("the fragment survives non-ASCII and round-trips", () => {
    const choices = withJob(base(), "chat", "openai", "gpt-5.5");
    expect(setupFragmentV1(choices)).toMatch(/^setup=[A-Za-z0-9_-]+$/);
    expect(
      normalizeSetupChoicesV1(
        readSetupFragmentV1(`#${setupFragmentV1(choices)}`),
        options,
      ).choices,
    ).toEqual(choices);
  });

  test("storage keeps choices under one versioned key, and never throws", () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    };
    const choices = withJob(base(), "chat", "openai", "gpt-5.5");
    expect(saveSetupV1(() => storage, choices)).toBe(true);
    expect(JSON.parse(map.get(SETUP_STORAGE_KEY_V1)!)).toEqual({
      v: 1,
      ...choices,
    });
    expect(
      normalizeSetupChoicesV1(
        readSavedSetupV1(() => storage),
        options,
      ).choices,
    ).toEqual(choices);
    const blocked = () => {
      throw new DOMException("denied", "SecurityError");
    };
    expect(readSavedSetupV1(blocked)).toBeUndefined();
    expect(saveSetupV1(blocked, choices)).toBe(false);
  });
});
