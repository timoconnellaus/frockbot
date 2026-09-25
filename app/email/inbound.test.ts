import { describe, expect, test } from "bun:test";
import { BotTurnRefusedError } from "@frockbot/core/durable";
import {
  inboundEmailRunIdV1,
  receiveInboundEmailV1,
  type InboundEmailHostV1,
  type InboundEmailMessageV1,
} from "./inbound.ts";
import { INBOUND_EMAIL_MAX_BYTES_V1 } from "./shared.ts";
import { pngBytesV1, rawEmailV1, type RawEmailV1 } from "./testing.ts";

const DOMAIN = "in.frock.test";
const TO = `fox.tim@${DOMAIN}`;

function message(
  raw: Uint8Array,
  options: { to?: string; from?: string; rawSize?: number } = {},
): InboundEmailMessageV1 & { rejected?: string } {
  const delivered: InboundEmailMessageV1 & { rejected?: string } = {
    from: options.from ?? "tim@example.com",
    to: options.to ?? TO,
    rawSize: options.rawSize ?? raw.byteLength,
    raw: new Blob([raw as BlobPart]).stream() as ReadableStream<Uint8Array>,
    setReject(reason) {
      delivered.rejected = reason;
    },
  };
  return delivered;
}

function email(overrides: Partial<RawEmailV1> = {}): Uint8Array {
  return rawEmailV1({
    from: "Tim <tim@example.com>",
    to: TO,
    subject: "Agenda",
    messageId: "m1@mail.example.com",
    text: "Draft Tuesday's agenda.",
    ...overrides,
  });
}

/** A host that records everything asked of it, and answers like the real one. */
function host(overrides: Partial<InboundEmailHostV1> = {}) {
  const calls: string[] = [];
  const admitted: Parameters<InboundEmailHostV1["admit"]>[2][] = [];
  const stored: string[] = [];
  const value: InboundEmailHostV1 = {
    domain: DOMAIN,
    resolveUsername: async (username) => {
      calls.push("resolve");
      return username === "tim" ? "u1" : undefined;
    },
    signInEmail: async () => {
      calls.push("sign-in");
      return "tim@example.com";
    },
    accountRefusal: async () => {
      calls.push("account");
      return undefined;
    },
    route: async (_userId, request) => {
      calls.push("route");
      if (request.sender !== request.signInEmail) {
        return { kind: "refused", code: "unverified-sender" };
      }
      return request.slug === "fox"
        ? { kind: "admit", botId: "b-fox" }
        : { kind: "refused", code: "unknown-address" };
    },
    storeAttachment: async (_userId, _botId, file) => {
      calls.push("store");
      stored.push(file.name);
      return file.name.endsWith(".zip")
        ? { status: "refused", reason: "ZIP files can't be sent." }
        : { status: "stored", uploadId: `${stored.length}`.padStart(64, "0") };
    },
    admit: async (_userId, botId, command) => {
      calls.push(`admit ${botId}`);
      admitted.push(command);
    },
    ...overrides,
  };
  return { host: value, calls, admitted, stored };
}

