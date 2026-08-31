import { describe, expect, test } from "bun:test";
import {
  decodeSkillRefV1,
  decodeSkillRefsV1,
  formatSkillRefV1,
  MAX_INVOKED_SKILLS_V1,
  parseSkillRefV1,
} from "./skills.js";

describe("a Skill ref crossing a seam", () => {
  test("round-trips its canonical string form for every source", () => {
    const refs = [
      { schemaVersion: 1 as const, source: "bot" as const, slug: "standup" },
      { schemaVersion: 1 as const, source: "user" as const, slug: "standup" },
      { schemaVersion: 1 as const, source: "managed" as const, slug: "teach" },
      {
        schemaVersion: 1 as const,
        source: "plugin" as const,
        slug: "compose",
        packageId: "composio",
      },
    ];
    expect(refs.map(formatSkillRefV1)).toEqual([
      "bot/standup",
      "user/standup",
      "managed/teach",
      "plugin/composio/compose",
    ]);
    for (const ref of refs) {
      expect(parseSkillRefV1(formatSkillRefV1(ref))).toEqual(ref);
    }
  });

  test("admits every declared source, so K1 and K2 add no wire change", () => {
    for (const source of ["bot", "user", "managed", "plugin"] as const) {
      const ref = decodeSkillRefV1({
        schemaVersion: 1,
        source,
        slug: "standup",
        ...(source === "plugin" ? { packageId: "composio" } : {}),
      });
      expect(ref.source).toBe(source);
    }
  });

  test("refuses an unknown source", () => {
    expect(() =>
      decodeSkillRefV1({ schemaVersion: 1, source: "workflow", slug: "s" }),
    ).toThrow(/source is invalid/u);
  });

  test("refuses an unknown field rather than carrying it into durable state", () => {
    expect(() =>
      decodeSkillRefV1({
        schemaVersion: 1,
        source: "bot",
        slug: "standup",
        body: "do the thing",
      }),
    ).toThrow(/unknown fields/u);
  });

  test("refuses a packageId on a source that has no Package", () => {
    expect(() =>
      decodeSkillRefV1({
        schemaVersion: 1,
        source: "bot",
        slug: "standup",
        packageId: "composio",
      }),
    ).toThrow(/only valid on a plugin Skill/u);
  });

  test("requires a packageId on a plugin Skill", () => {
    expect(() =>
      decodeSkillRefV1({ schemaVersion: 1, source: "plugin", slug: "compose" }),
    ).toThrow(/packageId is invalid/u);
  });

  test("refuses a malformed slug and a wrong schema version", () => {
    expect(() =>
      decodeSkillRefV1({ schemaVersion: 1, source: "bot", slug: "Standup" }),
    ).toThrow(/slug is invalid/u);
    expect(() =>
      decodeSkillRefV1({ schemaVersion: 2, source: "bot", slug: "standup" }),
    ).toThrow(/schemaVersion is invalid/u);
  });

  test("reads no ref out of a string that is not one", () => {
    for (const value of ["bot", "bot/", "/standup", "plugin/standup", 7]) {
      expect(parseSkillRefV1(value)).toBeUndefined();
    }
  });
});

describe("the list one Turn invokes", () => {
  const ref = (slug: string) => ({
    schemaVersion: 1 as const,
    source: "bot" as const,
    slug,
  });

  test("admits up to the bound", () => {
    const refs = ["a", "b", "c"].map(ref);
    expect(decodeSkillRefsV1(refs)).toHaveLength(MAX_INVOKED_SKILLS_V1);
  });

  test("refuses more than the bound", () => {
    expect(() => decodeSkillRefsV1(["a", "b", "c", "d"].map(ref))).toThrow(
      /at most 3 Skills/u,
    );
  });

  test("refuses the same Skill twice", () => {
    expect(() => decodeSkillRefsV1([ref("a"), ref("a")])).toThrow(
      /more than once/u,
    );
  });

  test("refuses a value that is not an array", () => {
    expect(() => decodeSkillRefsV1(ref("a"))).toThrow(/must be an array/u);
  });
});
