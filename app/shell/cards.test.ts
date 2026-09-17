// The Card record: how a send's messages fold onto it, what it refuses, and
// what one settled Turn writes.
import { describe, expect, test } from "bun:test";
import {
  A2UI_LIMITS_V1,
  decodeA2uiAgentMessageV1,
  type A2uiAgentMessageV1,
} from "@frockbot/core/contracts";
import {
  cardActionRouteV1,
  cardKeyV1,
  cardSendsV1,
  cardTerminalRecordsV1,
  CardBudgetError,
  CARD_INDEX_KEY,
  decodeCardActionCommandV1,
  decodeCardRecordV1,
  foldCardMessagesV1,
  projectCardV1,
  type CardRecordV1,
} from "./cards.js";

const SURFACE = "draft-email";
const NOW = "2026-09-17T10:00:00.000Z";
const CONTEXT = {
  surfaceId: SURFACE,
  runId: "run-1",
  sessionId: "user-1:bot-1",
  now: NOW,
};

function message(value: unknown): A2uiAgentMessageV1 {
  return decodeA2uiAgentMessageV1(value);
}

function created(components: unknown[], dataModel?: unknown) {
  return message({
    version: "v1.0",
    createSurface: {
      surfaceId: SURFACE,
      components,
      ...(dataModel === undefined ? {} : { dataModel }),
    },
  });
}

describe("folding a surface", () => {
  test("a create is the whole surface, and the first fold is revision 1", () => {
    const card = foldCardMessagesV1(
      undefined,
      [
        created([{ id: "root", component: "Text", text: "Ready" }], {
          sent: false,
        }),
      ],
      CONTEXT,
    );
    expect(card.revision).toBe(1);
    expect(card.components).toEqual([
      { id: "root", component: "Text", text: "Ready" },
    ]);
    expect(card.dataModel).toEqual({ sent: false });
    expect(card.createdAt).toBe(NOW);
  });

  test("updateComponents upserts by id and keeps the first order", () => {
    const first = foldCardMessagesV1(
      undefined,
      [
        created([
          { id: "root", component: "Column", children: ["a", "b"] },
          { id: "a", component: "Text", text: "one" },
          { id: "b", component: "Text", text: "two" },
        ]),
      ],
      CONTEXT,
    );
    const second = foldCardMessagesV1(
      first,
      [
        message({
          version: "v1.0",
          updateComponents: {
            surfaceId: SURFACE,
            components: [
              { id: "a", component: "Text", text: "ONE" },
              { id: "c", component: "Text", text: "three" },
            ],
          },
        }),
      ],
      { ...CONTEXT, runId: "run-2" },
    );
    expect(second.components.map((component) => component.id)).toEqual([
      "root",
      "a",
      "b",
      "c",
    ]);
    expect(second.components[1]).toEqual({
      id: "a",
      component: "Text",
      text: "ONE",
    });
    expect(second.revision).toBe(2);
  });

  test("updateDataModel writes at the pointer, and null deletes the key", () => {
    const card = foldCardMessagesV1(
      undefined,
      [
        created([], { to: { name: "Nick" }, sent: false }),
        message({
          version: "v1.0",
          updateDataModel: {
            surfaceId: SURFACE,
            path: "/to/email",
            value: "nick@test",
          },
        }),
        message({
          version: "v1.0",
          updateDataModel: { surfaceId: SURFACE, path: "/sent", value: null },
        }),
      ],
      CONTEXT,
    );
    expect(card.dataModel).toEqual({
      to: { name: "Nick", email: "nick@test" },
    });
  });

  test("a pointer with no path replaces the whole model", () => {
    const card = foldCardMessagesV1(
      undefined,
      [
        created([], { a: 1 }),
        message({
          version: "v1.0",
          updateDataModel: { surfaceId: SURFACE, value: { b: 2 } },
        }),
      ],
      CONTEXT,
    );
    expect(card.dataModel).toEqual({ b: 2 });
  });

  test("a root write that is not an object is refused", () => {
    expect(() =>
      foldCardMessagesV1(
        undefined,
        [
          created([]),
          message({
            version: "v1.0",
            updateDataModel: { surfaceId: SURFACE, value: 7 },
          }),
        ],
        CONTEXT,
      ),
    ).toThrow(CardBudgetError);
  });

  test("deleteSurface tombstones the record rather than emptying the thread", () => {
    const card = foldCardMessagesV1(
      undefined,
      [
        created([{ id: "root", component: "Text", text: "Ready" }]),
        message({ version: "v1.0", deleteSurface: { surfaceId: SURFACE } }),
      ],
      CONTEXT,
    );
    expect(card.deleted).toBe(true);
    expect(card.components).toEqual([]);
    expect(projectCardV1(card).deleted).toBe(true);
  });

  test("a create after a delete brings the surface back", () => {
    const deleted = foldCardMessagesV1(
      undefined,
      [message({ version: "v1.0", deleteSurface: { surfaceId: SURFACE } })],
      CONTEXT,
    );
    const again = foldCardMessagesV1(
      deleted,
      [created([{ id: "root", component: "Text", text: "Again" }])],
      { ...CONTEXT, runId: "run-2" },
    );
    expect(again.deleted).toBeUndefined();
    expect(again.components).toHaveLength(1);
  });
});

