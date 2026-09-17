// What the deployment's sender reports, which is what a caller may retry.
import { describe, expect, mock, test } from "bun:test";
import { composeEmailMessageV1, createBindingEmailSenderV1 } from "./sender.ts";

// The platform module the sender imports only when it actually sends. It does
// not exist outside workerd, so the envelope class stands in for it here.
mock.module("cloudflare:email", () => ({
  EmailMessage: class {
    constructor(
      readonly from: string,
      readonly to: string,
      readonly raw: string,
    ) {}
  },
}));

const request = {
  to: ["nick@example.com", "sam@example.com"],
  subject: "Re: Following up",
  body: "The whole message.",
};

/** The platform binding, refusing whichever envelope recipients are named. */
function binding(refuse: readonly string[] = []) {
  const sent: string[] = [];
  return {
    sent,
    send: (message: unknown) => {
      // `EmailMessage` is the platform class; under Bun the dynamic import
      // fails, so this only ever sees what the sender handed the constructor.
      const recipient = String((message as { to?: unknown }).to ?? "");
      if (refuse.includes(recipient)) {
        return Promise.reject(new Error(`${recipient} is not verified`));
      }
      sent.push(recipient);
      return Promise.resolve();
    },
  };
}

describe("the deployment's binding sender", () => {
  test("a deployment missing either half of the sender has none", () => {
    expect(
      createBindingEmailSenderV1({ SEND_EMAIL: binding() }),
    ).toBeUndefined();
    expect(
      createBindingEmailSenderV1({ EMAIL_SENDER_ADDRESS: "bot@example.com" }),
    ).toBeUndefined();
  });

  // The message left. Reporting that as a failure invites a retry, and a
  // retry would deliver it to whoever did receive it a second time.
  test("one envelope out is a send, with the refused addresses named", async () => {
    const platform = binding(["sam@example.com"]);
    const sender = createBindingEmailSenderV1({
      SEND_EMAIL: platform,
      EMAIL_SENDER_ADDRESS: "bot@example.com",
    })!;
    const outcome = await sender.send(request);
    expect(outcome.status).toBe("sent");
    expect(outcome).toMatchObject({ undelivered: ["sam@example.com"] });
    expect(platform.sent).toEqual(["nick@example.com"]);
  });

  test("nothing out at all is unavailable, and may be tried again", async () => {
    const platform = binding(["nick@example.com", "sam@example.com"]);
    const sender = createBindingEmailSenderV1({
      SEND_EMAIL: platform,
      EMAIL_SENDER_ADDRESS: "bot@example.com",
    })!;
    const outcome = await sender.send(request);
    expect(outcome).toMatchObject({ status: "unavailable" });
    expect(platform.sent).toEqual([]);
  });

  test("every recipient accepted is a send with nothing undelivered", async () => {
    const platform = binding();
    const sender = createBindingEmailSenderV1({
      SEND_EMAIL: platform,
      EMAIL_SENDER_ADDRESS: "bot@example.com",
    })!;
    const outcome = await sender.send({ ...request, cc: ["cc@example.com"] });
    expect(outcome.status).toBe("sent");
    expect(outcome).not.toHaveProperty("undelivered");
    expect(platform.sent).toEqual([
      "nick@example.com",
      "sam@example.com",
      "cc@example.com",
    ]);
  });
});

/**
 * The composed message is this module's own byte contract: an RFC 5322
 * message a recipient's client parses, so what the header block says is
 * asserted here directly.
 */
describe("the composed message's headers", () => {
  const from = { address: "bot@example.com", messageId: "<id@example.com>" };

  function headerBlock(raw: string): string {
    return raw.slice(0, raw.indexOf("\r\n\r\n"));
  }

  /** What a client makes of an encoded-word header: the text that was meant. */
  function decodeHeader(value: string): string {
    return value
      .replace(/\r\n /g, "")
      .replace(/=\?utf-8\?B\?([^?]*)\?=/g, (_match, encoded: string) =>
        new TextDecoder().decode(
          Uint8Array.from(atob(encoded), (character) =>
            character.charCodeAt(0),
          ),
        ),
      );
  }

  test("a subject with an accent and an em dash travels as an encoded-word", () => {
    const raw = composeEmailMessageV1(
      { ...request, subject: "Café — update" },
      from,
    );
    expect(headerBlock(raw)).toContain(
      "Subject: =?utf-8?B?Q2Fmw6kg4oCUIHVwZGF0ZQ==?=",
    );
  });

  test("a plain ASCII subject is the bytes it always was", () => {
    const raw = composeEmailMessageV1(request, from);
    expect(headerBlock(raw)).toContain("Subject: Re: Following up");
    expect(headerBlock(raw)).not.toContain("=?utf-8?B?");
  });

  test("a long encoded subject folds, and every line stays under 998 octets", () => {
    const subject = `Résumé ${"x".repeat(400)}`;
    const raw = composeEmailMessageV1({ ...request, subject }, from);
    const lines = headerBlock(raw).split("\r\n");
    expect(lines.filter((line) => line.startsWith(" ")).length).toBeGreaterThan(
      0,
    );
    for (const line of lines) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(998);
      // No encoded-word may pass 75 octets, folded or not.
      for (const word of line.match(/=\?utf-8\?B\?[^?]*\?=/g) ?? []) {
        expect(word.length).toBeLessThanOrEqual(75);
      }
    }
    const folded = headerBlock(raw)
      .split("\r\nSubject: ")[1]!
      .split(/\r\n(?! )/)[0]!;
    expect(decodeHeader(folded)).toBe(subject);
  });

  test("a display name is encoded while its address is left alone", () => {
    const raw = composeEmailMessageV1(
      {
        ...request,
        to: ["Zoë Dupont <zoe@example.com>"],
        cc: ["cc@example.com"],
      },
      from,
    );
    const block = headerBlock(raw);
    expect(block).toContain("<zoe@example.com>");
    expect(block).toContain("Cc: cc@example.com");
    const to = block.split("\r\nTo: ")[1]!.split(/\r\n(?! )/)[0]!;
    expect(decodeHeader(to)).toBe("Zoë Dupont <zoe@example.com>");
  });
});
