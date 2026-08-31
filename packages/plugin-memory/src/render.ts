// The injected Memory block: GrokBot's shape, order, labels and caps.
//
// Parity target, `docs/research/grokbot-computer.md` §4.1a–b. Three scopes,
// injected **user → project → own**, as *labelled paragraphs* rather than
// headings, blank-line separated. Precedence runs the other way — own >
// project > user, "the most specific wins" — so a fact a Bot holds itself is
// not repeated in a shared block below it.
//
// The caps are GrokBot's constants, not ours:
//
//   own      30 recent facts, 4000-char recent budget, 500-char clamp per fact
//   user     50 profile / 15 recent, 4000 / 2000 char budgets
//   project  at most 3 Projects; 25 profile / 10 recent, 2500 / 1500 budgets
//
// DELIBERATELY NOT IMPLEMENTED: `resolveFrozenMemoryPrompt`. GrokBot freezes
// the rendered block per compaction epoch and reuses it, and that freeze is
// the best explanation for the divergence we observed — own profile facts
// sitting on disk while the injected block said "No facts recorded yet"
// (§3.6). Rendering fresh every Turn costs one listing and gives an injection
// that matches the files; the constitution's requirement is that what was
// injected is *recorded*, which `memory/injected` does, not that it is cached.
import type { MemoryScopeNameV1 } from "@frockbot/kernel-contracts";
import {
  memoryFactKeyV1,
  renderInjectedFactLineV1,
  type SourcedMemoryFactV1,
} from "./facts.js";
import { memoryShardOfV1 } from "./roots.js";
import type { MemoryTierReadV1 } from "./store.js";

/** One tier's render bounds, in GrokBot's own units. */
export interface MemoryRenderCapsV1 {
  profileLimit: number;
  recentLimit: number;
  profileBudget: number;
  recentBudget: number;
  factClamp: number;
}

/** `recall(30)`, a 4000-char recent budget, a 500-char clamp per fact. */
export const MEMORY_OWN_CAPS_V1: MemoryRenderCapsV1 = {
  profileLimit: 200,
  recentLimit: 30,
  profileBudget: 4_000,
  recentBudget: 4_000,
  factClamp: 500,
};

/** profileLimit 50 / recentLimit 15, char budgets 4000 / 2000. */
export const MEMORY_USER_CAPS_V1: MemoryRenderCapsV1 = {
  profileLimit: 50,
  recentLimit: 15,
  profileBudget: 4_000,
  recentBudget: 2_000,
  factClamp: 500,
};

/** profileLimit 25 / recentLimit 10, char budgets 2500 / 1500. */
export const MEMORY_PROJECT_CAPS_V1: MemoryRenderCapsV1 = {
  profileLimit: 25,
  recentLimit: 10,
  profileBudget: 2_500,
  recentBudget: 1_500,
  factClamp: 500,
};

/** `MEMORY_PROJECT_INJECTED_CAP`: at most three joined Projects are injected. */
export const MEMORY_PROJECT_INJECTED_CAP = 3;

/** One Project the Bot has joined, as the render needs it. */
export interface MemoryProjectV1 {
  projectId: string;
  name: string;
  description: string;
}

/** A Project's tier read together with the Project it belongs to. */
export interface MemoryProjectTierV1 {
  project: MemoryProjectV1;
  tier: MemoryTierReadV1;
}

/** Everything one Turn renders from. */
export interface MemoryInjectionInputV1 {
  botId: string;
  user: MemoryTierReadV1;
  projects: MemoryProjectTierV1[];
  /** Every joined Project, including the ones the cap left out. */
  joined: MemoryProjectV1[];
  own: MemoryTierReadV1;
}

/** One fact that reached the prompt, as `memory/injected` records it. */
export interface InjectedMemoryFactV1 {
  scope: MemoryScopeNameV1;
  projectId: string;
  tier: "profile" | "log";
  via: string;
  learnedAt: string;
  text: string;
}

/** A tier a cap or a failure cut short, as `memory/injected` records it. */
export interface MemoryOmissionV1 {
  scope: MemoryScopeNameV1;
  reason: string;
}

export interface MemoryInjectionV1 {
  /** The rendered block, or `""` when there is nothing at all to inject. */
  text: string;
  facts: InjectedMemoryFactV1[];
  omissions: MemoryOmissionV1[];
}

const USER_PARAGRAPH =
  "User memory: facts shared by every Bot of this User. It is split into one shard folder per Bot so every file has a single writer. Never edit another Bot's shard — correct a shared fact by writing the correction into your own shard with memory_write, and newest wins.";
