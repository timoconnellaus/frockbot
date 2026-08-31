// The injected Memory block: GrokBot's shape, order, labels, and caps.
import { describe, expect, test } from "bun:test";
import type { SourcedMemoryFactV1 } from "./facts.ts";
import {
  MEMORY_NOTE_TTL_DAYS,
  MEMORY_PROJECT_INJECTED_CAP,
  renderMemoryInjectionV1,
  type MemoryProjectV1,
} from "./render.ts";
import {
  botMemoryRootV1,
  projectMemoryRootV1,
  userMemoryRootV1,
} from "./roots.ts";
import type { MemoryTierReadV1 } from "./store.ts";

const OWNER = { userId: "user-1", botId: "bot-1" };
// Every fact in these fixtures is dated 2026-08-30 and unmarked, so the fade
// is inert here; the fade's own cases pick their cutoffs deliberately.
const CUTOFF = "2026-08-17";

function fact(
  text: string,
  overrides: Partial<SourcedMemoryFactV1> = {},
): SourcedMemoryFactV1 {
  return {
    date: "2026-08-30",
    text,
    botId: "bot-2",
    via: "School",
    kind: "profile",
    generationId: "000000000000001-000001",
    ...overrides,
  };
}

function tier(
  root: MemoryTierReadV1["root"],
  profile: SourcedMemoryFactV1[] = [],
  recent: SourcedMemoryFactV1[] = [],
): MemoryTierReadV1 {
  return {
    root,
    profile,
    recent,
    sources: [],
    logTotal: recent.length,
  };
}

const PROJECT: MemoryProjectV1 = {
  projectId: "ghetto-movement",
  name: "Ghetto Movement",
  description: "The gym build.",
};

