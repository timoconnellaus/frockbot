// A person's answer to an approval opens the Turn that acts on it.
//
// The Bot ends its Turn to ask, so without this the answer sat in the pending
// queue until the person spoke again: they approved a Plugin and had to ask
// "is it done?" before the Bot said anything.
import { describe, expect, test } from "bun:test";
import type { OwnedBotTurnCommand } from "@frockbot/core/durable";
import {
  approvalKeyV1,
  type ApprovalRecordV1,
} from "@frockbot/app/shell/approvals";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import { createMemoryRoutineStorageV1 } from "../routines/testing.js";
import { INPUT_DELIVERY_CUE_V1 } from "../routines/inbox.js";
import { inputDeliveryRunIdV1 } from "../shell/input-delivery.js";
import { cardApprovalBindingKeyV1 } from "@frockbot/app/shell/cards";
import {
  ApprovalRevisionConflictError,
  decideApproval,
  expireDueApprovals,
} from "./bot.js";

const IDENTITY = { userId: "user-1", botId: "bot-1" };

function pending(
  approvalId: string,
  expiresAt = "2099-01-01T00:00:00.000Z",
  runId = "ask-1",
): ApprovalRecordV1 {
  return {
    schemaVersion: 1,
    approvalId,
    runId,
    sessionId: "user-1:bot-1",
    action: "Send the email",
    risk: "medium",
    createdAt: "2026-09-23T10:00:00.000Z",
    expiresAt,
    decision: "pending",
    decidedBy: "pending",
  };
}

async function harness(
  approvals: ApprovalRecordV1[],
  admit: (command: OwnedBotTurnCommand) => Promise<unknown> = (command) =>
    Promise.resolve({ runId: command.runId, state: "running" }),
) {
  const storage = createMemoryRoutineStorageV1();
  for (const approval of approvals) {
    await storage.put(approvalKeyV1(approval.approvalId), approval);
  }
  const admitted: OwnedBotTurnCommand[] = [];
  const headers = new Map<string, unknown>();
  // SAFETY: deciding reads the approval records and the pending queue, and
  // opening the Turn reaches only the authority's admission and run headers;
  // the User's Composition is unreachable here, which the sync tolerates.
  const state = {
    ctx: { storage },
    env: {},
    authority: {
      validateIdentity: () => Promise.resolve(),
      readRunHeader: (runId: string) => Promise.resolve(headers.get(runId)),
      admit: (command: OwnedBotTurnCommand) => {
        admitted.push(command);
        return admit(command);
      },
    },
  } as unknown as ShellBotStateV1;
  return { state, storage, admitted, headers };
}

async function approvalRunId(runId: string, approvalId: string) {
  return inputDeliveryRunIdV1(`approval\u0000${runId}\u0000${approvalId}`);
}

describe("the Turn a decision opens", () => {
  test("a person's answer admits one chat Turn that queues behind any other", async () => {
    const { state, admitted } = await harness([pending("ap-1")]);

    const receipt = await decideApproval(state, IDENTITY, "ap-1", {
      schemaVersion: 1,
      decision: "approved",
    });

    expect(receipt.status).toBe("recorded");
    expect(admitted).toHaveLength(1);
    expect(admitted[0]).toMatchObject({
      userId: "user-1",
      botId: "bot-1",
      runId: await approvalRunId("ask-1", "ap-1"),
      sessionId: "user-1:bot-1",
      text: INPUT_DELIVERY_CUE_V1,
      turnType: "chat",
      lane: "agent",
      origin: { kind: "input-delivery", inputId: "ap-1" },
    });
  });

  test("a denial opens one too, so the Bot can say it will not", async () => {
    const { state, admitted } = await harness([pending("ap-1")]);

    await decideApproval(state, IDENTITY, "ap-1", {
      schemaVersion: 1,
      decision: "denied",
    });

    expect(admitted.map((command) => command.origin)).toEqual([
      { kind: "input-delivery", inputId: "ap-1" },
    ]);
  });

  test("a replayed answer opens nothing more", async () => {
    const { state, admitted } = await harness([pending("ap-1")]);
    await decideApproval(state, IDENTITY, "ap-1", {
      schemaVersion: 1,
      decision: "approved",
    });

    const replayed = await decideApproval(state, IDENTITY, "ap-1", {
      schemaVersion: 1,
      decision: "denied",
    });

    expect(replayed.status).toBe("replayed");
    expect(admitted).toHaveLength(1);
  });

  test("a Turn that cannot be admitted leaves the decision recorded and queued", async () => {
    const { state, storage, admitted } = await harness([pending("ap-1")], () =>
      Promise.reject(new Error("bot agent queue is full")),
    );

    const receipt = await decideApproval(state, IDENTITY, "ap-1", {
      schemaVersion: 1,
      decision: "approved",
    });

    expect(admitted).toHaveLength(1);
    expect(receipt).toMatchObject({
      status: "recorded",
      approval: { decision: "approved" },
    });
    const queued = [
      ...(
        await storage.list<{ kind: string }>({ prefix: "routine-wake:" })
      ).values(),
    ];
    expect(queued).toContainEqual(
      expect.objectContaining({ kind: "approval", approvalId: "ap-1" }),
    );
  });

  test("an expiry opens nothing: nobody answered", async () => {
    const { state, admitted } = await harness([
      pending("ap-stale", "2020-01-01T00:00:00.000Z"),
    ]);

    await expireDueApprovals(state);

    expect(admitted).toEqual([]);
  });

  test("an approval id a later Turn reuses gets a Turn of its own", async () => {
    const first = await harness([pending("ap-1", undefined, "ask-1")]);
    const later = await harness([pending("ap-1", undefined, "ask-2")]);
    for (const { state } of [first, later]) {
      await decideApproval(state, IDENTITY, "ap-1", {
        schemaVersion: 1,
        decision: "approved",
      });
    }

    expect(first.admitted[0]?.runId).toBe(await approvalRunId("ask-1", "ap-1"));
    expect(later.admitted[0]?.runId).toBe(await approvalRunId("ask-2", "ap-1"));
    expect(first.admitted[0]?.runId).not.toBe(later.admitted[0]?.runId);
  });
});

