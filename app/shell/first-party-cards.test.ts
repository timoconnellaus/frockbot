/**
 * The seam that maps an old `send_to_user` member onto the locked Plugin that
 * draws it (ADR 0030 step 7).
 *
 * Two properties matter here and nothing else does. The mapping carries the
 * payload's values and decides nothing — a second place the meaning of a send
 * lived would be the bug this step exists to remove. And a draw that could not
 * happen is *nothing*: the send stays exactly as it was recorded, because a
 * card is a face and a face that could not be drawn must not become a second
 * message in the conversation.
 */
import { describe, expect, test } from "bun:test";
import type {
  FirstPartyCardDrawsV1,
  SendToUserPayloadV1,
  ToolExecutionContext,
} from "@frockbot/core/contracts";
import {
  drawFirstPartyCardV1,
  firstPartyCardDrawV1,
  FIRST_PARTY_CARD_MEMBERS_V1,
  isFirstPartyCardMemberV1,
} from "./first-party-cards.ts";

const context = { sessionId: "user-1:bot-1", effectId: "tool:1:1:0" } as never;

const approval: SendToUserPayloadV1 = {
  type: "approval",
  approvalId: "ap-1",
  action: "Run the migration",
  risk: "medium",
};

function drawsInto(record: unknown[]): FirstPartyCardDrawsV1 {
  return {
    draw: (request) => {
      record.push(request);
      return Promise.resolve({
        status: "drawn" as const,
        surfaceId: "approvals_decision.abc",
      });
    },
  };
}

describe("the first-party card mapping", () => {
  test("names the five members and nothing else", () => {
    expect([...FIRST_PARTY_CARD_MEMBERS_V1].toSorted()).toEqual([
      "agent-card",
      "approval",
      "attachment",
      "secret-request",
      "widget",
    ]);
    expect(isFirstPartyCardMemberV1("text")).toBe(false);
    expect(isFirstPartyCardMemberV1("card")).toBe(false);
    for (const member of FIRST_PARTY_CARD_MEMBERS_V1) {
      expect(isFirstPartyCardMemberV1(member)).toBe(true);
    }
  });

  test("a payload that draws no card asks for no draw", async () => {
    for (const payload of [
      { type: "text", text: "hi" },
    ] satisfies SendToUserPayloadV1[]) {
      expect(firstPartyCardDrawV1(payload)).toBeUndefined();
      const drawn: unknown[] = [];
      expect(
        await drawFirstPartyCardV1(drawsInto(drawn), payload, context),
      ).toEqual({});
      expect(drawn).toEqual([]);
    }
  });

  test("an approval is bound to the decision the log already holds", async () => {
    const request = firstPartyCardDrawV1(approval)!;
    expect(request.pluginId).toBe("approvals");
    expect(request.cardId).toBe("decision");
    // The kernel's own id, not a minted one: the Bot's Machine command, its
    // Plugin intent and its next Turn's durable input are all keyed by it.
    expect(request.approvalIds).toEqual(["ap-1"]);
    expect(request.data).toEqual({
      action: "Run the migration",
      risk: "medium",
    });
    // An absent rationale is absent, never an empty string: the card's schema
    // refuses what it does not declare, and "" is not "nothing said".
    expect(Object.keys(request.data)).not.toContain("rationale");
  });

  test("every other member carries its own values and no decision", () => {
    expect(
      firstPartyCardDrawV1({
        type: "attachment",
        url: "https://example.com/a.pdf",
        name: "a",
      }),
    ).toMatchObject({
      pluginId: "attachments",
      cardId: "file",
      data: { url: "https://example.com/a.pdf", name: "a" },
    });
    expect(
      firstPartyCardDrawV1({
        type: "widget",
        widget: { prompt: "Which?", options: ["A", "B"] },
      }),
    ).toMatchObject({
      pluginId: "questions",
      data: { prompt: "Which?", options: ["A", "B"] },
    });
    expect(
      firstPartyCardDrawV1({
        type: "secret-request",
        prompt: "Key?",
        secretName: "K",
      }),
    ).toMatchObject({ pluginId: "credentials", data: { secretName: "K" } });
    expect(
      firstPartyCardDrawV1({
        type: "agent-card",
        agentId: "bot-2",
        title: "Staged",
      }),
    ).toMatchObject({ pluginId: "agents", data: { agentId: "bot-2" } });
    for (const member of ["attachment", "widget", "secret-request"] as const) {
      const payload =
        member === "widget"
          ? ({
              type: "widget",
              widget: { prompt: "p", options: ["a"] },
            } satisfies SendToUserPayloadV1)
          : member === "attachment"
            ? ({
                type: "attachment",
                url: "https://example.com/a",
              } satisfies SendToUserPayloadV1)
            : ({
                type: "secret-request",
                prompt: "p",
                secretName: "K",
              } satisfies SendToUserPayloadV1);
      expect(firstPartyCardDrawV1(payload)!.approvalIds).toBeUndefined();
    }
  });

  test("a draw that landed answers with its surface", async () => {
    const drawn: unknown[] = [];
    expect(
      await drawFirstPartyCardV1(drawsInto(drawn), approval, context),
    ).toEqual({ surfaceId: "approvals_decision.abc" });
    expect(drawn).toHaveLength(1);
  });

  test("a host that draws no cards, a refusal and a throw are all nothing", async () => {
    expect(await drawFirstPartyCardV1(undefined, approval, context)).toEqual(
      {},
    );
    expect(
      await drawFirstPartyCardV1(
        {
          draw: () =>
            Promise.resolve({
              status: "unavailable" as const,
              reason: "the plugin did not mount",
            }),
        },
        approval,
        context,
      ),
    ).toEqual({});
    // A Plugin worker that is simply gone must not be how an approval fails:
    // the decision is already on the log and a person can still answer it.
    expect(
      await drawFirstPartyCardV1(
        {
          draw: () => Promise.reject(new Error("the worker is unreachable")),
        },
        approval,
        context as ToolExecutionContext,
      ),
    ).toEqual({});
  });
});
