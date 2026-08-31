// The approval record: what a Turn writes, what a decision may say, and how
// long a question may go unanswered.
import { describe, expect, test } from "bun:test";
import {
  approvalExpiresAtV1,
  approvalKeyV1,
  approvalNotificationBodyV1,
  approvalSendsV1,
  approvalTerminalRecordsV1,
  decodeApprovalDecisionCommandV1,
  decodeApprovalListViewV1,
  decodeApprovalRecordV1,
  projectApprovalCardV1,
  trimmableApprovalKeysV1,
  APPROVAL_DEFAULT_EXPIRY_SECONDS,
  APPROVAL_MAX_EXPIRY_SECONDS,
  APPROVAL_MIN_EXPIRY_SECONDS,
  APPROVAL_RETENTION_LIMIT,
  type ApprovalRecordV1,
} from "./approvals.js";

const NOW = "2026-08-31T00:00:00.000Z";

function send(overrides: Record<string, unknown> = {}) {
  return {
    type: "send/to-user",
    payload: {
      type: "approval",
      approvalId: "ap-1",
      action: "Delete the staging database",
      risk: "high",
      ...overrides,
    },
  };
}

function record(overrides: Partial<ApprovalRecordV1> = {}): ApprovalRecordV1 {
  return {
    schemaVersion: 1,
    approvalId: "ap-1",
    runId: "run-1",
    sessionId: "user-1:bot-1",
    action: "Delete the staging database",
    risk: "high",
    createdAt: NOW,
    expiresAt: approvalExpiresAtV1(NOW),
    decision: "pending",
    decidedBy: "pending",
    ...overrides,
  };
}

describe("the expiry window", () => {
  test("defaults to a day and clamps a Bot's request to five minutes and a week", () => {
    const day = Date.parse(approvalExpiresAtV1(NOW)) - Date.parse(NOW);
    expect(day).toBe(APPROVAL_DEFAULT_EXPIRY_SECONDS * 1_000);
    // A card that expires before anyone could reach it is a refusal dressed as
    // a question, so a one-second window becomes the floor.
    expect(Date.parse(approvalExpiresAtV1(NOW, 1)) - Date.parse(NOW)).toBe(
      APPROVAL_MIN_EXPIRY_SECONDS * 1_000,
    );
    expect(
      Date.parse(approvalExpiresAtV1(NOW, 400 * 24 * 60 * 60)) -
        Date.parse(NOW),
    ).toBe(APPROVAL_MAX_EXPIRY_SECONDS * 1_000);
    // Inside the range the Bot's own number survives untouched.
    expect(Date.parse(approvalExpiresAtV1(NOW, 3_600)) - Date.parse(NOW)).toBe(
      3_600_000,
    );
  });

  test("refuses a createdAt that is not a timestamp", () => {
    expect(() => approvalExpiresAtV1("whenever")).toThrow("not a timestamp");
  });
});

