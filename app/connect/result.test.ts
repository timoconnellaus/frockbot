import { describe, expect, test } from "bun:test";
import { connectResultV1, GMAIL_RESULT_MAX_CHARS_V1 } from "./result.js";

const emailHtml = `<html><head><style>${"td{color:red}".repeat(400)}</style></head><body><table><tr><td><p>Thrilling Break Room Experience - Adult</p><p>Voucher code RB-8090192</p><a href="https://www.redballoon.com.au/voucher?id=8090192&amp;src=email">View your voucher</a></td></tr></table>${"<div>&nbsp;</div>".repeat(2_000)}</body></html>`;

function parsed(content: string) {
  return JSON.parse(content) as Record<string, unknown>;
}

describe("a Gmail answer", () => {
  test("keeps a small answer exactly as Gmail sent it", () => {
    const data = { messages: [{ id: "m1", subject: "Hi <b>there</b>" }] };
    expect(connectResultV1("GMAIL_FETCH_EMAILS", data)).toEqual({
      content: JSON.stringify(data),
      isError: false,
    });
  });

  test("reads an HTML body as its words and links, and leaves encoded parts out", () => {
    const result = connectResultV1("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", {
      messageId: "m1",
      messageText: emailHtml,
      payload: { parts: [{ body: { data: "QUJD".repeat(20_000) } }] },
    });
    const body = parsed(result.content) as {
      messageId: string;
      messageText: string;
      payload: { parts: { body: { data: string } }[] };
    };
    expect(body.messageId).toBe("m1");
    expect(body.messageText).toContain(
      "Thrilling Break Room Experience - Adult",
    );
    expect(body.messageText).toContain(
      "https://www.redballoon.com.au/voucher?id=8090192&src=email",
    );
    expect(body.messageText).not.toContain("<td>");
    expect(body.messageText).not.toContain("color:red");
    expect(body.payload.parts[0]!.body.data).toBe(
      "[80000 characters of encoded data left out]",
    );
    expect(result.content.length).toBeLessThan(1_000);
  });

  test("leaves text that only mentions a tag, and a long token, alone", () => {
    const readme = `# Title\n\nUse <p> for paragraphs. ${"a < b and c > d. ".repeat(100)}`;
    const cursor = "a1B2".repeat(500);
    const data = { readme, nextPageToken: cursor };
    expect(connectResultV1("GMAIL_FETCH_EMAILS", data).content).toBe(
      JSON.stringify(data),
    );
  });

  test("a body built to be slow to read is not", () => {
    const hostile = `<div>${" ".repeat(200_000)}x</div>`;
    const started = performance.now();
    connectResultV1("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", { body: hostile });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("an answer still too long keeps its beginning and end, and says so", () => {
    const { content, isError } = connectResultV1("GMAIL_FETCH_EMAILS", {
      first: "start-marker",
      rows: Array.from({ length: 5_000 }, (_, index) => `row ${index}`),
      last: "end-marker",
    });
    expect(isError).toBe(false);
    expect(content.length).toBeLessThan(GMAIL_RESULT_MAX_CHARS_V1 + 200);
    expect(content).toContain("start-marker");
    expect(content).toContain("end-marker");
    expect(content).toContain("characters cut here");
  });
});

describe("another app's answer", () => {
  test("goes through as the app sent it, HTML and all", () => {
    const data = { page: emailHtml };
    expect(connectResultV1("NOTION_FETCH_PAGE", data)).toEqual({
      content: JSON.stringify(data),
      isError: false,
    });
  });

  test("is refused past its bound rather than cut", () => {
    expect(
      connectResultV1("NOTION_FETCH_PAGE", { page: "x".repeat(200_000) }),
    ).toEqual({
      content: "The app's answer is too large to show. Ask for less at a time.",
      isError: true,
    });
  });
});
