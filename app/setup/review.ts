import {
  normalizeSetupChoicesV1,
  resolveSetupJobsV1,
  setupPartsV1,
  setupProviderV1,
  suggestSetupPlanV1,
  type SetupChoicesV1,
  type SetupOptionsV1,
  type SetupPartV1,
  type SetupPlanV1,
} from "@frockbot/core/setup-choices";
import { setupOptionsV1 } from "./options.js";

/** What the account already has, as far as a setup's review needs. */
export interface SetupAccountFactsV1 {
  /** Provider ids the account has a model connection for. */
  connectedProviders: ReadonlySet<string>;
  /** The plan the account is subscribed to, trial included, if any. */
  plan: string | undefined;
}

/** What one part still needs before it runs the way the person chose. */
export type SetupNeedV1 = "ready" | "key" | "sign-in" | "coming-soon";

export interface SetupReviewRowV1 {
  key: string;
  name: string;
  choice: string;
  need: SetupNeedV1;
  /** The provider to connect, for a row that needs a key or a sign-in. */
  provider?: string;
  /** For a coming-soon row: what covers it until then. */
  note?: string;
  /** Connecting it needs more than a key, so it is finished in the app. */
  finishInApp?: boolean;
}

export interface SetupReviewV1 {
  choices: SetupChoicesV1;
  /** Parts of the saved setup this deployment no longer offers. */
  notes: string[];
  plan: {
    suggested: SetupPlanV1;
    /** The plan to check out on, when the account is not on one that fits. */
    checkout: "standard" | "byo" | undefined;
    label: string;
  };
  rows: SetupReviewRowV1[];
  /**
   * The account's default model once applied: the chat choice, when it runs
   * on a provider that is available and connected. Anything else stays on
   * Frock AI until the person finishes it.
   */
  defaultModel: { provider: string; model: string } | undefined;
}

const PLAN_LABELS: Record<SetupPlanV1, string> = {
  standard: "Standard, 7-day trial",
  byo: "BYO, US$5 a month",
  none: "No plan needed",
};

// Standard and Plus include everything BYO does.
const COVERS: Record<"standard" | "byo", readonly string[]> = {
  standard: ["standard", "plus"],
  byo: ["byo", "standard", "plus"],
};

function comingSoonNote(part: SetupPartV1): string {
  if (part.key.startsWith("job:")) {
    const plural = part.key === "job:image" || part.key === "job:voice";
    return `Coming soon. Frock AI ${plural ? "handles them" : "handles it"} for now.`;
  }
  const until: Record<string, string> = {
    host: "frockbot.com runs it for now.",
    computer: "FrockBot’s computer runs it for now.",
    search: "FrockBot’s search runs it for now.",
    apps: "FrockBot’s connected apps run it for now.",
  };
  return `Coming soon. ${until[part.key] ?? "FrockBot’s runs it for now."}`;
}

/**
 * The setup chosen on frockbot.com, reviewed against this account: each part
 * with what it still needs. Nothing here changes the account; applying is a
 * separate, explicit command.
 */
export function reviewSetupV1(
  raw: unknown,
  facts: SetupAccountFactsV1,
  options: SetupOptionsV1 = setupOptionsV1(),
): SetupReviewV1 {
  const { choices, notes } = normalizeSetupChoicesV1(raw, options);
  const parts = setupPartsV1(choices, options);
  const resolved = resolveSetupJobsV1(choices, options);
  const need = (part: SetupPartV1, provider?: string): SetupNeedV1 => {
    if (part.status === "coming-soon") return "coming-soon";
    if (part.ours || !part.connect) return "ready";
    if (provider && facts.connectedProviders.has(provider)) return "ready";
    return part.connect === "sign-in" ? "sign-in" : "key";
  };
  const rows: SetupReviewRowV1[] = [];
  const suggested = suggestSetupPlanV1(choices, options);
  const checkout =
    suggested === "none" ||
    (facts.plan !== undefined && COVERS[suggested].includes(facts.plan))
      ? undefined
      : suggested;
  const row = (
    part: SetupPartV1,
    name = part.name,
    provider?: string,
    jobId?: string,
  ) => {
    const status = need(part, provider);
    const entry =
      jobId && provider
        ? setupProviderV1(
            options,
            options.jobs.find((job) => job.id === jobId)!,
            provider,
          )
        : undefined;
    rows.push({
      key: part.key,
      name,
      choice: part.choice,
      need: status,
      ...(provider && (status === "key" || status === "sign-in")
        ? { provider }
        : {}),
      ...(status === "coming-soon" ? { note: comingSoonNote(part) } : {}),
      ...(status === "key" && entry?.needsSettings
        ? { finishInApp: true }
        : {}),
    });
  };
  for (const part of parts) {
    if (part.key === "host" && part.ours) continue;
    // Jobs that follow chat are chat's row.
    if (part.key.startsWith("job:") && part.followsChat) continue;
    if (part.key === "job:chat") {
      row(part, "Chat and jobs", resolved.chat!.provider, "chat");
      continue;
    }
    const jobId = part.key.startsWith("job:") ? part.key.slice(4) : undefined;
    row(
      part,
      part.key === "computer" ? "Computer" : part.name,
      jobId ? resolved[jobId]!.provider : undefined,
      jobId,
    );
  }
  const chatJob = options.jobs.find((job) => job.id === "chat")!;
  const chat = resolved.chat!;
  const chatProvider = setupProviderV1(options, chatJob, chat.provider);
  const chatRow = rows.find((entry) => entry.key === "job:chat");
  return {
    choices,
    notes,
    plan: { suggested, checkout, label: PLAN_LABELS[suggested] },
    rows,
    defaultModel:
      chatProvider && !chatProvider.ours && chatRow?.need === "ready"
        ? { provider: chat.provider, model: chat.model }
        : undefined,
  };
}
