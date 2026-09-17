// What the deployment's sender reports, which is what a caller may retry.
import { describe, expect, mock, test } from "bun:test";
import { createBindingEmailSenderV1 } from "./sender.ts";

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
