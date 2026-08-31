import { describe, expect, test } from "bun:test";
import {
  boundSearchBodyV1,
  decodeSearchQueryV1,
  decodeSearchRowPageV1,
  decodeSearchRowV1,
  searchDeepLinkV1,
  searchTurnAnchorV1,
  SEARCH_MAX_BODY_BYTES_V1,
} from "./shared.ts";

const ROW = {
  botId: "bot-a",
  runId: "run-1",
  seq: 0,
  kind: "user" as const,
  at: "2026-08-31T00:00:00.000Z",
  body: "the gym build",
};

describe("search row decoding", () => {
  test("round-trips an exact row", () => {
    expect(decodeSearchRowV1({ ...ROW })).toEqual(ROW);
  });

  test("refuses an unexpected key", () => {
    expect(() => decodeSearchRowV1({ ...ROW, userId: "u" })).toThrow(
      "not allowed",
    );
  });

  test("refuses an invalid kind, seq, or timestamp", () => {
    expect(() => decodeSearchRowV1({ ...ROW, kind: "secret" })).toThrow();
    expect(() => decodeSearchRowV1({ ...ROW, seq: -1 })).toThrow();
    expect(() => decodeSearchRowV1({ ...ROW, at: "yesterday" })).toThrow();
  });

  test("truncates an over-long body to the durable per-row bound", () => {
    const long = "x".repeat(SEARCH_MAX_BODY_BYTES_V1 + 500);
    expect(decodeSearchRowV1({ ...ROW, body: long }).body.length).toBe(
      SEARCH_MAX_BODY_BYTES_V1,
    );
  });

  test("truncates on a code-point edge", () => {
    const emoji = "😀".repeat(SEARCH_MAX_BODY_BYTES_V1);
    const bounded = boundSearchBodyV1(emoji);
    expect(new TextEncoder().encode(bounded).byteLength).toBeLessThanOrEqual(
      SEARCH_MAX_BODY_BYTES_V1,
    );
    expect([...bounded].every((point) => point === "😀")).toBe(true);
  });
});

describe("search row page decoding", () => {
  test("refuses rows a Bot offers on another Bot's behalf", () => {
    expect(() =>
      decodeSearchRowPageV1({
        schemaVersion: 1,
        botId: "bot-a",
        rows: [{ ...ROW, botId: "bot-b" }],
      }),
    ).toThrow("another Bot");
  });

  test("round-trips a page with a cursor", () => {
    const page = {
      schemaVersion: 1 as const,
      botId: "bot-a",
      rows: [ROW],
      nextCursor: "run-index:2026-08-31T00:00:00.000Z:run-1",
    };
    expect(decodeSearchRowPageV1(page)).toEqual(page);
  });
});

describe("search query decoding", () => {
  test("round-trips a full query", () => {
    const query = {
      schemaVersion: 1 as const,
      query: "gym",
      before: "p50",
      kinds: ["user" as const, "tool" as const],
      botId: "bot-a",
      includeArchived: true,
    };
    expect(decodeSearchQueryV1(query)).toEqual(query);
  });

  test("refuses an empty or over-long kinds list", () => {
    expect(() =>
      decodeSearchQueryV1({ schemaVersion: 1, query: "gym", kinds: [] }),
    ).toThrow();
    expect(() =>
      decodeSearchQueryV1({ schemaVersion: 1, query: "gym", kinds: ["nope"] }),
    ).toThrow();
  });

  test("refuses an over-long query string", () => {
    expect(() =>
      decodeSearchQueryV1({ schemaVersion: 1, query: "x".repeat(257) }),
    ).toThrow("bounded string");
  });

  test("refuses the wrong schema version", () => {
    expect(() =>
      decodeSearchQueryV1({ schemaVersion: 2, query: "gym" }),
    ).toThrow("schemaVersion");
  });
});

describe("deep links", () => {
  test("name the Bot and the turn anchor", () => {
    expect(searchDeepLinkV1("bot a", "run-1")).toBe("/?bot=bot%20a#turn-run-1");
    expect(searchTurnAnchorV1("run-1")).toBe("turn-run-1");
  });
});