describe("the injected Memory block", () => {
  test("renders user, then project, then own, as labelled paragraphs", () => {
    const injection = renderMemoryInjectionV1({
      botId: "bot-1",
      noteCutoff: CUTOFF,
      user: tier(userMemoryRootV1(OWNER), [fact("Tim lives in Wollongong.")]),
      projects: [
        {
          project: PROJECT,
          tier: tier(projectMemoryRootV1(OWNER, PROJECT.projectId), [
            fact("The floor is rubber.", { via: "General", botId: "bot-1" }),
          ]),
        },
      ],
      joined: [PROJECT],
      own: tier(
        botMemoryRootV1(OWNER),
        [fact("Tim prefers blunt answers.", { via: "", botId: "bot-1" })],
        [
          fact("Term ends on the 12th.", {
            kind: "log",
            via: "",
            botId: "bot-1",
            date: "2026-08-31",
          }),
        ],
      ),
    });

    const blocks = injection.text.split("\n\n");
    expect(blocks[0]?.startsWith("User memory:")).toBe(true);
    expect(
      blocks[1]?.startsWith('Project "Ghetto Movement" (ghetto-movement)'),
    ).toBe(true);
    expect(blocks[2]?.startsWith("Memory:")).toBe(true);
    // Labelled paragraphs, not headings.
    expect(injection.text).not.toContain("## ");
    expect(injection.text).toContain("About the user (shared):");
    expect(injection.text).toContain("About this project (shared):");
    expect(injection.text).toContain("About the user:");
    expect(injection.text).toContain("Recently:");
    expect(injection.text).toContain("your shard: by-agent/bot-1/");
  });

  test("tags a shared fact with the Bot that learned it and omits [via] on own facts", () => {
    const injection = renderMemoryInjectionV1({
      botId: "bot-1",
      noteCutoff: CUTOFF,
      user: tier(userMemoryRootV1(OWNER), [fact("Tim lives in Wollongong.")]),
      projects: [],
      joined: [],
      own: tier(botMemoryRootV1(OWNER), [
        fact("Tim prefers blunt answers.", { via: "", botId: "bot-1" }),
      ]),
    });

    expect(injection.text).toContain(
      "- (learned 2026-08-30) [via School] Tim lives in Wollongong.",
    );
    expect(injection.text).toContain(
      "- (learned 2026-08-30) Tim prefers blunt answers.",
    );
  });

  test("own memory wins over project, and project over user, on the same fact", () => {
    const shared = "Tim lives in Wollongong.";
    const injection = renderMemoryInjectionV1({
      botId: "bot-1",
      noteCutoff: CUTOFF,
      user: tier(userMemoryRootV1(OWNER), [fact(shared)]),
      projects: [
        {
          project: PROJECT,
          tier: tier(projectMemoryRootV1(OWNER, PROJECT.projectId), [
            fact(shared),
          ]),
        },
      ],
      joined: [PROJECT],
      own: tier(botMemoryRootV1(OWNER), [
        fact(shared, { via: "", botId: "bot-1" }),
      ]),
    });

    // Exactly once, in the own block, with no `[via …]`.
    expect(injection.text.split(shared)).toHaveLength(2);
    expect(injection.facts.filter((entry) => entry.text === shared)).toEqual([
      {
        scope: "bot",
        projectId: "",
        tier: "profile",
        via: "",
        learnedAt: "2026-08-30",
        text: shared,
      },
    ]);
    expect(injection.text).toContain("No shared facts recorded yet.");
    expect(injection.text).toContain(
      "No shared facts recorded yet for this project.",
    );
  });

  test("applies GrokBot's caps: 3 projects, 50/15 user, 25/10 project, 30 own recent", () => {
    const many = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, index) =>
        fact(`${prefix} ${index}`, {
          kind: "log",
          date: "2026-08-30",
          generationId: `000000000000001-${String(index).padStart(6, "0")}`,
        }),
      );
    const projects = Array.from({ length: 5 }, (_, index) => ({
      project: {
        projectId: `project-${index}`,
        name: `Project ${index}`,
        description: "",
      },
      tier: tier(
        projectMemoryRootV1(OWNER, `project-${index}`),
        [],
        many(20, `p${index}`),
      ),
    }));

    const injection = renderMemoryInjectionV1({
      botId: "bot-1",
      noteCutoff: CUTOFF,
      user: tier(
        userMemoryRootV1(OWNER),
        many(80, "u").map((entry) => ({
          ...entry,
          kind: "profile" as const,
        })),
        many(40, "ur"),
      ),
      projects,
      joined: projects.map((entry) => entry.project),
      own: tier(botMemoryRootV1(OWNER), [], many(60, "o")),
    });

    const count = (scope: string, kind: string, projectId?: string) =>
      injection.facts.filter(
        (entry) =>
          entry.scope === scope &&
          entry.tier === kind &&
          (projectId === undefined || entry.projectId === projectId),
      ).length;

    expect(count("user", "profile")).toBe(50);
    expect(count("user", "log")).toBe(15);
    expect(count("bot", "log")).toBe(30);
    expect(count("project", "log", "project-0")).toBe(10);
    expect(
      new Set(
        injection.facts
          .filter((entry) => entry.scope === "project")
          .map((entry) => entry.projectId),
      ).size,
    ).toBe(MEMORY_PROJECT_INJECTED_CAP);
    // The cut is visible in durable state, not silent.
    expect(
      injection.omissions.some((omission) =>
        omission.reason.includes("at most 3 joined Projects"),
      ),
    ).toBe(true);
    expect(injection.text).toContain("more log facts on disk");
  });

  test("clamps a single fact at 500 characters", () => {
    const long = "x".repeat(900);
    const injection = renderMemoryInjectionV1({
      botId: "bot-1",
      noteCutoff: CUTOFF,
      user: tier(userMemoryRootV1(OWNER)),
      projects: [],
      joined: [],
      own: tier(botMemoryRootV1(OWNER), [
        fact(long, { via: "", botId: "bot-1" }),
      ]),
    });
    const line = injection.text
      .split("\n")
      .find((candidate) => candidate.includes("xxx"));
    expect(line).toBeDefined();
    expect(line?.endsWith("…")).toBe(true);
    expect(line?.length).toBeLessThanOrEqual(
      "- (learned 2026-08-30) ".length + 500,
    );
  });

  test("records a tier it could not read as an omission rather than staying silent", () => {
    const unreadable = {
      ...tier(userMemoryRootV1(OWNER)),
      unavailable: "the bucket is unreachable",
    };
    const injection = renderMemoryInjectionV1({
      botId: "bot-1",
      noteCutoff: CUTOFF,
      user: unreadable,
      projects: [],
      joined: [],
      own: tier(botMemoryRootV1(OWNER)),
    });
    expect(injection.omissions).toContainEqual({
      scope: "user",
      reason: "the bucket is unreachable",
    });
    expect(injection.text).toContain("No facts recorded yet.");
  });
});

