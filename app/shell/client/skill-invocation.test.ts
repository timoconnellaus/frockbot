import { describe, expect, test } from "bun:test";
import type { ClientSkillCatalogEntryV1 } from "../skill-protocol.js";
import {
  keptSkillHighlightV1,
  nextSkillHighlightV1,
  rankSkillCandidatesV1,
  SkillAttachmentStore,
  skillPopoverForV1,
  textWithoutSkillTriggerV1,
} from "./skill-invocation.js";

function entry(
  slug: string,
  name: string,
  description = "Use this when something happens.",
): ClientSkillCatalogEntryV1 {
  return {
    ref: `bot/${slug}`,
    skill: { schemaVersion: 1, source: "bot", slug },
    name,
    description,
    path: `skills/${slug}/SKILL.md`,
  };
}

const catalog = [
  entry("daily-standup", "Daily standup"),
  entry("standup-notes", "Standup notes"),
  entry("release", "Release", "Use this when cutting a release standup."),
  entry("weekly-report", "Weekly report"),
];

describe("the popover's ranking", () => {
  test("offers the whole catalog with no query", () => {
    const ranked = rankSkillCandidatesV1(catalog, "");
    expect(ranked).toHaveLength(4);
    expect(ranked.every((candidate) => candidate.rank === 0)).toBe(true);
  });

  test("ranks an exact slug above a prefix, a prefix above a substring, and a name above a description", () => {
    const ranked = rankSkillCandidatesV1(catalog, "standup");
    expect(ranked.map((candidate) => candidate.entry.ref)).toEqual([
      // exact slug is nothing here, so: prefix, then substring, then description
      "bot/standup-notes",
      "bot/daily-standup",
      "bot/release",
    ]);
  });

  test("matches case-insensitively and drops what does not match", () => {
    const ranked = rankSkillCandidatesV1(catalog, "WEEKLY");
    expect(ranked.map((candidate) => candidate.entry.ref)).toEqual([
      "bot/weekly-report",
    ]);
  });

  test("does not offer a Skill that is already attached", () => {
    const ranked = rankSkillCandidatesV1(catalog, "standup", {
      exclude: [{ schemaVersion: 1, source: "bot", slug: "standup-notes" }],
    });
    expect(ranked.map((candidate) => candidate.entry.ref)).not.toContain(
      "bot/standup-notes",
    );
  });
});

describe("reading the popover out of the composer", () => {
  test("opens on / and on @ at the start of the message", () => {
    expect(skillPopoverForV1("/stand", 6)).toEqual({
      trigger: "/",
      at: 0,
      query: "stand",
    });
    expect(skillPopoverForV1("@stand", 6)?.trigger).toBe("@");
  });

  test("opens after whitespace but not inside a word", () => {
    expect(skillPopoverForV1("write up /stand", 15)?.query).toBe("stand");
    // An email address or a path in prose is not a Skill picker.
    expect(skillPopoverForV1("tim@futuredirectors", 19)).toBeUndefined();
    expect(skillPopoverForV1("docs/architecture", 17)).toBeUndefined();
  });

  test("closes once whitespace follows the trigger", () => {
    expect(skillPopoverForV1("/stand up", 9)).toBeUndefined();
  });

  test("removes the trigger and its query on selection, keeping the rest", () => {
    const popover = skillPopoverForV1("morning /stand", 14)!;
    expect(textWithoutSkillTriggerV1("morning /stand", popover, 14)).toEqual({
      text: "morning ",
      caret: 8,
    });
  });
});

describe("the attached refs", () => {
  test("attaches up to three and refuses the fourth", () => {
    const store = new SkillAttachmentStore();
    expect(store.attach(catalog[0]!)).toBe(true);
    expect(store.attach(catalog[1]!)).toBe(true);
    expect(store.attach(catalog[2]!)).toBe(true);
    expect(store.full()).toBe(true);
    expect(store.attach(catalog[3]!)).toBe(false);
    expect(store.refs()).toHaveLength(3);
  });

  test("refuses the same Skill twice", () => {
    const store = new SkillAttachmentStore();
    expect(store.attach(catalog[0]!)).toBe(true);
    expect(store.attach(catalog[0]!)).toBe(false);
  });

  test("detaches by ref and hands the list over on submission", () => {
    const store = new SkillAttachmentStore();
    store.attach(catalog[0]!);
    store.attach(catalog[1]!);
    store.detach("bot/daily-standup");
    expect(store.take()).toEqual([
      { schemaVersion: 1, source: "bot", slug: "standup-notes" },
    ]);
    expect(store.attached()).toEqual([]);
  });

  test("gives the refs back when a submission is refused", () => {
    const store = new SkillAttachmentStore();
    store.attach(catalog[0]!);
    const held = [...store.attached()];
    store.take();
    store.restore(held);
    expect(store.refs()).toEqual([
      { schemaVersion: 1, source: "bot", slug: "daily-standup" },
    ]);
  });
});

describe("keyboard navigation", () => {
  test("wraps at both ends and stays at zero on an empty list", () => {
    expect(nextSkillHighlightV1(0, 3, 1)).toBe(1);
    expect(nextSkillHighlightV1(2, 3, 1)).toBe(0);
    expect(nextSkillHighlightV1(0, 3, -1)).toBe(2);
    expect(nextSkillHighlightV1(0, 0, 1)).toBe(0);
  });

  test("a refilter keeps the highlight on the Skill it was on", () => {
    const ranked = rankSkillCandidatesV1(catalog, "standup");
    // The composer refreshes the popover on every keyup, the arrow key's own
    // keyup included. Row two has to survive that refresh, or the highlight
    // snaps back to the first row and the arrow keys look dead.
    const highlighted = ranked[1]!.entry.ref;
    expect(keptSkillHighlightV1(highlighted, ranked)).toBe(1);
  });

  test("a narrower query keeps the highlight when the Skill is still offered", () => {
    const before = rankSkillCandidatesV1(catalog, "s");
    const highlighted = before.find(
      (candidate) => candidate.entry.ref === "bot/standup-notes",
    )!.entry.ref;
    const after = rankSkillCandidatesV1(catalog, "standup-n");
    expect(after.map((candidate) => candidate.entry.ref)).toContain(
      highlighted,
    );
    expect(keptSkillHighlightV1(highlighted, after)).toBe(
      after.findIndex((candidate) => candidate.entry.ref === highlighted),
    );
  });

  test("falls back to the first row once the highlighted Skill is gone", () => {
    const ranked = rankSkillCandidatesV1(catalog, "standup");
    expect(keptSkillHighlightV1("bot/weekly-report", ranked)).toBe(0);
    expect(keptSkillHighlightV1(undefined, ranked)).toBe(0);
  });

  test("an empty list has no highlight to keep", () => {
    expect(keptSkillHighlightV1("bot/daily-standup", [])).toBe(0);
  });
});
