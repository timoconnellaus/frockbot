import { describe, expect, it } from "bun:test";

import {
  APPLET_FRAME_BYTE_LIMIT,
  AppletProtocolError,
  appletHandshakeFromUrlV1,
  decodeClientFrame,
  decodeServerFrame,
  encodeFrame,
  type AppletClientFrameV1,
  type AppletServerFrameV1,
} from "../src/protocol/index.js";

const hello: AppletServerFrameV1 = {
  v: 1,
  type: "hello",
  contract: 1,
  generationId: "gen-1",
  viewer: { id: "viewer-1", canWrite: true },
  tables: ["todos"],
  schemaRevision: 1,
  lastChangeId: 0,
};

describe("frames round-trip", () => {
  it("keeps every server frame identical through encode and decode", () => {
    const frames: AppletServerFrameV1[] = [
      hello,
      {
        v: 1,
        type: "snapshot",
        lastChangeId: 3,
        tables: { todos: [{ id: "a" }] },
      },
      {
        v: 1,
        type: "changes",
        lastChangeId: 4,
        txnId: "txn-1",
        changes: [
          {
            table: "todos",
            op: "insert",
            key: "a",
            row: { id: "a", done: false },
          },
          { table: "todos", op: "delete", key: "b" },
        ],
      },
      { v: 1, type: "ack", txnId: "txn-1", lastChangeId: 4, changes: [] },
      { v: 1, type: "reject", txnId: "txn-1", reason: "no" },
    ];
    for (const frame of frames) {
      expect(decodeServerFrame(encodeFrame(frame))).toEqual(frame);
    }
  });

  it("keeps every client frame identical through encode and decode", () => {
    expect(
      decodeClientFrame(encodeFrame({ v: 1, type: "hello", contract: 1 })),
    ).toEqual({
      v: 1,
      type: "hello",
      contract: 1,
    });
    const mutate: AppletClientFrameV1 = {
      v: 1,
      type: "mutate",
      txnId: "txn-1",
      mutations: [
        { table: "todos", op: "insert", value: { title: "milk" } },
        { table: "todos", op: "update", key: "a", value: { done: true } },
        { table: "todos", op: "delete", key: "b" },
      ],
    };
    expect(decodeClientFrame(encodeFrame(mutate))).toEqual(mutate);
  });
});

describe("protocol v2", () => {
  it("carries the snapshot in a v2 hello and keeps it out of a v1 one", () => {
    const greeting: AppletServerFrameV1 = {
      ...hello,
      v: 2,
      snapshot: { todos: [{ id: "a", done: false }] },
    };
    expect(decodeServerFrame(encodeFrame(greeting))).toEqual(greeting);
    // A v1 speaker never produced a hello with a snapshot, so one is not a
    // frame this code sent.
    expect(() =>
      decodeServerFrame(JSON.stringify({ ...greeting, v: 1 })),
    ).toThrow(/unknown field "snapshot"/);
    // A v2 hello without one is the v1 exchange about to follow.
    expect(decodeServerFrame(encodeFrame({ ...hello, v: 2 }))).toEqual({
      ...hello,
      v: 2,
    });
  });

  it("keeps the version a frame was sent in, and refuses one it does not speak", () => {
    for (const v of [1, 2] as const) {
      expect(
        decodeClientFrame(encodeFrame({ v, type: "hello", contract: 1 })).v,
      ).toBe(v);
      expect(
        decodeServerFrame(
          encodeFrame({ v, type: "reject", txnId: "t", reason: "no" }),
        ).v,
      ).toBe(v);
    }
    expect(() =>
      decodeServerFrame(JSON.stringify({ v: 3, type: "hello", contract: 1 })),
    ).toThrow(/unsupported protocol version/);
  });

  it("reads the page's version and cursor off the socket URL", () => {
    expect(
      appletHandshakeFromUrlV1(new URL("wss://bot.example/api/a/socket")),
    ).toEqual({ protocol: 1 });
    expect(
      appletHandshakeFromUrlV1(new URL("wss://bot.example/a/socket?v=2")),
    ).toEqual({ protocol: 2 });
    expect(
      appletHandshakeFromUrlV1(
        new URL("wss://bot.example/a/socket?v=2&since=41&token=x"),
      ),
    ).toEqual({ protocol: 2, since: 41 });
    // A cursor that is not one is no cursor, and never a crash.
    for (const since of ["0", "-1", "1.5", "abc", "9007199254740993"]) {
      expect(
        appletHandshakeFromUrlV1(
          new URL(`wss://bot.example/a/socket?v=2&since=${since}`),
        ),
      ).toEqual({ protocol: 2 });
    }
    expect(
      appletHandshakeFromUrlV1(new URL("wss://bot.example/a/socket?v=3")),
    ).toEqual({ protocol: 1 });
  });
});

describe("frames fail closed", () => {
  const bad: Array<[string, unknown]> = [
    ["a non-string message", { v: 1, type: "hello", contract: 1 }],
    [
      "a wrong protocol version",
      JSON.stringify({ v: 3, type: "hello", contract: 1 }),
    ],
    ["an unknown type", JSON.stringify({ v: 1, type: "sync" })],
    [
      "an unknown field",
      JSON.stringify({ v: 1, type: "hello", contract: 1, extra: true }),
    ],
    ["a wrong contract", JSON.stringify({ v: 1, type: "hello", contract: 2 })],
    [
      "a negative cursor",
      JSON.stringify({ v: 1, type: "hello", contract: 1, since: -1 }),
    ],
    [
      "an empty mutation list",
      JSON.stringify({ v: 1, type: "mutate", txnId: "t", mutations: [] }),
    ],
    [
      "an update with no key",
      JSON.stringify({
        v: 1,
        type: "mutate",
        txnId: "t",
        mutations: [{ table: "todos", op: "update", value: {} }],
      }),
    ],
    [
      "a delete carrying a value",
      JSON.stringify({
        v: 1,
        type: "mutate",
        txnId: "t",
        mutations: [{ table: "todos", op: "delete", key: "a", value: {} }],
      }),
    ],
    [
      "a table name that is not an identifier",
      JSON.stringify({
        v: 1,
        type: "mutate",
        txnId: "t",
        mutations: [{ table: "drop table", op: "delete", key: "a" }],
      }),
    ],
    ["malformed JSON", "{"],
  ];

  for (const [label, message] of bad) {
    it(`refuses ${label}`, () => {
      expect(() => decodeClientFrame(message)).toThrow(AppletProtocolError);
    });
  }

  it("refuses a frame over the wire limit in both directions", () => {
    const big = "x".repeat(APPLET_FRAME_BYTE_LIMIT);
    expect(() =>
      encodeFrame({
        v: 1,
        type: "snapshot",
        lastChangeId: 0,
        tables: { todos: [{ id: big }] },
      }),
    ).toThrow(/64 KB/);
    expect(() =>
      decodeClientFrame(`{"v":1,"type":"hello","contract":1,"x":"${big}"}`),
    ).toThrow(/64 KB/);
  });
});
