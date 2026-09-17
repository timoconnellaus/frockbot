// What the kernel does with one press on a Card: the three routes, and the
// two things it refuses before it does anything at all.
import { describe, expect, test } from "bun:test";
import type { BotIdentity } from "@frockbot/core/durable";
import { a2uiByteLengthV1, A2UI_LIMITS_V1 } from "@frockbot/core/contracts";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import { approvalKeyV1 } from "@frockbot/app/shell/approvals";
import {
  cardKeyV1,
  decodeCardActionReceiptV1,
  CARD_INDEX_KEY,
  CARD_PREFIX,
  CARD_REFUSAL_MAX_V1,
  type CardRecordV1,
} from "@frockbot/app/shell/cards";
import { CARD_ACTION_CONTEXT_MAX_V1 } from "@frockbot/app/routines/inbox";
import {
  cardAction,
  cardActionInvocationV1,
  CardStaleError,
  listCards,
  readCardView,
} from "./bot.js";

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
function harness(
  values: Map<string, unknown> = new Map(),
  mountError = "this deployment cannot mount a Plugin worker",
) {
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
          throw new Error(mountError);
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
    expect(listed.truncated).toBeUndefined();
  });

  test("stops at the listing budget and says so", async () => {
    // Each card carries a data model near its own record budget, so a handful
    // of them passes what one listing may answer with.
    const filler = "x".repeat(15_000);
    const values = new Map<string, unknown>();
    for (let index = 0; index < 32; index += 1) {
      const surfaceId = `surface-${index.toString().padStart(2, "0")}`;
      values.set(
        cardKeyV1(surfaceId),
        card({
          surfaceId,
          dataModel: { filler },
          updatedAt: `2026-09-17T10:00:${index.toString().padStart(2, "0")}.000Z`,
        }),
      );
    }
    const listed = await listCards(harness(values).state, IDENTITY);
    expect(listed.truncated).toBe(true);
    expect(listed.cards.length).toBeGreaterThan(0);
    expect(listed.cards.length).toBeLessThan(32);
    // Newest first, so what falls off the end is the stalest surface.
    expect(listed.cards[0]?.surfaceId).toBe("surface-31");
    expect(
      listed.cards.reduce((total, entry) => total + a2uiByteLengthV1(entry), 0),
    ).toBeLessThanOrEqual(A2UI_LIMITS_V1.cardListBytes);
  });

  test("a Session that has evicted many surfaces stops accumulating records", async () => {
    const values = new Map<string, unknown>();
    const stamp = (minute: number) =>
      `2026-09-17T${(10 + Math.floor(minute / 60)).toString().padStart(2, "0")}:${(minute % 60).toString().padStart(2, "0")}:00.000Z`;
    // What a long Session naming a fresh surface every Turn leaves behind:
    // one tombstone per evicted surface, stalest first.
    const evicted = A2UI_LIMITS_V1.surfacesPerSession + 40;
    for (let index = 0; index < evicted; index += 1) {
      const surfaceId = `gone-${index.toString().padStart(3, "0")}`;
      values.set(
        cardKeyV1(surfaceId),
        card({
          surfaceId,
          components: [],
          dataModel: {},
          deleted: true,
          refusal: "the card was dropped to make room for a newer card",
          updatedAt: stamp(index),
        }),
      );
    }
    // Beside them, the surfaces the index still lists — the newest drawn.
    const live = Array.from(
      { length: A2UI_LIMITS_V1.surfacesPerSession },
      (_, index) => `live-${index.toString().padStart(3, "0")}`,
    );
    for (const surfaceId of live) {
      values.set(cardKeyV1(surfaceId), card({ surfaceId, updatedAt: NOW }));
    }
    values.set(CARD_INDEX_KEY, { schemaVersion: 1, surfaces: live });
    const listed = await listCards(harness(values).state, IDENTITY);
    const kept = [...values.keys()].filter((key) =>
      key.startsWith(CARD_PREFIX),
    );
    expect(kept).toHaveLength(A2UI_LIMITS_V1.surfacesPerSession * 2);
    // Every surface the index still lists survived; the stalest tombstones did
    // not, and the listing no longer carries them either.
    for (const surfaceId of live) {
      expect(kept).toContain(cardKeyV1(surfaceId));
    }
    expect(kept).not.toContain(cardKeyV1("gone-000"));
    expect(kept).toContain(
      cardKeyV1(`gone-${(evicted - 1).toString().padStart(3, "0")}`),
    );
    expect(listed.cards.some((entry) => entry.surfaceId === "gone-000")).toBe(
      false,
    );
  });
});

