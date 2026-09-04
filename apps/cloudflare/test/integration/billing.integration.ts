import { describe, expect, it } from "vitest";
import {
  creditWithFakeCheckout,
  expectJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

describe("billing entitlement through the production gateway", () => {
  it("admits a Turn after a paid Checkout and refuses one with no funds", async () => {
    const unfundedUserId = freshUserId("billing-empty");
    const unfundedBotId = "billing-empty-bot";
    await provisionThroughGateway({
      userId: unfundedUserId,
      botId: unfundedBotId,
      funded: false,
    });

    const refused = await postAsUser(
      unfundedUserId,
      `/api/bots/${unfundedBotId}/turns`,
      {
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        text: "hello",
      },
    );
    expect(refused.status).toBe(409);
    expect(await expectJson(refused)).toEqual({
      schemaVersion: 1,
      status: "refused",
      reason: "billing-required",
      error:
        "You need an active plan or credit balance to send a message. Open Billing to continue.",
    });

    await creditWithFakeCheckout(unfundedUserId, 2_500);
    const admitted = await postAsUser(
      unfundedUserId,
      `/api/bots/${unfundedBotId}/turns`,
      {
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        text: "hello",
      },
    );
    expect(admitted.status).toBe(200);
  });
});
