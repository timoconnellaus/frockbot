import { describe, expect, test } from "bun:test";
import {
  ConnectEventError,
  connectEventSignatureV1,
  decodeConnectEventV1,
  normalizeConnectEventSignatureV1,
  verifyConnectEventSignatureV1,
} from "./events.js";

describe("Connected-app event decoding", () => {
  test("reads a trigger.message with nested data", () => {
    expect(
      decodeConnectEventV1({
        type: "composio.trigger.message",
        id: "evt_1",
        data: {
          user_id: "tim",
          trigger_id: "ti_1",
          trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE",
          payload: { subject: "Hello" },
        },
      }),
    ).toEqual({
      kind: "trigger.message",
      eventId: "evt_1",
      userId: "tim",
      triggerInstanceId: "ti_1",
      triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
      payload: { subject: "Hello" },
    });
  });

  test("reads trigger.disabled and connected_account.expired", () => {
    expect(
      decodeConnectEventV1({
        event_type: "trigger.disabled",
        log_id: "evt_2",
        user_id: "tim",
        data: { trigger_nano_id: "ti_2" },
      }),
    ).toMatchObject({
      kind: "trigger.disabled",
      eventId: "evt_2",
      triggerInstanceId: "ti_2",
    });
    expect(
      decodeConnectEventV1({
        type: "connected_account.expired",
        id: "evt_3",
        data: { user_id: "tim", connected_account_id: "ca_1" },
      }),
    ).toMatchObject({
      kind: "connected_account.expired",
      connectedAccountId: "ca_1",
    });
  });

  test("refuses an unknown kind and a body without an id or user", () => {
    expect(() => decodeConnectEventV1({ type: "other", id: "x" })).toThrow(
      ConnectEventError,
    );
    expect(() =>
      decodeConnectEventV1({ type: "trigger.message", id: "x" }),
    ).toThrow(/id or user/);
  });
});

describe("Connected-app event signatures", () => {
  test("accepts a matching HMAC and the prefixes a sender may attach", async () => {
    const body = '{"type":"trigger.message"}';
    const hex = await connectEventSignatureV1("secret", body);
    await verifyConnectEventSignatureV1("secret", body, hex);
    await verifyConnectEventSignatureV1("secret", body, `sha256=${hex}`);
    await verifyConnectEventSignatureV1("secret", body, `v1,${hex}`);
    expect(normalizeConnectEventSignatureV1(`sha256=${hex}`)).toBe(hex);
  });

  test("refuses a miss, an empty presentation, and an empty secret", async () => {
    const body = "{}";
    const hex = await connectEventSignatureV1("secret", body);
    await expect(
      verifyConnectEventSignatureV1("secret", body, "deadbeef"),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      verifyConnectEventSignatureV1("secret", body, ""),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      verifyConnectEventSignatureV1("", body, hex),
    ).rejects.toMatchObject({ status: 401 });
  });
});