describe("the note fade", () => {
  // The cutoff is the oldest day a marked fact is still injected on, so a
  // note dated exactly on it is live and one dated the day before is faded.
  const CUT = "2026-08-18";
  const own = (
    text: string,
    date: string,
    kind: "profile" | "log" = "log",
  ): SourcedMemoryFactV1 =>
    fact(text, { text, date, kind, via: "", botId: "bot-1" });

  test("14 days, and the boundary is exact in both directions", () => {
    expect(MEMORY_NOTE_TTL_DAYS).toBe(14);
    const injection = renderMemoryInjectionV1({
      botId: "bot-1",
      noteCutoff: CUT,
      user: tier(userMemoryRootV1(OWNER)),
      projects: [],
      joined: [],
      own: tier(
        botMemoryRootV1(OWNER),
        [],
        [
          own("[note] on the cutoff", CUT),
          own("[note] the day before", "2026-08-17"),
          own("an old log fact", "2026-01-01"),
        ],
      ),
    });

    expect(injection.text).toContain("[note] on the cutoff");
    expect(injection.text).not.toContain("the day before");
    // An unmarked log fact never fades, however old.
    expect(injection.text).toContain("an old log fact");
    expect(injection.faded).toEqual([
      { scope: "bot", projectId: "", count: 1 },
    ]);
    // A fade is the feature working, not a gap to repair.
    expect(injection.omissions).toEqual([]);
  });

  test("`[episode]` fades on the same rule as `[note]`", () => {
    const injection = renderMemoryInjectionV1({
      botId: "bot-1",
      noteCutoff: CUT,
      user: tier(userMemoryRootV1(OWNER)),
      projects: [],
      joined: [],
      own: tier(
        botMemoryRootV1(OWNER),
        [own("[episode] last spring", "2026-08-17", "profile")],
        [],
      ),
    });
    expect(injection.text).not.toContain("last spring");
    expect(injection.faded).toEqual([
      { scope: "bot", projectId: "", count: 1 },
    ]);
  });

  test("a faded note does not consume a cap slot a live fact could use", () => {
    const stale = Array.from({ length: 20 }, (_, index) =>
      own(`[note] stale ${index}`, "2026-08-17"),
    );
    const live = Array.from({ length: 30 }, (_, index) =>
      own(`live ${index}`, "2026-08-30"),
    );
    const injection = renderMemoryInjectionV1({
      botId: "bot-1",
      noteCutoff: CUT,
      user: tier(userMemoryRootV1(OWNER)),
      projects: [],
      joined: [],
      // The stale notes come first, so a fade applied *after* the cap would
      // have eaten every one of the 30 own-recent slots.
      own: tier(botMemoryRootV1(OWNER), [], [...stale, ...live]),
    });

    expect(
      injection.facts.filter((entry) => entry.tier === "log"),
    ).toHaveLength(30);
    expect(
      injection.facts.every((entry) => entry.text.startsWith("live ")),
    ).toBe(true);
    // The faded notes are still on disk, so the pointer still counts them…
    expect(injection.text).toContain(
      "(20 more log facts on disk — grep the log/ folder for them.)",
    );
    // …and they are not reported as a cap omission, because no cap bit.
    expect(injection.omissions).toEqual([]);
    expect(injection.faded).toEqual([
      { scope: "bot", projectId: "", count: 20 },
    ]);
  });

  test("counts fades per scope and per project", () => {
    const stale = (text: string) =>
      fact(text, { text, date: "2026-08-17", kind: "log" });
    const injection = renderMemoryInjectionV1({
      botId: "bot-1",
      noteCutoff: CUT,
      user: tier(
        userMemoryRootV1(OWNER),
        [],
        [stale("[note] user one"), stale("[note] user two")],
      ),
      projects: [
        {
          project: PROJECT,
          tier: tier(
            projectMemoryRootV1(OWNER, PROJECT.projectId),
            [],
            [stale("[note] project one")],
          ),
        },
      ],
      joined: [PROJECT],
      own: tier(botMemoryRootV1(OWNER)),
    });

    expect(injection.faded).toEqual([
      { scope: "user", projectId: "", count: 2 },
      { scope: "project", projectId: PROJECT.projectId, count: 1 },
    ]);
    expect(injection.facts).toEqual([]);
  });

  test("a whole tier of faded notes renders the empty-tier text, not a blank block", () => {
    const injection = renderMemoryInjectionV1({
      botId: "bot-1",
      noteCutoff: CUT,
      user: tier(
        userMemoryRootV1(OWNER),
        [],
        [fact("[note] gone", { text: "[note] gone", date: "2026-08-17" })],
      ),
      projects: [],
      joined: [],
      own: tier(
        botMemoryRootV1(OWNER),
        [],
        [own("[note] also gone", "2026-08-17")],
      ),
    });
    expect(injection.text).toContain("No shared facts recorded yet.");
    expect(injection.text).toContain("No facts recorded yet.");
    expect(injection.text).not.toContain("gone");
  });

  test("precedence runs on the survivors: a faded own note frees the shared one", () => {
    const shared = "we ship on Friday";
    const injection = renderMemoryInjectionV1({
      botId: "bot-1",
      noteCutoff: CUT,
      user: tier(userMemoryRootV1(OWNER), [fact(shared)]),
      projects: [],
      joined: [],
      own: tier(
        botMemoryRootV1(OWNER),
        [],
        [own(`[note] ${shared}`, "2026-08-17")],
      ),
    });
    // The own note faded, so it does not claim the text away from the User
    // block — the User's durable fact is injected instead of nothing at all.
    expect(injection.text).toContain(`[via School] ${shared}`);
    expect(injection.faded).toEqual([
      { scope: "bot", projectId: "", count: 1 },
    ]);
  });
});