describe("the surface budgets", () => {
  function componentsOf(count: number, prefix = "c") {
    return Array.from({ length: count }, (_, index) => ({
      id: `${prefix}${index}`,
      component: "Text",
    }));
  }

  test("a fold that would put the surface past its component budget", () => {
    const half = A2UI_LIMITS_V1.componentsPerSurface;
    const card = foldCardMessagesV1(
      undefined,
      [created(componentsOf(half, "a"))],
      CONTEXT,
    );
    expect(() =>
      foldCardMessagesV1(
        card,
        [
          message({
            version: "v1.0",
            updateComponents: {
              surfaceId: SURFACE,
              components: componentsOf(1, "b"),
            },
          }),
        ],
        CONTEXT,
      ),
    ).toThrow(/components/);
  });

  test("a fold past the data-model budget", () => {
    const card = foldCardMessagesV1(
      undefined,
      [created([], { a: "x" })],
      CONTEXT,
    );
    expect(() =>
      foldCardMessagesV1(
        card,
        [
          message({
            version: "v1.0",
            updateDataModel: {
              surfaceId: SURFACE,
              path: "/b",
              value: "x".repeat(A2UI_LIMITS_V1.dataModelBytes - 100),
            },
          }),
          message({
            version: "v1.0",
            updateDataModel: {
              surfaceId: SURFACE,
              path: "/c",
              value: "x".repeat(A2UI_LIMITS_V1.dataModelBytes - 100),
            },
          }),
        ],
        CONTEXT,
      ),
    ).toThrow(/data model/);
  });
});

