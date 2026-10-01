import { describe, expect, test } from "bun:test";
import type {
  EmailSendOutcomeV1,
  EmailSendRequestV1,
  EmailSenderV1,
} from "@frockbot/app/email/sender";
import { createInvitationNoticeSenderV1 } from "./invitation-notice.js";

function fakeAuthority(claims: boolean[]) {
  const recorded: unknown[] = [];
  return {
    recorded,
    authority: () => ({
      claimInvitationNotice: () =>
        Promise.resolve({ schemaVersion: 1, claimed: claims.shift() ?? false }),
      recordInvitationNotice: (input: unknown) => {
        recorded.push(input);
        return Promise.resolve({ schemaVersion: 1 });
      },
    }),
  };
}

function fakeSender(outcome: EmailSendOutcomeV1) {
  const sent: EmailSendRequestV1[] = [];
  const sender: EmailSenderV1 = {
    domain: "bots.frockbot.com",
    send: (request) => {
      sent.push(request);
      return Promise.resolve(outcome);
    },
  };
  return { sent, sender };
}

const options = {
  origin: "https://bot.frockbot.com",
  productName: "FrockBot",
  senderName: "FrockBot",
};

describe("an invitation's email", () => {
  test("is sent once from the deployment's own address and its outcome kept", async () => {
    const { authority, recorded } = fakeAuthority([true, false]);
    const { sender, sent } = fakeSender({ status: "sent", messageId: "m1" });
    const send = createInvitationNoticeSenderV1({
      ...options,
      authority,
      sender,
    });

    await send("person@example.com");
    await send("person@example.com");

    expect(sent).toHaveLength(1);
    expect(sent[0]?.from.address).toBe("frockbot@bots.frockbot.com");
    expect(sent[0]?.to).toEqual(["person@example.com"]);
    expect(recorded).toEqual([
      { schemaVersion: 1, email: "person@example.com", status: "sent" },
    ]);
  });

  test("a send that may have left is recorded as unknown, with the reason", async () => {
    const { authority, recorded } = fakeAuthority([true]);
    const { sender } = fakeSender({
      status: "unknown",
      reason: "the message may have been sent: timeout",
    });
    await createInvitationNoticeSenderV1({ ...options, authority, sender })(
      "person@example.com",
    );
    expect(recorded).toEqual([
      {
        schemaVersion: 1,
        email: "person@example.com",
        status: "unknown",
        detail: "the message may have been sent: timeout",
      },
    ]);
  });

  test("a deployment with no sender claims nothing", async () => {
    let asked = false;
    await createInvitationNoticeSenderV1({
      ...options,
      sender: undefined,
      authority: () => {
        asked = true;
        return fakeAuthority([true]).authority();
      },
    })("person@example.com");
    expect(asked).toBe(false);
  });
});