describe("reading one Card by its id", () => {
  test("answers a surface the listing's byte budget would have cut", async () => {
    const { state } = harness(
      new Map<string, unknown>([[cardKeyV1(SURFACE), card()]]),
    );
    const view = await readCardView(state, IDENTITY, SURFACE);
    expect(view).toMatchObject({ surfaceId: SURFACE, revision: 2 });
    expect(view).not.toHaveProperty("runId");
  });

  test("answers a tombstoned surface, which the transcript still draws", async () => {
    const { state } = harness(
      new Map<string, unknown>([
        [cardKeyV1(SURFACE), card({ deleted: true, components: [] })],
      ]),
    );
    expect(await readCardView(state, IDENTITY, SURFACE)).toMatchObject({
      surfaceId: SURFACE,
      deleted: true,
    });
  });

  test("a surface this Bot never drew is not found", async () => {
    const { state } = harness();
    await expect(readCardView(state, IDENTITY, SURFACE)).rejects.toMatchObject({
      name: "CardNotFoundError",
    });
  });
});

describe("what a Plugin handler is handed", () => {
  const handler = {
    pluginId: "email",
    action: "regenerate",
    runId: "card-action:draft-email:2",
    generationId: "foundation-v1",
  };

  test("the data model travels when the surface asked for it", () => {
    const invocation = cardActionInvocationV1(
      IDENTITY,
      {
        schemaVersion: 1,
        surfaceId: SURFACE,
        revision: 2,
        event: { name: "plugin/email/regenerate" },
        dataModel: { tone: "brisk" },
      },
      card({ sendDataModel: true }),
      handler,
    );
    expect(invocation.dataModel).toEqual({ tone: "brisk" });
  });

  test("a surface that did not ask for its model is never handed one", () => {
    const invocation = cardActionInvocationV1(
      IDENTITY,
      {
        schemaVersion: 1,
        surfaceId: SURFACE,
        revision: 2,
        event: { name: "plugin/email/regenerate" },
        dataModel: { tone: "brisk" },
      },
      card(),
      handler,
    );
    expect(invocation).not.toHaveProperty("dataModel");
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

  test("a plugin failure too long to carry still answers a readable receipt", async () => {
    const { state } = harness(
      new Map<string, unknown>([[cardKeyV1(SURFACE), card()]]),
      "x".repeat(CARD_REFUSAL_MAX_V1 * 4),
    );
    const receipt = await cardAction(state, IDENTITY, {
      schemaVersion: 1,
      surfaceId: SURFACE,
      revision: 2,
      event: { name: "plugin/email/regenerate" },
    });
    expect(receipt.failure!.length).toBeLessThanOrEqual(CARD_REFUSAL_MAX_V1);
    expect(() => decodeCardActionReceiptV1(receipt)).not.toThrow();
  });

  test("a plugin failure that said nothing still answers a readable receipt", async () => {
    const { state } = harness(
      new Map<string, unknown>([[cardKeyV1(SURFACE), card()]]),
      "   ",
    );
    const receipt = await cardAction(state, IDENTITY, {
      schemaVersion: 1,
      surfaceId: SURFACE,
      revision: 2,
      event: { name: "plugin/email/regenerate" },
    });
    expect(receipt.failure).toMatch(/without saying why/);
    expect(() => decodeCardActionReceiptV1(receipt)).not.toThrow();
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

  test("a context past what the preamble carries is refused, never cut", async () => {
    // The Bot reads this verbatim, so half of a JSON object is worse than a
    // refusal the person is told about.
    const values = new Map<string, unknown>([[cardKeyV1(SURFACE), card()]]);
    const { state } = harness(values);
    await expect(
      cardAction(state, IDENTITY, {
        schemaVersion: 1,
        surfaceId: SURFACE,
        revision: 2,
        event: {
          name: "pick-tuesday",
          context: { note: "x".repeat(CARD_ACTION_CONTEXT_MAX_V1) },
        },
      }),
    ).rejects.toMatchObject({ name: "CardDecodeError" });
    expect(
      [...values.keys()].filter((key) => key.startsWith("routine-wake:")),
    ).toHaveLength(0);
  });
});
