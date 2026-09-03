import { describe, expect, it } from "bun:test";

import {
  APPLET_FRAME_BYTE_LIMIT,
  AppletProtocolError,
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

describe("frames fail closed", () => {
  const bad: Array<[string, unknown]> = [
    ["a non-string message", { v: 1, type: "hello", contract: 1 }],
    [
      "a wrong protocol version",
      JSON.stringify({ v: 2, type: "hello", contract: 1 }),
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
