// What the deployment's sender reports, which is what a caller may retry.
import { describe, expect, test } from "bun:test";
import { createBindingEmailSenderV1, type EmailBindingV1 } from "./sender.ts";

const request = {
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
    EMAIL_SENDER_ADDRESS: "bot@example.com",
  })!;
}

describe("the deployment's binding sender", () => {
  test("a deployment missing either half of the sender has none", () => {
    expect(
      createBindingEmailSenderV1({ SEND_EMAIL: binding() }),
    ).toBeUndefined();
    expect(
      createBindingEmailSenderV1({ EMAIL_SENDER_ADDRESS: "bot@example.com" }),
    ).toBeUndefined();
    expect(
      createBindingEmailSenderV1({
        SEND_EMAIL: binding(),
        EMAIL_SENDER_ADDRESS: "  ",
      }),
    ).toBeUndefined();
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
        from: "bot@example.com",
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
      from: "bot@example.com",
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
