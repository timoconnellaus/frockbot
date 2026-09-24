import { describe, expect, test } from "bun:test";
import {
  htmlToTextV1,
  parseInboundEmailV1,
  readableBodyV1,
} from "./message.ts";
import { pngBytesV1, rawEmailV1 } from "./testing.ts";

const TO = "abcdefghijklmnopqrstuvwxyz@in.frock.test";

describe("reading one message", () => {
  test("names the one sender, the Message-ID and the words", async () => {
    const email = await parseInboundEmailV1(
      rawEmailV1({
        from: "Tim O'Connell <Tim@Example.com>",
        to: TO,
        subject: "Plan   for\tTuesday",
        messageId: "abc123@mail.example.com",
        text: "Can you draft the agenda?\r\n\r\nThanks",
      }),
    );
    expect(email.from).toBe("tim@example.com");
    expect(email.messageId).toBe("<abc123@mail.example.com>");
    expect(email.subject).toBe("Plan for Tuesday");
    expect(email.body).toBe("Can you draft the agenda?\n\nThanks");
    expect(email.automatic).toBe(false);
    expect(email.headers[0]?.key).toBe("arc-authentication-results");
  });

  test("names no sender when From holds two mailboxes, or there are two Froms", async () => {
    const two = await parseInboundEmailV1(
      rawEmailV1({
        from: "tim@example.com, eve@evil.example",
        to: TO,
        text: "hi",
      }),
    );
    expect(two.from).toBeUndefined();
    const twice = await parseInboundEmailV1(
      rawEmailV1({
        from: "eve@evil.example",
        to: TO,
        text: "hi",
        headers: { From: "tim@example.com" },
      }),
    );
    expect(twice.from).toBeUndefined();
  });

  test("knows a machine wrote it", async () => {
    const email = await parseInboundEmailV1(
      rawEmailV1({
        from: "tim@example.com",
        to: TO,
        text: "I'm away until Monday.",
        headers: { "Auto-Submitted": "auto-replied" },
      }),
    );
    expect(email.automatic).toBe(true);
  });

  test("reads an HTML-only message as its words", async () => {
    expect(
      htmlToTextV1(
        "<html><head><style>p{}</style></head><body><p>Hello&nbsp;there</p><ul><li>one</li><li>two &amp; three</li></ul><blockquote>old thread</blockquote></body></html>",
      ).trim(),
    ).toBe("Hello there\n- one\n- two & three");
  });

  test("reads a body built to be slow in time proportional to its size", () => {
    // Read before the sender is known: a crafted body must cost no more than
    // an ordinary one of its size.
    const started = performance.now();
    expect(htmlToTextV1(`hi${"<style".repeat(60_000)}`)).toBe("hi");
    expect(htmlToTextV1(`hi${"<".repeat(400_000)}`)).toBe("hi");
    expect(htmlToTextV1(`hi<p>${"<li".repeat(100_000)}`)).toBe("hi");
    expect(htmlToTextV1(`${" ".repeat(200_000)}x`)).toBe(
      `${" ".repeat(200_000)}x`,
    );
    expect(readableBodyV1(" ".repeat(200_000), false)).toBe("");
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("carries attachments first, then pictures placed in the body, never a signature's logo", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.4 hello");
    const email = await parseInboundEmailV1(
      rawEmailV1({
        from: "tim@example.com",
        to: TO,
        text: "See attached",
        html: '<p>See attached</p><img src="cid:part0@frock.test"><img src="cid:part1@frock.test">',
        files: [
          {
            name: "screenshot.png",
            mediaType: "image/png",
            bytes: pngBytesV1(40 * 1024),
            inline: true,
          },
          {
            name: "logo.png",
            mediaType: "image/png",
            bytes: pngBytesV1(2 * 1024),
            inline: true,
          },
          { name: "brief.pdf", mediaType: "application/pdf", bytes: pdf },
        ],
      }),
    );
    expect(email.files.map((file) => file.name)).toEqual([
      "brief.pdf",
      "screenshot.png",
    ]);
    expect(email.files[0]?.bytes).toEqual(pdf);
  });
});

describe("the words the person wrote", () => {
  test("cuts a reply's quoted history at the line that introduces it", () => {
    expect(
      readableBodyV1(
        "Yes, Tuesday works.\n\nOn Mon, 21 Sep 2026 at 09:00, Bot <x@y.z> wrote:\n> When suits?\n> Thanks",
        false,
      ),
    ).toBe("Yes, Tuesday works.");
    expect(
      readableBodyV1(
        "Yes.\n\nOn Mon, 21 Sep 2026 at 09:00, A Very Long Name\n<someone@example.com> wrote:\n> earlier",
        false,
      ),
    ).toBe("Yes.");
    expect(
      readableBodyV1(
        "Sounds good\n\n________________________________\nFrom: Someone\nSent: Monday\nTo: Tim\nSubject: Plan",
        false,
      ),
    ).toBe("Sounds good");
    expect(
      readableBodyV1("ok\n-----Original Message-----\nFrom: a@b.c", false),
    ).toBe("ok");
    expect(readableBodyV1("Agreed.\n\n> quoted\n> more\n", false)).toBe(
      "Agreed.",
    );
  });

  test("cuts a signature and a phone's footer", () => {
    expect(
      readableBodyV1("Please summarise.\n\n-- \nTim\nCEO, Example", false),
    ).toBe("Please summarise.");
    expect(
      readableBodyV1("Please summarise.\n\nSent from my iPhone", false),
    ).toBe("Please summarise.");
  });

  test("keeps a forward whole: what was forwarded is the point", () => {
    const forwarded =
      "Can you summarise this?\n\n---------- Forwarded message ---------\nFrom: Vendor <v@vendor.example>\nDate: Mon\nSubject: Invoice\n\nPlease pay by Friday.";
    expect(readableBodyV1(forwarded, true)).toBe(forwarded);
  });
});