describe("what one settled Turn writes", () => {
  function sendEvent(
    surfaceId: string,
    messages: unknown[],
  ): { type: string; payload: Record<string, unknown> } {
    return {
      type: "send/to-user",
      payload: { type: "card", surfaceId, messages },
    };
  }

  function textSend(): { type: string; payload: Record<string, unknown> } {
    return { type: "send/to-user", payload: { type: "text", text: "hi" } };
  }

  function reader(records: Record<string, unknown>) {
    return <T>(key: string) => Promise.resolve(records[key] as T | undefined);
  }

  test("gathers every send to one surface in the order it was made", () => {
    const sends = cardSendsV1([
      sendEvent(SURFACE, [1]),
      textSend(),
      sendEvent(SURFACE, [2]),
      sendEvent("other", [3]),
    ]);
    expect(sends).toEqual([
      { surfaceId: SURFACE, messages: [1, 2] },
      { surfaceId: "other", messages: [3] },
    ] as never);
  });

  test("writes the folded card and the Session's surface index", async () => {
    const records = await cardTerminalRecordsV1({
      run: {
        runId: "run-1",
        sessionId: "user-1:bot-1",
        events: [
          sendEvent(SURFACE, [
            {
              version: "v1.0",
              createSurface: {
                surfaceId: SURFACE,
                components: [{ id: "root", component: "Text", text: "Ready" }],
              },
            },
          ]),
        ],
      },
      now: NOW,
      read: reader({}),
    });
    expect(Object.keys(records).sort()).toEqual([
      CARD_INDEX_KEY,
      cardKeyV1(SURFACE),
    ]);
    const card = decodeCardRecordV1(records[cardKeyV1(SURFACE)]);
    expect(card.revision).toBe(1);
  });

  test("re-settling the same Turn folds nothing twice", async () => {
    const existing: CardRecordV1 = {
      schemaVersion: 1,
      surfaceId: SURFACE,
      runId: "run-1",
      sessionId: "user-1:bot-1",
      components: [],
      dataModel: {},
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const records = await cardTerminalRecordsV1({
      run: {
        runId: "run-1",
        sessionId: "user-1:bot-1",
        events: [
          sendEvent(SURFACE, [
            { version: "v1.0", deleteSurface: { surfaceId: SURFACE } },
          ]),
        ],
      },
      now: "2026-09-17T11:00:00.000Z",
      read: reader({ [cardKeyV1(SURFACE)]: existing }),
    });
    expect(records).toEqual({});
  });

  test("a Session already holding its surfaces draws no more", async () => {
    const surfaces = Array.from(
      { length: A2UI_LIMITS_V1.surfacesPerSession },
      (_, index) => `s${index}`,
    );
    const records = await cardTerminalRecordsV1({
      run: {
        runId: "run-2",
        sessionId: "user-1:bot-1",
        events: [
          sendEvent("one-too-many", [
            { version: "v1.0", createSurface: { surfaceId: "one-too-many" } },
          ]),
        ],
      },
      now: NOW,
      read: reader({
        [CARD_INDEX_KEY]: { schemaVersion: 1, surfaces },
      }),
    });
    expect(records).toEqual({});
  });

  test("a fold past a budget says so on the card it did not change", async () => {
    const existing: CardRecordV1 = {
      schemaVersion: 1,
      surfaceId: SURFACE,
      runId: "run-1",
      sessionId: "user-1:bot-1",
      components: Array.from(
        { length: A2UI_LIMITS_V1.componentsPerSurface },
        (_, index) => ({ id: `a${index}`, component: "Text" }),
      ),
      dataModel: {},
      revision: 4,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const records = await cardTerminalRecordsV1({
      run: {
        runId: "run-2",
        sessionId: "user-1:bot-1",
        events: [
          sendEvent(SURFACE, [
            {
              version: "v1.0",
              updateComponents: {
                surfaceId: SURFACE,
                components: [{ id: "extra", component: "Text" }],
              },
            },
          ]),
        ],
      },
      now: "2026-09-17T11:00:00.000Z",
      read: reader({ [cardKeyV1(SURFACE)]: existing }),
    });
    const card = decodeCardRecordV1(records[cardKeyV1(SURFACE)]);
    expect(card.revision).toBe(4);
    expect(card.refusal).toMatch(/components/);
  });
});

describe("what an action name means", () => {
  test("the two reserved namespaces, and everything else", () => {
    expect(cardActionRouteV1("approval/ap-1")).toEqual({
      kind: "approval",
      approvalId: "ap-1",
    });
    expect(cardActionRouteV1("plugin/email/send")).toEqual({
      kind: "plugin",
      pluginId: "email",
      action: "send",
    });
    expect(cardActionRouteV1("pick-tuesday")).toEqual({ kind: "input" });
  });

  test("a name that almost reaches the kernel is refused, never input", () => {
    // Otherwise a Card could reach the approval path by writing a name the
    // kernel nearly understood, or quietly become conversation input.
    for (const name of [
      "approval/",
      "approval/../other",
      "plugin/Email/send",
      "plugin/email",
      "plugin//send",
    ]) {
      expect(() => cardActionRouteV1(name)).toThrow(/invalid/);
    }
  });
});

describe("the action command", () => {
  test("decodes the revision, the event and the model the surface sent", () => {
    expect(
      decodeCardActionCommandV1({
        schemaVersion: 1,
        surfaceId: SURFACE,
        revision: 3,
        event: { name: "approval/ap-1", context: { decision: "approved" } },
        dataModel: { sent: false },
      }),
    ).toEqual({
      schemaVersion: 1,
      surfaceId: SURFACE,
      revision: 3,
      event: { name: "approval/ap-1", context: { decision: "approved" } },
      dataModel: { sent: false },
    });
  });

  test("refuses a missing revision, a bad event and an unexpected field", () => {
    expect(() =>
      decodeCardActionCommandV1({
        schemaVersion: 1,
        surfaceId: SURFACE,
        event: { name: "send" },
      }),
    ).toThrow(/revision/);
    expect(() =>
      decodeCardActionCommandV1({
        schemaVersion: 1,
        surfaceId: SURFACE,
        revision: 1,
        event: {},
      }),
    ).toThrow(/name/);
    expect(() =>
      decodeCardActionCommandV1({
        schemaVersion: 1,
        surfaceId: SURFACE,
        revision: 1,
        event: { name: "send" },
        decision: "approved",
      }),
    ).toThrow(/unexpected key/);
  });
});
