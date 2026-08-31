// The audit table against two real Bot Durable Objects and one real User
// Durable Object, on real SQL storage.
//
// The claims, in order:
//
//  1. two Bots of one User settle Turns that use the Computer, and the audited
//     effects land in the *User* Durable Object, because "The User's Durable
//     Object is the authority for everything User-scoped";
//  2. the entries survive that object being evicted, because they are durable
//     state and not a resident cache;
//  3. archiving a Bot purges its entries;
//  4. an emptied table plus `rebuildAuditIndex()` reproduces the identical
//     set — the property that makes the table a projection rather than an
//     authority;
//  5. and no entry carries a credential, a full argument list, or `env`.
import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import type {
  AuditEntryV1,
  AuditRebuildReceiptV1,
} from "@frockbot/plugin-audit";
import type { FakeExecScript } from "./computer-host-fake.ts";
import { toolCallTriggerPrompt } from "./harness/miniflare.ts";
import { provisionBot, provisionSiblingBot } from "./provision-bot.ts";

/** `plugin-fly-sprite` reads the inner command's exit code off this marker. */
const EXEC_EXIT_MARKER = "__FROCKBOT_EXIT__";

interface AuditRpc {
  readAuditEntries(input: unknown): Promise<{
    entries: AuditEntryV1[];
    total: number;
    indexState: string;
  }>;
  rebuildAuditIndex(input: unknown): Promise<AuditRebuildReceiptV1>;
  executeBotLifecycle(input: unknown): Promise<{ status: string }>;
}

function userStub(userId: string) {
  return env.USER_CONFIGURATIONS.getByName(userId) as unknown as AuditRpc;
}

function botStub(userId: string, botId: string) {
  return env.BOT_STATES.getByName(`${userId}:${botId}`);
}

/** Teaches the shared fake Computer host how to answer one exec. */
async function script(rule: FakeExecScript): Promise<void> {
  const response = await env.COMPUTER_HOST.fetch(
    new Request("http://computer-host.internal/__fake/exec", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rule),
    }),
  );
  expect(response.status).toBe(200);
}

async function settleExecTurn(
  identity: { userId: string; botId: string },
  runId: string,
  command: string,
): Promise<void> {
  await botStub(identity.userId, identity.botId).run({
    schemaVersion: 1,
    ...identity,
    command: {
      runId,
      sessionId: `${identity.userId}:${identity.botId}`,
      acceptedAt: new Date().toISOString(),
      text: toolCallTriggerPrompt(["computer_exec", { command }]),
    },
  });
}

function readAudit(
  userId: string,
  query: Record<string, unknown> = {},
): Promise<{ entries: AuditEntryV1[]; total: number; indexState: string }> {
  return userStub(userId).readAuditEntries({
    schemaVersion: 1,
    userId,
    ...query,
  });
}