describe("a message from a confirmed sender", () => {
  test("becomes a Turn in the Bot's conversation, keyed by recipient and Message-ID", async () => {
    const { host: h, admitted } = host();
    const delivered = message(email());
    const outcome = await receiveInboundEmailV1(delivered, h);
    const runId = await inboundEmailRunIdV1(TO, "m1@mail.example.com");
    expect(outcome).toEqual({ status: "admitted", runId });
    expect(delivered.rejected).toBeUndefined();
    expect(admitted).toEqual([
      {
        runId,
        text: "Subject: Agenda\n\nDraft Tuesday's agenda.",
        messageId: "m1@mail.example.com",
        attachments: [],
      },
    ]);
  });

  test("a redelivery is the same run, and an admission already made is not an error", async () => {
    const duplicate = new BotTurnRefusedError("duplicate", "already admitted");
    const { host: h } = host({
      admit: async () => {
        throw duplicate;
      },
    });
    const delivered = message(email());
    expect(await receiveInboundEmailV1(delivered, h)).toEqual({
      status: "duplicate",
      runId: await inboundEmailRunIdV1(TO, "m1@mail.example.com"),
    });
    expect(delivered.rejected).toBeUndefined();
  });

  test("brings its files, at most five, and tells the Bot about the rest", async () => {
    const { host: h, admitted, stored } = host();
    const files = [
      { name: "notes.zip", mediaType: "application/zip", bytes: pngBytesV1() },
      ...Array.from({ length: 6 }, (_, index) => ({
        name: `photo-${index}.png`,
        mediaType: "image/png",
        bytes: pngBytesV1(200 + index),
      })),
    ];
    const outcome = await receiveInboundEmailV1(message(email({ files })), h);
    expect(outcome.status).toBe("admitted");
    expect(stored).toEqual([
      "notes.zip",
      "photo-0.png",
      "photo-1.png",
      "photo-2.png",
      "photo-3.png",
      "photo-4.png",
    ]);
    expect(admitted[0]?.attachments).toHaveLength(5);
    expect(admitted[0]?.text).toBe(
      [
        "Subject: Agenda",
        "Draft Tuesday's agenda.",
        "Not attached:\n- notes.zip: ZIP files can't be sent.\n- photo-5.png: a message carries at most 5 files.",
      ].join("\n\n"),
    );
  });

  test("a long body is cut to what the Bot's door takes, and says so", async () => {
    const { host: h, admitted } = host();
    // Three bytes a character: in characters it is under the bound, in bytes
    // well over the door's 32,000.
    const body = "語".repeat(15_000);
    await receiveInboundEmailV1(message(email({ text: body })), h);
    const text = admitted[0]!.text;
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(
      30_000,
    );
    expect(text).toStartWith("Subject: Agenda\n\n語");
    expect(text).toEndWith(
      "[The rest of this email was cut: it was 15,000 characters long.]",
    );
  });

  test("names at most ten files that did not come through", async () => {
    const { host: h, admitted, stored } = host();
    const files = Array.from({ length: 30 }, (_, index) => ({
      name: `archive-${index}.zip`,
      mediaType: "application/zip",
      bytes: pngBytesV1(),
    }));
    await receiveInboundEmailV1(message(email({ files })), h);
    expect(stored).toHaveLength(20);
    const note = admitted[0]!.text.split("\n\n").at(-1)!;
    expect(note.split("\n")).toHaveLength(12);
    expect(note).toEndWith("- and 20 more.");
  });

  test("a full queue is told to the sender; a Bot gone since is refused", async () => {
    const busy = host({
      admit: async () => {
        throw new BotTurnRefusedError("busy", "busy");
      },
    });
    const full = message(email());
    expect(await receiveInboundEmailV1(full, busy.host)).toEqual({
      status: "rejected",
      code: "busy",
    });
    expect(full.rejected).toContain("Try again later");

    const gone = host({
      admit: async () => {
        throw Object.assign(new Error("archived"), {
          name: "BotArchivedError",
        });
      },
    });
    expect(
      await receiveInboundEmailV1(message(email()), gone.host),
    ).toMatchObject({ status: "rejected", code: "bot-unavailable" });
  });

  test("a failure to reach durable state throws, so Email Routing delivers again", async () => {
    const { host: h } = host({
      admit: async () => {
        throw new Error("Durable Object reset");
      },
    });
    await expect(receiveInboundEmailV1(message(email()), h)).rejects.toThrow(
      "Durable Object reset",
    );
  });

  test("the code for a waiting address confirms it, and is no Turn", async () => {
    const {
      host: h,
      admitted,
      calls,
    } = host({
      route: async (_userId, request) => {
        calls.push("route");
        expect(request.codes).toEqual(["7K3P9QXM"]);
        return { kind: "confirmed" };
      },
    });
    const outcome = await receiveInboundEmailV1(
      message(
        email({
          from: "tim@work.example",
          subject: "FROCK-7K3P-9QXM",
          text: "",
        }),
      ),
      h,
    );
    expect(outcome).toEqual({ status: "confirmed" });
    expect(admitted).toEqual([]);
  });
});