/**
 * What a person changed on a Plugin's card before approving it (ADR 0030,
 * amended 2026-09-24). The binding the card's decision is held to moves to
 * the edited values in the transaction that records the decision, and not
 * one write earlier or later.
 */
describe("a decision on an edited card", () => {
  const SURFACE = "email_draft.0123456789abcdef";

  async function bound(digest = "digest-drawn") {
    const subject = await harness([pending("ap-1")]);
    await subject.storage.put(cardApprovalBindingKeyV1("email", SURFACE), {
      schemaVersion: 1,
      pluginId: "email",
      surfaceId: SURFACE,
      digest,
      approvalIds: ["ap-1"],
      createdAt: "2026-09-23T10:00:00.000Z",
    });
    return subject;
  }

  const revision = {
    pluginId: "email",
    surfaceId: SURFACE,
    from: "digest-drawn",
    digest: "digest-edited",
    wording: {
      action: "Send an email to ana@example.com — Their subject",
      risk: "medium" as const,
    },
  };

  test("binds the decision to what the person sent, in the words it now says", async () => {
    const { state, storage } = await bound();
    const receipt = await decideApproval(
      state,
      IDENTITY,
      "ap-1",
      { schemaVersion: 1, decision: "approved" },
      revision,
    );
    expect(receipt).toMatchObject({
      status: "recorded",
      approval: {
        decision: "approved",
        action: "Send an email to ana@example.com — Their subject",
      },
    });
    expect(
      await storage.get(cardApprovalBindingKeyV1("email", SURFACE)),
    ).toMatchObject({ digest: "digest-edited", approvalIds: ["ap-1"] });
  });

  test("a binding that moved since the Plugin was asked refuses, writing nothing", async () => {
    const { state, storage, admitted } = await bound("digest-someone-else");
    await expect(
      decideApproval(
        state,
        IDENTITY,
        "ap-1",
        { schemaVersion: 1, decision: "approved" },
        revision,
      ),
    ).rejects.toBeInstanceOf(ApprovalRevisionConflictError);
    expect(await storage.get(approvalKeyV1("ap-1"))).toMatchObject({
      decision: "pending",
      action: "Send the email",
    });
    expect(
      await storage.get(cardApprovalBindingKeyV1("email", SURFACE)),
    ).toMatchObject({ digest: "digest-someone-else" });
    expect(admitted).toEqual([]);
  });

  test("an answer already given is read back, and the edit moves nothing", async () => {
    const { state, storage } = await bound();
    await decideApproval(state, IDENTITY, "ap-1", {
      schemaVersion: 1,
      decision: "approved",
    });
    const replayed = await decideApproval(
      state,
      IDENTITY,
      "ap-1",
      { schemaVersion: 1, decision: "approved" },
      revision,
    );
    expect(replayed).toMatchObject({
      status: "replayed",
      approval: { action: "Send the email" },
    });
    expect(
      await storage.get(cardApprovalBindingKeyV1("email", SURFACE)),
    ).toMatchObject({ digest: "digest-drawn" });
  });
});