describe("the audit table in Workerd", () => {
  test("two Bots settle Computer Turns, and both audits land in the User Durable Object", async () => {
    const suffix = crypto.randomUUID();
    const userId = `audit-user-${suffix}`;
    const first = { userId, botId: `audit-bot-a-${suffix}` };
    const second = { userId, botId: `audit-bot-b-${suffix}` };
    const marker = `frockbot-audit-${suffix}`;
    await script({
      match: marker,
      stdout: `audited\n${EXEC_EXIT_MARKER}0\n`,
    });
    await provisionBot(first);
    await provisionSiblingBot(second, 1);

    // A credential in the command line, because that is the case that matters:
    // an audit row that carried it would be exactly the durable secret the
    // constitution forbids.
    const secret = "Bearer abcdefghijklmnopqrstuvwxyz0123";
    await settleExecTurn(
      first,
      "audit-run-1",
      `echo ${marker} # Authorization: ${secret}`,
    );
    await settleExecTurn(second, "audit-run-2", `echo ${marker} second`);

    const page = await readAudit(userId);
    expect(page.indexState).toBe("ready");
    expect(new Set(page.entries.map((entry) => entry.botId))).toEqual(
      new Set([first.botId, second.botId]),
    );
    expect(page.entries.every((entry) => entry.kind === "shell")).toBe(true);
    expect(page.entries.every((entry) => entry.target === "computer")).toBe(
      true,
    );
    // The occurrence id places every entry in a Turn, and doubles as the
    // effect id the Computer envelope carries.
    for (const entry of page.entries) {
      expect(entry.occurrenceId).toMatch(/^tool:\d+:\d+:\d+$/);
      expect(entry.effectId).toBe(entry.occurrenceId);
      expect(entry.argumentDigest).toMatch(/^[0-9a-f]{64}$/);
    }

    // NO SECRET IN DURABLE STATE. The whole page, as bytes.
    const wire = JSON.stringify(page.entries);
    expect(wire).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
    expect(wire).toContain("[redacted:bearer-token]");
    expect(wire).not.toContain("credentialRef");

    // THE TABLE IS DURABLE. It survives the User object being evicted.
    await evictDurableObject(env.USER_CONFIGURATIONS.getByName(userId));
    const afterEviction = await readAudit(userId);
    expect(new Set(afterEviction.entries.map((entry) => entry.runId))).toEqual(
      new Set(["audit-run-1", "audit-run-2"]),
    );

    // A REBUILD REPRODUCES IT, from the Bots' own stored runs.
    const receipt = await userStub(userId).rebuildAuditIndex({
      schemaVersion: 1,
      userId,
    });
    expect(receipt).toMatchObject({
      status: "rebuilt",
      indexState: "ready",
      hostJournalDiscrepancies: 0,
    });
    expect(receipt.entries).toBeGreaterThanOrEqual(2);
    const rebuilt = await readAudit(userId);
    expect(rebuilt.entries).toEqual(afterEviction.entries);

    // AND ARCHIVING PURGES.
    const lifecycle = await userStub(userId).executeBotLifecycle({
      schemaVersion: 1,
      userId,
      command: {
        schemaVersion: 1,
        type: "bot/archive",
        commandId: `audit-archive-${suffix}`,
        botId: second.botId,
      },
    });
    expect(lifecycle.status).toBe("applied");
    const afterArchive = await readAudit(userId);
    expect(new Set(afterArchive.entries.map((entry) => entry.botId))).toEqual(
      new Set([first.botId]),
    );
  });

  test("pages a filtered answer over two thousand rows on real SQL", async () => {
    // @ts-expect-error the probe is bound by this suite alone.
    const probe = env.AUDIT_PROBE.getByName(`paging-${crypto.randomUUID()}`);
    const outcome = await probe.paging(2_000);
    expect(outcome.total).toBe(2_000);
    // Half the rows are `shell`; the filter is applied in the table, so the
    // total the page reports is the filtered total and not the table's.
    expect(outcome.shellTotal).toBe(1_000);
    expect(outcome.walked).toBe(1_000);
    expect(outcome.duplicates).toBe(0);
    expect(outcome.pages).toBe(10);
    // Newest first, all the way down.
    expect(outcome.firstOccurrenceId).not.toBe(outcome.lastOccurrenceId);
  });

  test("evicts past the age bound and says so, whatever the row count", async () => {
    // @ts-expect-error the probe is bound by this suite alone.
    const probe = env.AUDIT_PROBE.getByName(`age-${crypto.randomUUID()}`);
    const outcome = await probe.ageEviction();
    // Four rows in, two of them older than 180 days. Retention is a promise
    // about time as well as about volume.
    expect(outcome.remaining).toBe(2);
    expect(outcome.oldestKept).toBe("aged 179");
    expect(outcome.state).toBe("truncated");
  });

  test("a User Durable Object refuses an audit read naming another User", async () => {
    const suffix = crypto.randomUUID();
    const mine = `audit-user-${suffix}`;
    const theirs = `audit-other-${suffix}`;
    await provisionBot({ userId: mine, botId: `audit-bot-${suffix}` });
    // Addressed as *this* User's object, and asked about another User. The
    // request agrees with itself, which is exactly why agreeing proves nothing.
    let refusal = "";
    try {
      await userStub(mine).readAuditEntries({
        schemaVersion: 1,
        userId: theirs,
      });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain("different User");
    await expect(readAudit(mine)).resolves.toMatchObject({ total: 0 });
  });
});
