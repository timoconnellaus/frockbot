import { describe, expect, test } from "bun:test";
import {
  fetchAccountVoicesV1,
  voiceCatalogAuditFailsV1,
  voiceCatalogAuditReportV1,
  voiceCatalogAuditV1,
} from "./check-voice-catalog.js";

const catalog = [
  { voiceId: "aaa", name: "Bec", description: "Australian." },
  { voiceId: "bbb", name: "Daniel", description: "British." },
];

describe("auditing the catalog against the account", () => {
  test("passes when every voice resolves and every character is mapped", () => {
    const audit = voiceCatalogAuditV1({
      catalog,
      byCharacter: { cow: "aaa", guardian: "bbb" },
      account: [
        { voiceId: "aaa", name: "Bec" },
        { voiceId: "bbb", name: "Daniel - Steady Broadcaster" },
      ],
    });
    expect(audit).toEqual({ missing: [], unmapped: [], renamed: [] });
    expect(voiceCatalogAuditFailsV1(audit)).toBe(false);
  });

  // The failure that shipped: ids copied from the provider's documentation
  // that this account cannot reach. It is silence, not an error, so nothing
  // else catches it.
  test("fails on a voice the account cannot reach", () => {
    const audit = voiceCatalogAuditV1({
      catalog,
      byCharacter: { cow: "aaa", guardian: "bbb" },
      account: [{ voiceId: "aaa", name: "Bec" }],
    });
    expect(audit.missing).toEqual([
      { voiceId: "bbb", name: "Daniel", description: "British." },
    ]);
    expect(voiceCatalogAuditFailsV1(audit)).toBe(true);
    expect(voiceCatalogAuditReportV1(audit)).toContain("speak silence");
  });

  test("fails on a character pointing outside the catalog", () => {
    const audit = voiceCatalogAuditV1({
      catalog,
      byCharacter: { cow: "aaa", rabbit: "zzz" },
      account: [
        { voiceId: "aaa", name: "Bec" },
        { voiceId: "bbb", name: "Daniel" },
        { voiceId: "zzz", name: "Somebody" },
      ],
    });
    expect(audit.unmapped).toEqual(["rabbit"]);
    expect(voiceCatalogAuditFailsV1(audit)).toBe(true);
  });

  // The other half of what shipped: EXAVITQu4vr4xnSDxMaL was listed as
  // "Bella" and is Sarah. The voice speaks, so this is reported rather than
  // fatal — but a picker offering the wrong name is still wrong.
  test("reports a name that has drifted from the account, without failing", () => {
    const audit = voiceCatalogAuditV1({
      catalog,
      byCharacter: { cow: "aaa", guardian: "bbb" },
      account: [
        { voiceId: "aaa", name: "Sarah - Mature, Reassuring" },
        { voiceId: "bbb", name: "Daniel" },
      ],
    });
    expect(audit.renamed).toEqual([
      { voiceId: "aaa", ours: "Bec", theirs: "Sarah - Mature, Reassuring" },
    ]);
    expect(voiceCatalogAuditFailsV1(audit)).toBe(false);
    expect(voiceCatalogAuditReportV1(audit)).toContain('"Bec" here');
  });

  // Ours is the short name the picker shows. The account writes both a
  // descriptive tail and a surname, and both are the same person, so neither
  // may be reported as drift every single run — a check that always prints
  // something is a check nobody reads.
  test("accepts the account's descriptive tail and its surname", () => {
    const audit = voiceCatalogAuditV1({
      catalog,
      byCharacter: {},
      account: [
        { voiceId: "aaa", name: "Bec Pike" },
        { voiceId: "bbb", name: "Daniel - Warm, Captivating Storyteller" },
      ],
    });
    expect(audit.renamed).toEqual([]);
  });

  // A prefix has to end at a word boundary, or "Bec" would silently accept a
  // voice the account calls "Beckett", who is somebody else.
  test("does not accept a name that merely starts with the same letters", () => {
    const audit = voiceCatalogAuditV1({
      catalog,
      byCharacter: {},
      account: [
        { voiceId: "aaa", name: "Beckett" },
        { voiceId: "bbb", name: "Daniel" },
      ],
    });
    expect(audit.renamed).toEqual([
      { voiceId: "aaa", ours: "Bec", theirs: "Beckett" },
    ]);
  });
});

describe("reading the account's voices", () => {
  test("follows pagination and keeps every page", async () => {
    const pages = [
      { voices: [{ voice_id: "aaa", name: "Bec" }], has_more: true },
      { voices: [{ voice_id: "bbb", name: "Daniel" }], has_more: false },
    ];
    const asked: string[] = [];
    const voices = await fetchAccountVoicesV1("key", (async (url: string) => {
      asked.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => pages[asked.length - 1],
      };
    }) as unknown as typeof fetch);
    expect(voices).toEqual([
      { voiceId: "aaa", name: "Bec" },
      { voiceId: "bbb", name: "Daniel" },
    ]);
    expect(asked).toHaveLength(2);
  });

  // A key without voices_read returns 401, which must not read as "the
  // account has no voices" and quietly fail every id in the catalog.
  test("refuses to treat a rejected key as an empty account", async () => {
    await expect(
      fetchAccountVoicesV1("key", (async () => ({
        ok: false,
        status: 401,
        json: async () => ({}),
      })) as unknown as typeof fetch),
    ).rejects.toThrow("voices_read");
  });
});