describe("the records a settled Turn writes", () => {
  test("one pending record per approval send, keyed by the Bot's own id", async () => {
    const records = await approvalTerminalRecordsV1({
      run: {
        runId: "run-1",
        sessionId: "user-1:bot-1",
        events: [
          { type: "assistant/message" },
          send(),
          send({ approvalId: "ap-2", action: "Restart the host", risk: "low" }),
        ],
      },
      now: NOW,
      read: () => Promise.resolve(undefined),
    });

    expect(Object.keys(records).sort()).toEqual([
      approvalKeyV1("ap-1"),
      approvalKeyV1("ap-2"),
    ]);
    const first = decodeApprovalRecordV1(records[approvalKeyV1("ap-1")]);
    expect(first).toMatchObject({
      approvalId: "ap-1",
      runId: "run-1",
      sessionId: "user-1:bot-1",
      decision: "pending",
      decidedBy: "pending",
      risk: "high",
    });
    expect(first.expiresAt).toBe(approvalExpiresAtV1(NOW));
  });

  test("a Turn with no approval send writes nothing", async () => {
    expect(
      await approvalTerminalRecordsV1({
        run: {
          runId: "run-1",
          sessionId: "s",
          events: [
            { type: "send/to-user", payload: { type: "text" } } as never,
          ],
        },
        now: NOW,
        read: () => Promise.resolve(undefined),
      }),
    ).toEqual({});
  });

  test("a re-settled Turn leaves a decision somebody already made alone", async () => {
    const decided = record({ decision: "approved", decidedBy: "user" });
    const records = await approvalTerminalRecordsV1({
      run: { runId: "run-1", sessionId: "s", events: [send()] },
      now: NOW,
      // A recovered Turn re-reads its own log; the record it would write is
      // already there, and overwriting it would erase the answer.
      read: <T>(key: string) =>
        Promise.resolve(
          (key === approvalKeyV1("ap-1") ? decided : undefined) as
            T | undefined,
        ),
    });

    expect(records).toEqual({});
  });

  test("the same card sent twice in one Turn is one decision", () => {
    expect(
      approvalSendsV1([send(), send({ action: "Delete it, really" })]).map(
        (asked) => asked.action,
      ),
    ).toEqual(["Delete the staging database"]);
  });
});

describe("the codecs", () => {
  test("a record round-trips and refuses an unexpected key", () => {
    const stored = record();
    expect(decodeApprovalRecordV1(stored)).toEqual(stored);
    expect(() =>
      decodeApprovalRecordV1({ ...stored, decidedBy: "somebody" }),
    ).toThrow("decidedBy");
    expect(() =>
      decodeApprovalRecordV1({ ...stored, decision: "maybe" }),
    ).toThrow("decision");
    expect(() => decodeApprovalRecordV1({ ...stored, extra: 1 })).toThrow(
      'unexpected key "extra"',
    );
    const { expiresAt: _expiresAt, ...withoutExpiry } = stored;
    expect(() => decodeApprovalRecordV1(withoutExpiry)).toThrow(
      'missing "expiresAt"',
    );
  });

  test("a decision command carries exactly one of two answers", () => {
    expect(
      decodeApprovalDecisionCommandV1({ schemaVersion: 1, decision: "denied" }),
    ).toEqual({ schemaVersion: 1, decision: "denied" });
    // Expiry is what the clock does, never what a person submits.
    expect(() =>
      decodeApprovalDecisionCommandV1({
        schemaVersion: 1,
        decision: "expired",
      }),
    ).toThrow("approved or denied");
    expect(() =>
      decodeApprovalDecisionCommandV1({
        schemaVersion: 1,
        decision: "approved",
        approvalId: "ap-1",
      }),
    ).toThrow('unexpected key "approvalId"');
  });

  test("a listing round-trips through its own decoder", () => {
    const view = {
      schemaVersion: 1 as const,
      botId: "bot-1",
      approvals: [projectApprovalCardV1(record())],
      pending: 1,
    };

    expect(decodeApprovalListViewV1(view)).toEqual(view);
    // The projection never carries the session the Turn ran in.
    expect(Object.keys(view.approvals[0]!).includes("sessionId")).toBe(false);
  });
});

describe("retention", () => {
  test("nothing is trimmed under the bound, and the oldest go over it", () => {
    const keys = Array.from({ length: APPROVAL_RETENTION_LIMIT + 3 }, (_, i) =>
      approvalKeyV1(`ap-${String(i).padStart(4, "0")}`),
    );

    expect(trimmableApprovalKeysV1(keys.slice(0, 3))).toEqual([]);
    expect(trimmableApprovalKeysV1(keys)).toEqual(keys.slice(0, 3));
  });

  test("a high-risk notification body says so before it says what", () => {
    expect(approvalNotificationBodyV1(send().payload as never)).toBe(
      "High risk. Delete the staging database",
    );
    expect(
      approvalNotificationBodyV1(
        send({ risk: "low", action: "Rename a file" }).payload as never,
      ),
    ).toBe("Rename a file");
  });
});