const OWN_PARAGRAPH =
  "Memory: your own memory. On conflict prefer your OWN memory first, then project memory, then user memory — the most specific wins; within a shared tier, newest wins.";

interface TakenFacts {
  lines: string[];
  taken: SourcedMemoryFactV1[];
  dropped: number;
}

/** Applies one tier's count limit, char budget and per-fact clamp, in order. */
function take(
  facts: SourcedMemoryFactV1[],
  limit: number,
  budget: number,
  clamp: number,
  withVia: boolean,
): TakenFacts {
  const lines: string[] = [];
  const taken: SourcedMemoryFactV1[] = [];
  let used = 0;
  for (const fact of facts) {
    if (taken.length >= limit) break;
    const line = renderInjectedFactLineV1(
      withVia ? fact : { date: fact.date, text: fact.text },
      clamp,
    );
    if (used + line.length > budget && taken.length > 0) break;
    used += line.length + 1;
    lines.push(line);
    taken.push(fact);
  }
  return { lines, taken, dropped: facts.length - taken.length };
}

function injected(
  facts: SourcedMemoryFactV1[],
  scope: MemoryScopeNameV1,
  projectId: string,
  tier: "profile" | "log",
  withVia: boolean,
): InjectedMemoryFactV1[] {
  return facts.map((fact) => ({
    scope,
    projectId,
    tier,
    via: withVia ? fact.via : "",
    learnedAt: fact.date,
    text: fact.text,
  }));
}

function without(
  facts: SourcedMemoryFactV1[],
  seen: Set<string>,
): SourcedMemoryFactV1[] {
  return facts.filter((fact) => !seen.has(memoryFactKeyV1(fact.text)));
}

function remember(facts: SourcedMemoryFactV1[], seen: Set<string>): void {
  for (const fact of facts) seen.add(memoryFactKeyV1(fact.text));
}

/**
 * Renders the whole Memory block and reports exactly what reached the prompt.
 *
 * Pure: it reads nothing and writes nothing. That is what makes "the session
 * event log records exactly what was injected" checkable — the caller records
 * the `facts` this function returns, so the record cannot drift from the text.
 */
