import { describe, expect, test } from "bun:test";
import type { ConnectionView } from "@frockbot/core/configuration";
import {
  CONNECT_TRIGGER_BY_ROUTINE_PREFIX,
  CONNECT_TRIGGER_EFFECT_PREFIX,
  CONNECT_TRIGGER_INSTANCE_PREFIX,
  connectReadyConnectionsV1,
  connectTriggerByRoutineKeyV1,
  connectTriggerEffectKeyV1,
  connectTriggerInstanceKeyV1,
  connectTriggerOffersV1,
  decodeConnectTriggerEffectReceiptV1,
  decodeConnectTriggerInstanceRecordV1,
} from "./triggers.js";

const gmail: ConnectionView = {
  connectionId: "conn-gmail",
  packageId: "connect",
  connectionTypeId: "connect-gmail",
  displayName: "Gmail",
  state: "ready",
  generation: "g1",
  safeMetadata: {
    toolkitSlug: "gmail",
    toolkitName: "Gmail",
    connectedAccountId: "ca_1",
    namespace: "gmail",
    startedAt: "2026-09-11T00:00:00.000Z",
  },
};

describe("Connected-app trigger records", () => {
  test("keys an instance, a Routine, and a command", () => {
    expect(connectTriggerInstanceKeyV1("ti_1")).toBe(
      `${CONNECT_TRIGGER_INSTANCE_PREFIX}ti_1`,
    );
    expect(connectTriggerByRoutineKeyV1("scout", "inbox")).toBe(
      `${CONNECT_TRIGGER_BY_ROUTINE_PREFIX}scout:inbox`,
    );
    expect(connectTriggerEffectKeyV1("cmd-1")).toBe(
      `${CONNECT_TRIGGER_EFFECT_PREFIX}cmd-1`,
    );
  });

  test("decodes an instance and an effect receipt", () => {
    const instance = decodeConnectTriggerInstanceRecordV1({
      schemaVersion: 1,
      instanceId: "ti_1",
      botId: "scout",
      routineId: "inbox",
      connectionId: "conn-gmail",
      triggerType: "GMAIL_NEW_GMAIL_MESSAGE",
    });
    expect(instance?.instanceId).toBe("ti_1");
    expect(
      decodeConnectTriggerEffectReceiptV1({
        schemaVersion: 1,
        commandId: "cmd-1",
        botId: "scout",
        routineId: "inbox",
        status: "upserted",
        instanceId: "ti_1",
      })?.status,
    ).toBe("upserted");
    expect(decodeConnectTriggerInstanceRecordV1({ schemaVersion: 1 })).toBe(
      undefined,
    );
  });

  test("offers only ready Connections of this Package", () => {
    const ready = connectReadyConnectionsV1([
      gmail,
      { ...gmail, connectionId: "other", state: "authorizing" },
      {
        ...gmail,
        connectionId: "slack",
        packageId: "other",
        connectionTypeId: "other",
      },
    ]);
    expect(ready).toHaveLength(1);
    expect(ready[0]?.toolkitSlug).toBe("gmail");
    expect(
      connectTriggerOffersV1(ready[0]!, [
        {
          slug: "GMAIL_NEW_GMAIL_MESSAGE",
          name: "New Gmail message received",
          description: "When a new message arrives.",
          toolkitSlug: "gmail",
        },
        {
          slug: "GMAIL_EMAIL_SENT",
          name: "Email sent",
          description: "When a message is sent.",
          toolkitSlug: "gmail",
        },
      ]),
    ).toEqual([
      {
        connectionId: "conn-gmail",
        connectionLabel: "Gmail",
        toolkitSlug: "gmail",
        toolkitName: "Gmail",
        slug: "GMAIL_NEW_GMAIL_MESSAGE",
        name: "New Gmail message received",
        description: "When a new message arrives.",
      },
      {
        connectionId: "conn-gmail",
        connectionLabel: "Gmail",
        toolkitSlug: "gmail",
        toolkitName: "Gmail",
        slug: "GMAIL_EMAIL_SENT",
        name: "Email sent",
        description: "When a message is sent.",
      },
    ]);
  });
});