describe("a message that may not reach the Bot", () => {
  async function refused(
    delivered: InboundEmailMessageV1 & { rejected?: string },
    overrides: Partial<InboundEmailHostV1> = {},
  ) {
    const recorded = host(overrides);
    const outcome = await receiveInboundEmailV1(delivered, recorded.host);
    expect(outcome.status).toBe("rejected");
    expect(delivered.rejected).toBeDefined();
    expect(recorded.admitted).toEqual([]);
    return { outcome, calls: recorded.calls, reason: delivered.rejected };
  }

  test("is refused before anything is asked when it fails DMARC or names no one", async () => {
    for (const [delivered, code] of [
      [message(email({ verdict: "fail" })), "unauthenticated"],
      [message(email({ verdict: "none" })), "unauthenticated"],
      [
        message(email({ verdict: "i=1; mx.google.com; arc=none" })),
        "unauthenticated",
      ],
      // Passing for the domain it was sent from, not the one it claims.
      [
        message(
          rawEmailV1({
            from: "tim@example.com",
            to: TO,
            messageId: "m@x",
            text: "hi",
            verdict:
              "i=1; mx.cloudflare.net; dmarc=pass header.from=evil.example",
          }),
        ),
        "unauthenticated",
      ],
      [message(email({ from: "a@example.com, b@example.com" })), "bad-from"],
      [message(email({ messageId: undefined })), "no-message-id"],
      [
        message(email({ headers: { "Auto-Submitted": "auto-replied" } })),
        "automatic",
      ],
      [message(email(), { from: "" }), "automatic"],
      [message(email({ subject: undefined, text: "" })), "empty"],
      [message(email(), { to: `fox.tim@elsewhere.test` }), "unknown-address"],
      // No dot: a plain mailbox at the domain is never a Bot's.
      [message(email(), { to: `tim@${DOMAIN}` }), "unknown-address"],
      [message(email(), { to: `red.fox.tim@${DOMAIN}` }), "unknown-address"],
      [message(email(), { to: `fox.postmaster@${DOMAIN}` }), "unknown-address"],
      [
        message(email(), { rawSize: INBOUND_EMAIL_MAX_BYTES_V1 + 1 }),
        "too-large",
      ],
      [message(new TextEncoder().encode("\u0000\u0001")), "bad-from"],
    ] as const) {
      const { outcome, calls } = await refused(delivered);
      expect(outcome).toEqual({ status: "rejected", code });
      expect(calls).toEqual([]);
    }
  });

  test("is refused when the deployment receives no email", async () => {
    const { outcome, calls } = await refused(message(email()), {
      domain: undefined,
    });
    expect(outcome).toEqual({ status: "rejected", code: "off" });
    expect(calls).toEqual([]);
  });

  test("a body larger than it said is refused while it is read", async () => {
    const big = new Uint8Array(INBOUND_EMAIL_MAX_BYTES_V1 + 10);
    const { outcome } = await refused(message(big, { rawSize: 100 }));
    expect(outcome).toEqual({ status: "rejected", code: "too-large" });
  });

  test("a username nobody holds is refused after the directory is asked", async () => {
    const { outcome, calls } = await refused(
      message(email({ to: `fox.nobody@${DOMAIN}` }), {
        to: `fox.nobody@${DOMAIN}`,
      }),
    );
    expect(outcome).toEqual({ status: "rejected", code: "unknown-address" });
    expect(calls).toEqual(["resolve"]);
  });

  test("a slug none of the User's Bots holds, or a Bot that does not receive, is refused", async () => {
    const unknown = await refused(
      message(email({ to: `owl.tim@${DOMAIN}` }), { to: `owl.tim@${DOMAIN}` }),
    );
    expect(unknown.outcome).toEqual({
      status: "rejected",
      code: "unknown-address",
    });
    expect(unknown.calls).toEqual(["resolve", "account", "sign-in", "route"]);
    const off = await refused(message(email()), {
      route: async () => ({ kind: "refused", code: "not-receiving" }),
    });
    expect(off.outcome).toEqual({ status: "rejected", code: "not-receiving" });
    expect(off.reason).toBe("This address does not accept mail right now.");
  });

  test("an authenticated sender who is not the User's is refused without a file stored", async () => {
    const { outcome, calls, reason } = await refused(
      message(
        email({
          from: "eve@evil.example",
          files: [
            { name: "a.png", mediaType: "image/png", bytes: pngBytesV1() },
          ],
        }),
      ),
    );
    expect(outcome).toEqual({ status: "rejected", code: "unverified-sender" });
    expect(calls).toEqual(["resolve", "account", "sign-in", "route"]);
    // Nothing about whose address this is.
    expect(reason).not.toContain("tim");
  });

  test("an account that may not be used is refused before its object decides", async () => {
    const { outcome, calls } = await refused(message(email()), {
      accountRefusal: async () => "Access ended",
    });
    expect(outcome).toEqual({ status: "rejected", code: "account" });
    expect(calls).toEqual(["resolve"]);
  });
});