export function renderMemoryInjectionV1(
  input: MemoryInjectionInputV1,
): MemoryInjectionV1 {
  const facts: InjectedMemoryFactV1[] = [];
  const omissions: MemoryOmissionV1[] = [];
  const blocks: string[] = [];

  // Precedence is applied before rendering: the own tier claims a fact text,
  // then the Projects, and only the remainder reaches the User block. The
  // ordering of the *paragraphs* is the opposite — user, project, own — which
  // is GrokBot's injected order exactly.
  const claimed = new Set<string>();
  remember([...input.own.profile, ...input.own.recent], claimed);

  const shown = input.projects.slice(0, MEMORY_PROJECT_INJECTED_CAP);
  const projectFacts = shown.map((entry) => {
    const profile = without(entry.tier.profile, claimed);
    const recent = without(entry.tier.recent, claimed);
    return { entry, profile, recent };
  });
  for (const entry of projectFacts) {
    remember([...entry.profile, ...entry.recent], claimed);
  }

  // User memory.
  const userProfile = take(
    without(input.user.profile, claimed),
    MEMORY_USER_CAPS_V1.profileLimit,
    MEMORY_USER_CAPS_V1.profileBudget,
    MEMORY_USER_CAPS_V1.factClamp,
    true,
  );
  const userRecent = take(
    without(input.user.recent, claimed),
    MEMORY_USER_CAPS_V1.recentLimit,
    MEMORY_USER_CAPS_V1.recentBudget,
    MEMORY_USER_CAPS_V1.factClamp,
    true,
  );
  const userLines = [USER_PARAGRAPH];
  if (userProfile.lines.length > 0) {
    userLines.push("About the user (shared):", ...userProfile.lines);
  }
  if (userRecent.lines.length > 0) {
    userLines.push("Recently (shared):", ...userRecent.lines);
  }
  if (userProfile.lines.length === 0 && userRecent.lines.length === 0) {
    userLines.push("No shared facts recorded yet.");
  }
  blocks.push(userLines.join("\n"));
  facts.push(
    ...injected(userProfile.taken, "user", "", "profile", true),
    ...injected(userRecent.taken, "user", "", "log", true),
  );
  if (input.user.unavailable) {
    omissions.push({ scope: "user", reason: input.user.unavailable });
  }
  const userDropped = userProfile.dropped + userRecent.dropped;
  if (userDropped > 0) {
    omissions.push({
      scope: "user",
      reason: `${userDropped} shared fact(s) beyond the injection cap were not injected`,
    });
  }

  // Project memory, at most three.
  for (const { entry, profile, recent } of projectFacts) {
    const shard = memoryShardOfV1(entry.tier.root, input.botId);
    const lines = [
      `Project "${entry.project.name}" (${entry.project.projectId}) — your shard: ${shard}:`,
    ];
    if (entry.project.description) {
      lines.push(entry.project.description);
    }
    const profileTaken = take(
      profile,
      MEMORY_PROJECT_CAPS_V1.profileLimit,
      MEMORY_PROJECT_CAPS_V1.profileBudget,
      MEMORY_PROJECT_CAPS_V1.factClamp,
      true,
    );
    const recentTaken = take(
      recent,
      MEMORY_PROJECT_CAPS_V1.recentLimit,
      MEMORY_PROJECT_CAPS_V1.recentBudget,
      MEMORY_PROJECT_CAPS_V1.factClamp,
      true,
    );
    if (profileTaken.lines.length > 0) {
      lines.push("About this project (shared):", ...profileTaken.lines);
    }
    if (recentTaken.lines.length > 0) {
      lines.push("Recently (shared):", ...recentTaken.lines);
    }
    if (profileTaken.lines.length === 0 && recentTaken.lines.length === 0) {
      lines.push("No shared facts recorded yet for this project.");
    }
    const others = input.joined
      .filter((project) => project.projectId !== entry.project.projectId)
      .map((project) => project.projectId);
    if (others.length > 0) lines.push(`Also a member of: ${others.join(", ")}`);
    blocks.push(lines.join("\n"));
    facts.push(
      ...injected(
        profileTaken.taken,
        "project",
        entry.project.projectId,
        "profile",
        true,
      ),
      ...injected(
        recentTaken.taken,
        "project",
        entry.project.projectId,
        "log",
        true,
      ),
    );
    if (entry.tier.unavailable) {
      omissions.push({
        scope: "project",
        reason: `${entry.project.projectId}: ${entry.tier.unavailable}`,
      });
    }
    const dropped = profileTaken.dropped + recentTaken.dropped;
    if (dropped > 0) {
      omissions.push({
        scope: "project",
        reason: `${entry.project.projectId}: ${dropped} shared fact(s) beyond the injection cap were not injected`,
      });
    }
  }
  if (input.projects.length > MEMORY_PROJECT_INJECTED_CAP) {
    omissions.push({
      scope: "project",
      reason: `at most ${MEMORY_PROJECT_INJECTED_CAP} joined Projects are injected; ${
        input.projects.length - MEMORY_PROJECT_INJECTED_CAP
      } were not`,
    });
  }

  // Own memory, last and most specific.
  const ownProfile = take(
    input.own.profile,
    MEMORY_OWN_CAPS_V1.profileLimit,
    MEMORY_OWN_CAPS_V1.profileBudget,
    MEMORY_OWN_CAPS_V1.factClamp,
    false,
  );
  const ownRecent = take(
    input.own.recent,
    MEMORY_OWN_CAPS_V1.recentLimit,
    MEMORY_OWN_CAPS_V1.recentBudget,
    MEMORY_OWN_CAPS_V1.factClamp,
    false,
  );
  const ownLines = [OWN_PARAGRAPH];
  if (ownProfile.lines.length > 0) {
    ownLines.push("About the user:", ...ownProfile.lines);
  }
  if (ownRecent.lines.length > 0) {
    ownLines.push("Recently:", ...ownRecent.lines);
  }
  if (ownProfile.lines.length === 0 && ownRecent.lines.length === 0) {
    ownLines.push("No facts recorded yet.");
  }
  if (ownRecent.dropped > 0) {
    ownLines.push(
      `(${ownRecent.dropped} more log facts on disk — grep the log/ folder for them.)`,
    );
  }
  blocks.push(ownLines.join("\n"));
  facts.push(
    ...injected(ownProfile.taken, "bot", "", "profile", false),
    ...injected(ownRecent.taken, "bot", "", "log", false),
  );
  if (input.own.unavailable) {
    omissions.push({ scope: "bot", reason: input.own.unavailable });
  }
  const ownDropped = ownProfile.dropped + ownRecent.dropped;
  if (ownDropped > 0) {
    omissions.push({
      scope: "bot",
      reason: `${ownDropped} own fact(s) beyond the injection cap were not injected`,
    });
  }

  return { text: blocks.join("\n\n"), facts, omissions };
}
