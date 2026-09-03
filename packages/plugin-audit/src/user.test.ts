import { describe, expect, test } from "bun:test";
import { AuditUserBackendContribution, resolveAuditTargetV1 } from "./user.ts";
import { FakeAuditSql } from "./testing.ts";
import type { AuditEntryV1 } from "./shared.ts";

function entry(overrides: Partial<AuditEntryV1> = {}): AuditEntryV1 {
  const occurrenceId = overrides.occurrenceId ?? "tool:1:1:0";
  const [, turn, step, ordinal] = /^tool:(\d+):(\d+):(\d+)$/.exec(
    occurrenceId,
  )!;
  return {
    schemaVersion: 1,
    botId: "foreman",
    runId: "run-1",
    occurrenceId,
    turn: Number(turn),
    step: Number(step),
    ordinal: Number(ordinal),
    effectId: occurrenceId,
    at: "2026-08-31T00:00:00.000Z",
    kind: "shell",
    target: "computer",
    toolName: "computer_exec",
    argumentDigest: "a".repeat(64),
    preview: "ls -la",
    outcome: "ok",
    ...overrides,
  };
}

function contribution(
  options: {
    entries?: AuditEntryV1[];
    hosts?: Map<string, string>;
    journal?: string[];
  } = {},
) {
  return new AuditUserBackendContribution({
    sql: new FakeAuditSql(),
    readDirectory: async () => ({ botIds: ["foreman"] }),
    projectBotEntries: async (botId, cursor) => ({
      schemaVersion: 1,
      botId,
      entries: cursor ? [] : (options.entries ?? []),
    }),
    ...(options.hosts ? { readMcpHosts: async () => options.hosts! } : {}),
    ...(options.journal
      ? { readHostJournalEffectIds: async () => options.journal! }
      : {}),
  });
}

describe("resolving an MCP target against the Connection registry", () => {
  test("turns the Connection slug into the server's host", () => {
    const hosts = new Map([["example", "mcp.example.test"]]);
    expect(resolveAuditTargetV1("remote:example", hosts)).toBe(
      "remote:mcp.example.test",
    );
    // A slug the registry does not know stays a slug. That is a less specific
    // row, not a wrong one — better than claiming a host nobody can vouch for.
    expect(resolveAuditTargetV1("remote:beeper", hosts)).toBe("remote:beeper");
    // Everything else is complete as the classifier wrote it.
    expect(resolveAuditTargetV1("computer", hosts)).toBe("computer");
    expect(resolveAuditTargetV1("machine:mac-1", hosts)).toBe("machine:mac-1");
  });

  test("is applied on the projection path and the rebuild path alike", async () => {
    const hosts = new Map([["example", "mcp.example.test"]]);
    const mcp = entry({
      occurrenceId: "tool:1:1:1",
      kind: "mcp",
      target: "remote:example",
      toolName: "mcp__example__echo",
    });
    const audit = contribution({ entries: [mcp], hosts });
    await audit.indexAuditEntries([mcp]);
    expect(audit.query({}).entries.map((row) => row.target)).toEqual([
      "remote:mcp.example.test",
    ]);
    // The rebuild reads the same unresolved rows back out of the Bot and must
    // land on the identical target, or the table would change under a repair.
    await audit.rebuildAuditIndex();
    expect(audit.query({}).entries.map((row) => row.target)).toEqual([
      "remote:mcp.example.test",
    ]);
  });
});

describe("the User Contribution", () => {
  test("refuses anything that is not a bounded array of entries", async () => {
    const audit = contribution();
    await expect(audit.indexAuditEntries({})).rejects.toThrow("an array");
    await expect(
      audit.indexAuditEntries(Array.from({ length: 513 }, () => entry())),
    ).rejects.toThrow("bound");
  });

  test("quarantines one undecodable entry and indexes the rest", async () => {
    const audit = contribution();

    // The page carries one entry whose `turn` disagrees with its occurrence id
    // — reachable in production through the tool-name length and slug mismatch
    // between the classifier and the wire codec.
    const receipt = await audit.indexAuditEntries([
      entry(),
      { ...entry(), turn: 7 },
    ]);

    // Before this, the whole page threw. The throw was swallowed at the Bot's
    // drain, the outbox was never drained again, and every later entry was
    // dropped at the 512 bound: one malformed row cost the Bot its whole audit
    // trail, silently.
    expect(receipt).toEqual({ indexed: 1, quarantined: 1 });
    expect(audit.query({}).entries).toHaveLength(1);
  });

  test("counts host-journal discrepancies without writing them in", async () => {
    const known = entry();
    const audit = contribution({
      entries: [known],
      // The host claims an effect no session event accounts for. The host is
      // non-authoritative, so this is a number a person is shown — never a row.
      journal: [known.effectId, "tool:9:9:9"],
    });
    await audit.indexAuditEntries([known]);
    const receipt = await audit.rebuildAuditIndex();
    expect(receipt).toMatchObject({
      status: "rebuilt",
      entries: 1,
      hostJournalDiscrepancies: 1,
      unknownOutcomes: 0,
    });
    expect(audit.query({}).entries.map((row) => row.effectId)).toEqual([
      known.effectId,
    ]);
  });

  test("counts outcomes the durable log cannot explain", async () => {
    const unknown = entry({ occurrenceId: "tool:1:1:2", outcome: "unknown" });
    const audit = contribution({ entries: [entry(), unknown] });
    const receipt = await audit.rebuildAuditIndex();
    expect(receipt.entries).toBe(2);
    expect(receipt.unknownOutcomes).toBe(1);
  });

  test("purges one Bot, and answers its own state", async () => {
    const audit = contribution();
    await audit.indexAuditEntries([entry(), entry({ botId: "scheduler" })]);
    expect(audit.state()).toBe("ready");
    expect(audit.purgeAuditForBot("foreman")).toEqual({ removed: 1 });
    expect(audit.query({}).entries.map((row) => row.botId)).toEqual([
      "scheduler",
    ]);
  });
});
