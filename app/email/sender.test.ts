// What the deployment's sender reports, which is what a caller may retry.
import { describe, expect, test } from "bun:test";
import { createBindingEmailSenderV1, type EmailBindingV1 } from "./sender.ts";

const request = {
  from: { address: "fox.tim@bots.example.com", name: "Fox" },
  to: ["nick@example.com", "sam@example.com"],
  subject: "Café — update",
  body: "The whole message.",
};

/** The platform binding: records each message, or throws what it is told to. */
function binding(failure?: unknown) {
  const sent: Parameters<EmailBindingV1["send"]>[0][] = [];
  return {
    sent,
    send: (message: Parameters<EmailBindingV1["send"]>[0]) => {
      if (failure !== undefined) return Promise.reject(failure);
      sent.push(message);
      return Promise.resolve({ messageId: "<cf-1@example.com>" });
    },
  };
}

/** An error the way the binding throws one: a message and a `code`. */
function platformError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function sender(platform: EmailBindingV1) {
  return createBindingEmailSenderV1({
    SEND_EMAIL: platform,
    EMAIL_DOMAIN: "Bots.Example.com",
  })!;
}

describe("the deployment's binding sender", () => {
  test("a deployment missing either half of the sender has none", () => {
    expect(
      createBindingEmailSenderV1({ SEND_EMAIL: binding() }),
    ).toBeUndefined();
    expect(
      createBindingEmailSenderV1({ EMAIL_DOMAIN: "bots.example.com" }),
    ).toBeUndefined();
    expect(
      createBindingEmailSenderV1({ SEND_EMAIL: binding(), EMAIL_DOMAIN: "  " }),
    ).toBeUndefined();
    expect(sender(binding()).domain).toBe("bots.example.com");
  });

  // The binding cannot be told one domain, so the sender is what holds it.
  test("sends from nowhere but the deployment's email domain", async () => {
    const platform = binding();
    for (const address of [
      "fox.tim@example.com",
      "fox.tim@evil.bots.example.com",
      "fox.tim@bots.example.com.evil",
    ]) {
      expect(
        await sender(platform).send({
          ...request,
          from: { address, name: "Fox" },
        }),
      ).toMatchObject({ status: "unavailable" });
    }
    expect(platform.sent).toEqual([]);
  });

  test("names the Bot, and sends a reply to whoever it is meant for", async () => {
    const platform = binding();
    await sender(platform).send({
      ...request,
      from: { address: "Fox.Tim@bots.example.com", name: "Fox\r\nBcc: x" },
      replyTo: "tim@example.com",
    });
    expect(platform.sent[0]).toMatchObject({
      from: { email: "fox.tim@bots.example.com", name: "Fox Bcc: x" },
      replyTo: "tim@example.com",
    });
  });

  // One message to everyone on it: the provider takes it or refuses it whole,
  // so there is no partial send for a caller to reason about.
  test("sends one message to every recipient, as plain text", async () => {
    const platform = binding();
    const outcome = await sender(platform).send({
      ...request,
      cc: ["cc@example.com"],
    });
    expect(outcome).toEqual({
      status: "sent",
      messageId: "<cf-1@example.com>",
    });
    expect(platform.sent).toEqual([
      {
        from: { email: "fox.tim@bots.example.com", name: "Fox" },
        to: ["nick@example.com", "sam@example.com"],
        cc: ["cc@example.com"],
        subject: "Café — update",
        text: "The whole message.",
      },
    ]);
  });

  test("an answer threads under the message it answers", async () => {
    const platform = binding();
    await sender(platform).send({
      ...request,
      cc: [],
      inReplyTo: "<earlier@example.com>",
    });
    expect(platform.sent[0]).toEqual({
      from: { email: "fox.tim@bots.example.com", name: "Fox" },
      to: request.to,
      subject: request.subject,
      text: request.body,
      headers: {
        "In-Reply-To": "<earlier@example.com>",
        References: "<earlier@example.com>",
      },
    });
  });

  test("a message the provider refused before accepting it may be tried again", async () => {
    for (const code of [
      "E_SENDER_NOT_VERIFIED",
      "E_RATE_LIMIT_EXCEEDED",
      "E_RECIPIENT_SUPPRESSED",
    ]) {
      const outcome = await sender(
        binding(platformError(code, "refused")),
      ).send(request);
      expect(outcome).toEqual({
        status: "unavailable",
        reason: `the message was not sent: ${code}: refused`,
      });
    }
  });

  // A failure that does not say whether the message left is never a failure
  // a caller retries: a retry could deliver it to everyone a second time.
  test("a failure that does not say is unknown, never unavailable", async () => {
    for (const failure of [
      platformError("E_DELIVERY_FAILED", "could not deliver"),
      platformError("E_INTERNAL_SERVER_ERROR", "internal"),
      new Error("the connection was reset"),
    ]) {
      const outcome = await sender(binding(failure)).send(request);
      expect(outcome.status).toBe("unknown");
      expect((outcome as { reason: string }).reason).toMatch(
        /^the message may have been sent: /,
      );
    }
  });
});
