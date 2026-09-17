// What the kernel does with one press on a Card: the three routes, and the
// two things it refuses before it does anything at all.
import { describe, expect, test } from "bun:test";
import type { BotIdentity } from "@frockbot/core/durable";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import { approvalKeyV1 } from "@frockbot/app/shell/approvals";
import { cardKeyV1, type CardRecordV1 } from "@frockbot/app/shell/cards";
import { cardAction, CardStaleError, listCards } from "./bot.js";

const IDENTITY: BotIdentity = { userId: "user-1", botId: "bot-1" };
const SURFACE = "draft-email";
const NOW = "2026-09-17T10:00:00.000Z";

function card(overrides: Partial<CardRecordV1> = {}): CardRecordV1 {
  return {
    schemaVersion: 1,
    surfaceId: SURFACE,
    runId: "run-1",
    sessionId: "user-1:bot-1",
    components: [{ id: "root", component: "Text", text: "Ready to send" }],
    dataModel: { sent: false },
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * The Bot's storage, in memory. `transaction` runs the callback against the
 * same map: these tests are about what the kernel decides, not about what a
 * Durable Object does when two writers race.
 */
function harness(values: Map<string, unknown> = new Map()) {
  const storage = {
    get: (key: string) => Promise.resolve(values.get(key)),
    put: (keyOrEntries: unknown, value?: unknown) => {
      if (typeof keyOrEntries === "string") values.set(keyOrEntries, value);
      else
        for (const [key, entry] of Object.entries(
          keyOrEntries as Record<string, unknown>,
        ))
          values.set(key, entry);
      return Promise.resolve();
    },
    delete: (key: string) => Promise.resolve(values.delete(key)),
    list: ({ prefix }: { prefix: string }) =>
      Promise.resolve(
        new Map(
          [...values.entries()].filter(([key]) => key.startsWith(prefix)),
        ),
      ),
    transaction: <T>(callback: (transaction: unknown) => Promise<T>) =>
      callback(storage),
  };
  const state = {
    ctx: { storage },
    env: {
      USER_CONFIGURATIONS: {
        idFromName: (name: string) => name,
        get: () => {
          throw new Error("this deployment cannot mount a Plugin worker");
        },
      },
    },
    authority: { validateIdentity: () => Promise.resolve() },
  } as unknown as ShellBotStateV1;
  return { state, values };
}

describe("reading a Bot's Cards", () => {
  test("lists every surface it drew, newest first", async () => {
    const { state } = harness(
      new Map<string, unknown>([
        [cardKeyV1(SURFACE), card()],
        [
          cardKeyV1("receipt"),
          card({ surfaceId: "receipt", updatedAt: "2026-09-17T12:00:00.000Z" }),
        ],
      ]),
    );
    const listed = await listCards(state, IDENTITY);
    expect(listed.cards.map((entry) => entry.surfaceId)).toEqual([
      "receipt",
      SURFACE,
    ]);
    // The record's own bookkeeping is not the client's business.
    expect(listed.cards[0]).not.toHaveProperty("runId");
  });
});

describe("what is refused before the action is routed", () => {
  test("a surface this Bot never drew", async () => {
    const { state } = harness();
    await expect(
      cardAction(state, IDENTITY, {
        schemaVersion: 1,
        surfaceId: SURFACE,
        revision: 2,
        event: { name: "send" },
      }),
    ).rejects.toThrow(/was not found/);
  });

  test("a revision the surface has moved past", async () => {
    const { state } = harness(
      new Map<string, unknown>([[cardKeyV1(SURFACE), card({ revision: 3 })]]),
    );
    await expect(
      cardAction(state, IDENTITY, {
        schemaVersion: 1,
        surfaceId: SURFACE,
        revision: 2,
        event: { name: "send" },
      }),
    ).rejects.toThrow(CardStaleError);
  });
});

describe("the three routes", () => {
  test("an approval action records the decision the kernel already issued", async () => {
    const values = new Map<string, unknown>([
      [cardKeyV1(SURFACE), card()],
      [
        approvalKeyV1("ap-1"),
        {
          schemaVersion: 1,
          approvalId: "ap-1",
          runId: "run-1",
          sessionId: "user-1:bot-1",
          action: "Send the email",
          risk: "medium",
          createdAt: NOW,
          expiresAt: "2026-09-18T10:00:00.000Z",
          decision: "pending",
          decidedBy: "pending",
        },
      ],
    ]);
    const { state } = harness(values);
    const receipt = await cardAction(state, IDENTITY, {
      schemaVersion: 1,
      surfaceId: SURFACE,
      revision: 2,
      event: { name: "approval/ap-1", context: { decision: "approved" } },
    });
    expect(receipt.routed).toBe("approval");
    expect(values.get(approvalKeyV1("ap-1"))).toMatchObject({
      decision: "approved",
      decidedBy: "user",
    });
  });

  test("a Card cannot mint an approval the kernel never recorded", async () => {
    const { state } = harness(
      new Map<string, unknown>([[cardKeyV1(SURFACE), card()]]),
    );
    await expect(
      cardAction(state, IDENTITY, {
        schemaVersion: 1,
        surfaceId: SURFACE,
        revision: 2,
        event: { name: "approval/invented", context: { decision: "approved" } },
      }),
    ).rejects.toMatchObject({ name: "ApprovalNotFoundError" });
  });

  test("an approval action with no decision on it is refused", async () => {
    const { state } = harness(
      new Map<string, unknown>([[cardKeyV1(SURFACE), card()]]),
    );
    await expect(
      cardAction(state, IDENTITY, {
        schemaVersion: 1,
        surfaceId: SURFACE,
        revision: 2,
        event: { name: "approval/ap-1", context: { decision: "maybe" } },
      }),
    ).rejects.toThrow(/approved or denied/);
  });

  test("a plugin handler that cannot be reached leaves the Card as it was", async () => {
    const { state } = harness(
      new Map<string, unknown>([[cardKeyV1(SURFACE), card()]]),
    );
    const receipt = await cardAction(state, IDENTITY, {
      schemaVersion: 1,
      surfaceId: SURFACE,
      revision: 2,
      event: { name: "plugin/email/regenerate" },
    });
    expect(receipt.routed).toBe("plugin");
    expect(receipt.failure).toBeTruthy();
    expect(receipt.card.revision).toBe(2);
  });

  test("anything else becomes the Bot's next input, never the User's words", async () => {
    const values = new Map<string, unknown>([[cardKeyV1(SURFACE), card()]]);
    const { state } = harness(values);
    const receipt = await cardAction(state, IDENTITY, {
      schemaVersion: 1,
      surfaceId: SURFACE,
      revision: 2,
      event: { name: "pick-tuesday", context: { day: "Tue" } },
    });
    expect(receipt.routed).toBe("input");
    const queued = [...values.entries()].filter(([key]) =>
      key.startsWith("routine-wake:"),
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]![1]).toMatchObject({
      kind: "card-action",
      surfaceId: SURFACE,
      name: "pick-tuesday",
      context: '{"day":"Tue"}',
    });
  });
});
