import { describe, expect, test } from "bun:test";
import { CONNECT_RESULT_MAX_CHARS_V1, shapeConnectResultV1 } from "./result.js";

const emailHtml = `<html><head><style>${"td{color:red}".repeat(400)}</style></head><body><table><tr><td><p>Thrilling Break Room Experience - Adult</p><p>Voucher code RB-8090192</p></td></tr></table>${"<div>&nbsp;</div>".repeat(2_000)}</body></html>`;

describe("a connected app's answer", () => {
  test("keeps a small answer exactly as the app sent it", () => {
    const data = { messages: [{ id: "m1", subject: "Hi <b>there</b>" }] };
    expect(shapeConnectResultV1(data)).toBe(JSON.stringify(data));
  });

  test("reads an HTML body as its words, and leaves encoded parts out", () => {
    const shaped = shapeConnectResultV1({
      messageId: "m1",
      messageText: emailHtml,
      payload: { parts: [{ body: { data: "QUJD".repeat(20_000) } }] },
    });
    const parsed = JSON.parse(shaped) as {
      messageId: string;
      messageText: string;
      payload: { parts: { body: { data: string } }[] };
    };
    expect(parsed.messageId).toBe("m1");
    expect(parsed.messageText).toContain(
      "Thrilling Break Room Experience - Adult",
    );
    expect(parsed.messageText).toContain("Voucher code RB-8090192");
    expect(parsed.messageText).not.toContain("<td>");
    expect(parsed.messageText).not.toContain("color:red");
    expect(parsed.payload.parts[0]!.body.data).toBe(
      "[80000 characters of encoded data left out]",
    );
    expect(shaped.length).toBeLessThan(1_000);
  });

  test("an answer still too long keeps its beginning and end, and says so", () => {
    const shaped = shapeConnectResultV1({
      first: "start-marker",
      rows: Array.from({ length: 5_000 }, (_, index) => `row ${index}`),
      last: "end-marker",
    });
    expect(shaped.length).toBeLessThan(CONNECT_RESULT_MAX_CHARS_V1 + 200);
    expect(shaped).toContain("start-marker");
    expect(shaped).toContain("end-marker");
    expect(shaped).toContain("characters cut here");
  });

  test("an answer with nothing in it is still an answer", () => {
    expect(shapeConnectResultV1(undefined)).toBe("null");
  });
});
