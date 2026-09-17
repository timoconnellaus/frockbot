// The Card record: how a send's messages fold onto it, what it refuses, and
// what one settled Turn writes.
import { describe, expect, test } from "bun:test";
import {
  A2UI_LIMITS_V1,
  a2uiByteLengthV1,
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
  decodeCardListViewV1,
  decodeCardRecordV1,
  decodeCardViewV1,
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

  test("a delete through a member that is not there changes nothing", () => {
    const card = foldCardMessagesV1(
      undefined,
      [
        created([], { keep: 1 }),
        message({
          version: "v1.0",
          updateDataModel: { surfaceId: SURFACE, path: "/a/b", value: null },
        }),
      ],
      CONTEXT,
    );
    expect(card.dataModel).toEqual({ keep: 1 });
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

  test('a pointer of "/" names the empty key, as RFC 6901 says', () => {
    const card = foldCardMessagesV1(
      undefined,
      [
        created([], { a: 1 }),
        message({
          version: "v1.0",
          updateDataModel: { surfaceId: SURFACE, path: "/", value: 2 },
        }),
      ],
      CONTEXT,
    );
    expect(card.dataModel).toEqual({ a: 1, "": 2 });
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

  function writes(path: string, value: unknown) {
    return message({
      version: "v1.0",
      updateDataModel: { surfaceId: SURFACE, path, value },
    });
  }

  test("a pointer resolves through a list, as RFC 6901 says", () => {
    const first = foldCardMessagesV1(
      undefined,
      [created([], { items: ["a", "b"], rows: [{ done: false }] })],
      CONTEXT,
    );
    const second = foldCardMessagesV1(
      first,
      [
        writes("/items/0", "c"),
        writes("/items/-", "d"),
        writes("/rows/0/done", true),
      ],
      { ...CONTEXT, runId: "run-2" },
    );
    expect(second.dataModel).toEqual({
      items: ["c", "b", "d"],
      rows: [{ done: true }],
    });
    expect(first.dataModel).toEqual({
      items: ["a", "b"],
      rows: [{ done: false }],
    });
  });

  test("null at a list index takes the element out, leaving no hole", () => {
    const card = foldCardMessagesV1(
      undefined,
      [created([], { items: ["a", "b", "c"] }), writes("/items/1", null)],
      CONTEXT,
    );
    expect(card.dataModel).toEqual({ items: ["a", "c"] });
  });

  test("a list token that is not an index, or is past the end, is refused", () => {
    const card = foldCardMessagesV1(
      undefined,
      [created([], { items: ["a", "b"] })],
      CONTEXT,
    );
    expect(() =>
      foldCardMessagesV1(card, [writes("/items/second", "c")], CONTEXT),
    ).toThrow(/not an index/);
    expect(() =>
      foldCardMessagesV1(card, [writes("/items/2", "c")], CONTEXT),
    ).toThrow(/index 2 of a list that has 2/);
    expect(card.dataModel).toEqual({ items: ["a", "b"] });
  });

  test("a pointer that descends through a scalar is still refused", () => {
    const card = foldCardMessagesV1(
      undefined,
      [created([], { a: 1 })],
      CONTEXT,
    );
    expect(() =>
      foldCardMessagesV1(card, [writes("/a/b", 2)], CONTEXT),
    ).toThrow(CardBudgetError);
  });

  test("a write never re-parents the data model it walks", () => {
    const card = foldCardMessagesV1(
      undefined,
      [created([], { a: 1 })],
      CONTEXT,
    );
    // The decoder refuses this pointer; the walk must not depend on that.
    const smuggled = {
      version: "v1.0",
      updateDataModel: {
        surfaceId: SURFACE,
        path: "/__proto__/pwn",
        value: 42,
      },
    } as unknown as A2uiAgentMessageV1;
    const folded = foldCardMessagesV1(card, [smuggled], {
      ...CONTEXT,
      runId: "run-2",
    });
    expect(Object.getPrototypeOf(folded.dataModel)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).pwn).toBeUndefined();
    expect(Object.hasOwn(folded.dataModel, "__proto__")).toBe(true);
    expect((folded.dataModel as Record<string, unknown>)["__proto__"]).toEqual({
      pwn: 42,
    });
  });

  test("a second create replaces the surface, carrying nothing of the first", () => {
    const first = foldCardMessagesV1(
      undefined,
      [
        message({
          version: "v1.0",
          createSurface: {
            surfaceId: SURFACE,
            catalogId: "cat-a",
            sendDataModel: true,
            surfaceProperties: { theme: "dark" },
            components: [{ id: "root", component: "Text", text: "one" }],
          },
        }),
      ],
      CONTEXT,
    );
    const second = foldCardMessagesV1(
      first,
      [created([{ id: "root", component: "Text", text: "two" }])],
      { ...CONTEXT, runId: "run-2" },
    );
    expect(second.catalogId).toBeUndefined();
    expect(second.sendDataModel).toBeUndefined();
    expect(second.surfaceProperties).toBeUndefined();
    expect(second.dataModel).toEqual({});
    expect(second.components).toEqual([
      { id: "root", component: "Text", text: "two" },
    ]);
    expect(second.revision).toBe(2);
    expect(second.createdAt).toBe(NOW);
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

  test("a fold that would put the whole record past its byte budget", () => {
    const card = foldCardMessagesV1(undefined, [created([])], CONTEXT);
    const fat = {
      ...card,
      components: Array.from({ length: 100 }, (_, index) => ({
        id: `a${index}`,
        component: "Text",
        text: "x".repeat(1_200),
      })),
    };
    expect(a2uiByteLengthV1(fat)).toBeLessThan(A2UI_LIMITS_V1.cardRecordBytes);
    expect(() =>
      foldCardMessagesV1(
        fat,
        [
          message({
            version: "v1.0",
            updateComponents: {
              surfaceId: SURFACE,
              components: [
                { id: "last", component: "Text", text: "x".repeat(12_000) },
              ],
            },
          }),
        ],
        CONTEXT,
      ),
    ).toThrow(/the card exceeds/);
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
      foldedRunId: "run-1",
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

  test("a press folding a handler's answer does not unguard the Turn", async () => {
    const settled = await cardTerminalRecordsV1({
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
    const drawn = decodeCardRecordV1(settled[cardKeyV1(SURFACE)]);
    // What a press on a `plugin/<id>/<action>` control folds: the handler's
    // messages, under the run id `foldHandlerMessages` names the press with.
    const pressed = foldCardMessagesV1(
      drawn,
      [
        message({
          version: "v1.0",
          updateComponents: {
            surfaceId: SURFACE,
            components: [{ id: "root", component: "Text", text: "Sent" }],
          },
        }),
      ],
      {
        surfaceId: SURFACE,
        runId: `card-action:${SURFACE}:${drawn.revision}`,
        sessionId: "user-1:bot-1",
        now: "2026-09-17T10:30:00.000Z",
      },
    );
    expect(pressed.revision).toBe(2);
    const resettled = await cardTerminalRecordsV1({
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
      now: "2026-09-17T11:00:00.000Z",
      read: reader({
        [CARD_INDEX_KEY]: { schemaVersion: 1, surfaces: [SURFACE] },
        [cardKeyV1(SURFACE)]: pressed,
      }),
    });
    expect(resettled).toEqual({});
  });

  test("a Session already holding its surfaces makes room for a newer card", async () => {
    const surfaces = Array.from(
      { length: A2UI_LIMITS_V1.surfacesPerSession },
      (_, index) => `s${index}`,
    );
    const oldest = foldCardMessagesV1(
      undefined,
      [
        message({
          version: "v1.0",
          createSurface: {
            surfaceId: "s0",
            components: [{ id: "root", component: "Text", text: "Old" }],
          },
        }),
      ],
      {
        surfaceId: "s0",
        runId: "run-1",
        sessionId: "user-1:bot-1",
        now: NOW,
      },
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
        [cardKeyV1("s0")]: oldest,
      }),
    });
    const evicted = decodeCardRecordV1(records[cardKeyV1("s0")]);
    expect(evicted.deleted).toBe(true);
    expect(evicted.components).toEqual([]);
    expect(evicted.refusal).toContain("make room");
    expect(evicted.revision).toBe(oldest.revision + 1);
    const drawn = decodeCardRecordV1(records[cardKeyV1("one-too-many")]);
    expect(drawn.revision).toBe(1);
    expect(drawn.refusal).toBeUndefined();
    const index = records[CARD_INDEX_KEY] as { surfaces: string[] };
    expect(index.surfaces).toHaveLength(A2UI_LIMITS_V1.surfacesPerSession);
    expect(index.surfaces).not.toContain("s0");
    expect(index.surfaces.at(-1)).toBe("one-too-many");
  });

  test("a tombstoned surface takes no update", () => {
    const drawn = foldCardMessagesV1(
      undefined,
      [
        message({
          version: "v1.0",
          createSurface: {
            surfaceId: SURFACE,
            components: [{ id: "root", component: "Text", text: "Ready" }],
          },
        }),
        message({ version: "v1.0", deleteSurface: { surfaceId: SURFACE } }),
      ],
      {
        surfaceId: SURFACE,
        runId: "run-1",
        sessionId: "user-1:bot-1",
        now: NOW,
      },
    );
    expect(drawn.deleted).toBe(true);
    expect(() =>
      foldCardMessagesV1(
        drawn,
        [
          message({
            version: "v1.0",
            updateComponents: {
              surfaceId: SURFACE,
              components: [{ id: "root", component: "Text", text: "Back" }],
            },
          }),
        ],
        {
          surfaceId: SURFACE,
          runId: "run-2",
          sessionId: "user-1:bot-1",
          now: NOW,
        },
      ),
    ).toThrow(/deleted/);
    expect(() =>
      foldCardMessagesV1(
        drawn,
        [
          message({
            version: "v1.0",
            updateDataModel: { surfaceId: SURFACE, path: "/a", value: 1 },
          }),
        ],
        {
          surfaceId: SURFACE,
          runId: "run-2",
          sessionId: "user-1:bot-1",
          now: NOW,
        },
      ),
    ).toThrow(/deleted/);
    const revived = foldCardMessagesV1(
      drawn,
      [
        message({
          version: "v1.0",
          createSurface: {
            surfaceId: SURFACE,
            components: [{ id: "root", component: "Text", text: "Back" }],
          },
        }),
      ],
      {
        surfaceId: SURFACE,
        runId: "run-2",
        sessionId: "user-1:bot-1",
        now: NOW,
      },
    );
    expect(revived.deleted).toBeUndefined();
    expect(revived.components).toHaveLength(1);
  });

  test("a first send refused by a budget still leaves a card to draw", async () => {
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
                dataModel: { items: ["a"] },
              },
            },
            {
              version: "v1.0",
              updateDataModel: {
                surfaceId: SURFACE,
                path: "/items/first",
                value: "b",
              },
            },
          ]),
        ],
      },
      now: NOW,
      read: reader({}),
    });
    const card = decodeCardRecordV1(records[cardKeyV1(SURFACE)]);
    expect(card.revision).toBe(1);
    expect(card.components).toEqual([]);
    expect(card.dataModel).toEqual({});
    expect(card.refusal).toBeTruthy();
    expect(records[CARD_INDEX_KEY]).toEqual({
      schemaVersion: 1,
      surfaces: [SURFACE],
    });
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

  test("refuses a surface id that could never have been a key", () => {
    // The send decoder holds a surfaceId to the same shape, so a name like
    // this can never name a stored record; it is refused where it is read
    // rather than turned into a lookup that simply misses.
    expect(() =>
      decodeCardActionCommandV1({
        schemaVersion: 1,
        surfaceId: "../run:foo",
        revision: 0,
        event: { name: "send" },
      }),
    ).toThrow(/surfaceId/);
    const stored = {
      schemaVersion: 1,
      surfaceId: "../run:foo",
      runId: "run-1",
      sessionId: "user-1:bot-1",
      components: [{ id: "root", component: "Text", text: "Hi" }],
      dataModel: {},
      revision: 0,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(() => decodeCardRecordV1(stored)).toThrow(/surfaceId/);
    const { runId: _runId, sessionId: _sessionId, ...view } = stored;
    expect(() =>
      decodeCardListViewV1({
        schemaVersion: 1,
        botId: "bot-1",
        cards: [view],
      }),
    ).toThrow(/surfaceId/);
  });
});

