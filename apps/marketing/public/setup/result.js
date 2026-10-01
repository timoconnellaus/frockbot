import {
  resolveSetupJobsV1,
  selfHostedV1,
  setupJobV1,
  setupPartsV1,
  setupProviderV1,
  suggestSetupPlanV1,
} from "./choices.generated.js";

export const APP_SETUP_URL = "https://bot.frockbot.com/setup/apply";
const SOURCE_URL = "https://github.com/timoconnellaus/frockbot";

export const PLANS = {
  standard: {
    name: "Standard",
    price: "US$20 a month",
  },
  byo: { name: "BYO", price: "US$5 a month" },
  none: { name: "No plan needed", price: "Free" },
};
export const COMPUTER_RATE = "US$2.75 per active hour";

const and = (items) =>
  items.length > 1
    ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`
    : (items[0] ?? "");
const cap = (text) => text.replace(/^./, (first) => first.toUpperCase());
const lower = (text) => text.charAt(0).toLowerCase() + text.slice(1);

const FALLBACK = {
  host: "frockbot.com",
  computer: "FrockBot’s computer",
  search: "FrockBot’s search",
  apps: "FrockBot’s connected apps",
};

/**
 * Everything the result panel says about a setup. Steps name only what a
 * person can do today; a coming-soon part goes under `later`, with what
 * covers it in the meantime, and is never a step to follow.
 */
export function describeSetup(choices, options) {
  const own = selfHostedV1(choices);
  const resolved = resolveSetupJobsV1(choices, options);
  const parts = setupPartsV1(choices, options);
  const part = (key) => parts.find((entry) => entry.key === key);
  const job = (id) => setupJobV1(options, id);
  const provider = (id) =>
    setupProviderV1(options, job(id), resolved[id].provider);
  const usesFrock = (id) => !!provider(id)?.ours;
  const chatJobs = options.jobs.filter((entry) => entry.kind === "chat");
  const frockChat = chatJobs.filter((entry) => usesFrock(entry.id));
  const oursComputer = options.computer.find((entry) => entry.ours).id;
  const oursSearch = options.search.find((entry) => entry.ours).id;
  const oursApps = options.apps.find((entry) => entry.ours).id;
  const single = (key) =>
    options[key].find((entry) => entry.id === choices[key]);

  const oursUsed = [];
  if (choices.computer === oursComputer) oursUsed.push("computer");
  if (frockChat.length) oursUsed.push("Frock AI");
  if (usesFrock("jev")) oursUsed.push("Jev");
  if (usesFrock("voice")) oursUsed.push("voice calls");
  if (usesFrock("dictation")) oursUsed.push("dictation");
  if (usesFrock("image")) oursUsed.push("images");
  if (choices.search === oursSearch) oursUsed.push("web search");
  if (choices.apps === oursApps) oursUsed.push("connected apps");

  const planId = suggestSetupPlanV1(choices, options);
  let note;
  if (planId === "byo" && own) {
    note = `Connected apps through FrockBot need the BYO plan on your linked FrockBot account.${oursUsed.length > 1 ? " Other FrockBot parts come from credit." : ""}`;
  } else if (planId === "none") {
    note = oursUsed.length
      ? "Link a FrockBot account and top up for the FrockBot parts."
      : "Everything runs on your own accounts.";
  } else if (planId === "standard") {
    note = "Includes US$20 of credit for our computer and models. 7-day trial.";
  } else {
    const covers = ["hosting"];
    if (usesFrock("jev")) covers.push("Jev");
    if (choices.apps === oursApps) covers.push("connected apps");
    note = `Covers ${and(covers)}. No trial.`;
  }
  const plan = { id: planId, ...PLANS[planId], note };

  const costs = [];
  const fromCredit = oursUsed
    .filter((item) =>
      item === "connected apps" ? false : own ? true : item !== "Jev",
    )
    .map((item) =>
      item === "computer"
        ? `computer time at ${COMPUTER_RATE}`
        : item === "Frock AI"
          ? `Frock AI for ${and(frockChat.map((entry) => lower(entry.name)))}`
          : item,
    );
  if (fromCredit.length) {
    costs.push({
      label: "From credit",
      value: `${cap(and(fromCredit))}${planId === "standard" ? ", from your included credit first." : ", from credit you top up."}`,
    });
  }
  const uses = new Map();
  const use = (account, what) => {
    const list = uses.get(account) ?? [];
    if (!list.includes(what)) list.push(what);
    uses.set(account, list);
  };
  if (own) use("Cloudflare", "hosting");
  const free = [];
  for (const entry of options.jobs) {
    const chosen = provider(entry.id);
    if (!chosen || chosen.ours) continue;
    if (chosen.free) {
      free.push(lower(entry.name));
      continue;
    }
    use(
      chosen.id.startsWith("cloudflare") ? "Cloudflare" : chosen.name,
      entry.id === "jev" ? "Jev" : lower(entry.name),
    );
  }
  for (const [key, what] of [
    ["search", "web search"],
    ["apps", "connected apps"],
  ]) {
    const option = single(key);
    if (option?.account) use(option.account, what);
    if (option?.free) free.push(what);
  }
  const accounts = [];
  const computer = single("computer");
  if (computer?.account) accounts.push(`${computer.account} for the computer`);
  for (const [account, what] of uses)
    accounts.push(`${account} for ${and(what)}`);
  if (accounts.length)
    costs.push({
      label: "Your accounts",
      value: `${cap(accounts.join("; "))}.`,
    });
  if (computer?.free) free.unshift("the computer");
  if (free.length)
    costs.push({
      label: "Free",
      value: `${cap(and(free))}, on your own hardware.`,
    });

  const yoursComputer = choices.computer !== oursComputer;
  const yoursAI = oursUsed.every((item) =>
    ["computer", "web search", "connected apps"].includes(item),
  );
  const yoursServices =
    choices.search !== oursSearch && choices.apps !== oursApps;
  const ran = [];
  if (own) ran.push("app");
  if (yoursComputer) ran.push("computer");
  if (yoursAI) ran.push("AI");
  if (yoursServices) ran.push("search and apps");
  let headline =
    ran.length === 0
      ? "FrockBot runs everything."
      : ran.length === 4
        ? "You run everything."
        : `You run the ${and(ran)}. FrockBot runs the rest.`;
  if (!own && ran.length === 3) headline = "You run everything but the app.";
  const subline =
    ran.length === 0
      ? "Nothing to install or look after. Your bots are ready when you sign in."
      : oursUsed.length && !yoursAI
        ? "You keep the parts you care about. FrockBot looks after the rest."
        : "FrockBot is the code. The accounts, machines and models are yours.";

  const providerName = (id) => provider(id)?.name ?? "Frock AI";
  const chatNames = [
    ...new Set(chatJobs.map((entry) => providerName(entry.id))),
  ];
  const soon = (...keys) =>
    keys.some((key) => part(key)?.status === "coming-soon");
  const node = (title, where, yours, isSoon) => ({
    title,
    where,
    yours,
    who: yours ? "Yours" : "FrockBot’s",
    soon: !!isSoon,
  });
  const nodes = [
    node(
      "FrockBot",
      own ? "Your Cloudflare account" : "frockbot.com",
      own,
      soon("host"),
    ),
    node(
      "Computer",
      {
        frockbot: "FrockBot’s cloud",
        fly: "Your Fly.io",
        server: "Your server",
        mac: "Your Mac",
      }[choices.computer] ?? computer?.name,
      yoursComputer,
      soon("computer"),
    ),
    node(
      "Chat and jobs",
      and(chatNames),
      frockChat.length === 0,
      soon(...chatJobs.map((entry) => `job:${entry.id}`)),
    ),
    node("Jev", providerName("jev"), !usesFrock("jev"), soon("job:jev")),
    node(
      "Voice and dictation",
      `${providerName("voice")} · ${providerName("dictation")}`,
      !usesFrock("voice") && !usesFrock("dictation"),
      soon("job:voice", "job:dictation"),
    ),
    node(
      "Images",
      providerName("image"),
      !usesFrock("image"),
      soon("job:image"),
    ),
    node(
      "Search and apps",
      `${choices.search === oursSearch ? "FrockBot’s" : single("search")?.name} · ${choices.apps === oursApps ? "FrockBot’s" : single("apps")?.name}`,
      yoursServices,
      soon("search", "apps"),
    ),
  ];
  if (frockChat.length && frockChat.length < chatJobs.length)
    nodes[2].who = "Both";

  const gains = [];
  const gain = (plus, text) => gains.push({ plus, text });
  if (own) {
    gain(true, "Everything lives in a Cloudflare account you own.");
    gain(false, "You choose when to update.");
  } else gain(true, "Nothing to install, update or keep running.");
  ({
    frockbot: () =>
      gain(true, "The computer stays on, even when your devices are off."),
    fly: () => gain(true, "Your own Fly.io account, regions and limits."),
    server: () => {
      gain(true, "Full control of the machine your bots use.");
      gain(false, "You keep the server patched and running.");
    },
    mac: () => {
      gain(true, "Free, and nothing to rent.");
      gain(false, "Bots can only use it while your Mac is awake.");
    },
  })[choices.computer]?.();
  const paidAccounts = [...uses.keys()];
  if (paidAccounts.some((account) => account !== "Cloudflare" || !own))
    gain(true, "Use models and services you already pay for.");
  if (!usesFrock("jev"))
    gain(true, "Jev, which checks every step, runs on your account.");
  if (free.length)
    gain(true, "What runs on your hardware stays on your hardware.");
  if (paidAccounts.length)
    gain(
      false,
      "If one of your accounts fails or runs out, your bot tells you. It never switches to ours.",
    );

  // Only what works today becomes a step.
  const steps = [];
  const step = (text, keys) => steps.push({ text, parts: keys });
  const later = [];
  const hostSoon = soon("host");
  if (own && hostSoon) {
    step(
      "Self-hosting from frockbot.com is coming soon. Until then, every line of FrockBot is on GitHub to read.",
      [],
    );
  } else if (own) {
    step("Press Deploy on frockbot.com and sign in to Cloudflare.", ["host"]);
  } else {
    step(
      `Sign up at bot.frockbot.com on the ${plan.name} plan, or download the app.`,
      ["host"],
    );
  }
  if (!own && part("computer").status === "available" && !yoursComputer) {
    step(
      "Nothing to do for the computer. It starts the first time a bot needs it.",
      ["computer"],
    );
  }
  const connect = new Map();
  for (const entry of chatJobs) {
    const current = part(`job:${entry.id}`);
    const chosen = provider(entry.id);
    if (!chosen || chosen.ours || current.status !== "available") continue;
    if (own && chosen.includedWhenSelfHosted) continue;
    connect.set(chosen.name, chosen.connect);
  }
  for (const [name, how] of connect) {
    step(
      how === "sign-in"
        ? `When setup asks, sign in to ${name} for chat.`
        : `When setup asks, paste your ${name} API key for chat.`,
      [`job:chat`],
    );
  }

  let linkNoted = false;
  for (const entry of parts) {
    if (entry.status !== "coming-soon") continue;
    if (entry.key === "host") {
      later.push({
        key: entry.key,
        text: "The Deploy button for your own Cloudflare account is coming soon. Your choices are saved, and it will pick them up.",
      });
      continue;
    }
    if (own && entry.ours) {
      if (!linkNoted) {
        later.push({
          key: entry.key,
          text: "Linking a FrockBot account to your own install, for FrockBot’s computer, models and services, is coming soon.",
        });
        linkNoted = true;
      }
      continue;
    }
    const isJob = entry.key.startsWith("job:");
    const noun = entry.name === "Jev" ? "Jev" : lower(entry.name);
    later.push({
      key: entry.key,
      text: `${entry.choice} for ${noun} is coming soon. Until then, ${isJob ? "Frock AI" : FALLBACK[entry.key]} ${isJob ? "does it" : "stands in"}.`,
    });
  }

  const fragmentFree = own && hostSoon;
  return {
    own,
    headline,
    subline,
    plan,
    nodes,
    costs,
    gains,
    steps,
    later,
    parts,
    cta: fragmentFree
      ? {
          label: "Run it from the source",
          href: SOURCE_URL,
          note: "Self-hosting with the Deploy button is coming soon. Your choices are saved on this device, and the deploy page will pick them up.",
          secondary: {
            label: "Start on frockbot.com instead",
            href: APP_SETUP_URL,
            carry: "cloud",
          },
        }
      : {
          label: "Start with this setup",
          href: APP_SETUP_URL,
          carry: "as-chosen",
          note:
            planId === "standard"
              ? "Standard, with a 7-day trial. Your choices come with you, so you won’t set them up twice."
              : "BYO, US$5 a month. Your choices come with you, so you won’t set them up twice.",
          secondary: {
            label: "Download for Mac",
            href: "https://frockbot.com/download/mac",
          },
        },
  };
}