describe("the flags a decoder carries", () => {
  const view = {
    schemaVersion: 1,
    surfaceId: SURFACE,
    revision: 0,
    components: [],
    dataModel: {},
    createdAt: NOW,
    updatedAt: NOW,
  };

  test("a listing that says nothing was withheld is not read as truncated", () => {
    expect(
      decodeCardListViewV1({
        schemaVersion: 1,
        botId: "bot-1",
        cards: [],
        truncated: false,
      }),
    ).not.toHaveProperty("truncated");
    expect(
      decodeCardListViewV1({
        schemaVersion: 1,
        botId: "bot-1",
        cards: [],
        truncated: true,
      }).truncated,
    ).toBe(true);
  });

  test("a truncated that is not a boolean is refused", () => {
    expect(() =>
      decodeCardListViewV1({
        schemaVersion: 1,
        botId: "bot-1",
        cards: [],
        truncated: "yes",
      }),
    ).toThrow(/truncated/);
  });

  test("a surface that says it was not deleted is not read as tombstoned", () => {
    expect(decodeCardViewV1({ ...view, deleted: false })).not.toHaveProperty(
      "deleted",
    );
    expect(decodeCardViewV1({ ...view, deleted: true }).deleted).toBe(true);
    expect(() => decodeCardViewV1({ ...view, deleted: 1 })).toThrow(/deleted/);
  });

  test("a sendDataModel that is not a boolean is refused", () => {
    expect(
      decodeCardViewV1({ ...view, sendDataModel: false }).sendDataModel,
    ).toBe(false);
    expect(() => decodeCardViewV1({ ...view, sendDataModel: "true" })).toThrow(
      /sendDataModel/,
    );
  });
});
