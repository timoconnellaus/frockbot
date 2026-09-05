import { expect, test } from "bun:test";
import valid from "../../../packages/protocol-schemas/fixtures/valid.json";
import invalid from "../../../packages/protocol-schemas/fixtures/invalid.json";
import {
  decodeAcknowledgement,
  decodeNotificationList,
} from "@frockbot/client-core";
import {
  decodeBotStateChannelFrameV1,
  decodeBotStateCursorV1,
} from "@frockbot/protocol";
import {
  decodeAppletViewerTokenV1,
  decodeAppletListViewV1,
  decodeAppletSummaryV1,
  decodeSendToUserPayloadV1,
  decodeSkillRefV1,
} from "@frockbot/kernel-contracts";
import {
  decodeClientConversationListV1,
  decodeClientNotificationAcknowledgementCommandV1,
  decodeClientRunAdmissionFenceCommandV1,
  decodeClientRunListQueryV1,
  decodeClientRunLookupV1,
  decodeClientRunPageV1,
  decodeClientRunReconciliationCommandV1,
  decodeClientRunStopCommandV1,
  decodeClientRunStopReceiptV1,
  decodeClientTurnCommandV1,
  decodeClientTurnV1,
  decodeClientTurnRefusalV1,
  decodeRunCursorV1,
} from "@frockbot/plugin-shell/run-protocol";
import { CLIENT_VERSION_DEGRADED_MESSAGE_V1 } from "@frockbot/plugin-shell/run-failure-copy";
import {
  decodeBotUnreadCommandV1,
  decodeBotUnreadDirectoryViewV1,
} from "@frockbot/plugin-shell/unread";
import {
  decodeDirectoryViewV1,
  decodeBotLifecycleCommandV1,
  decodeBotLifecycleViewV1,
  decodeBotLifecycleReceiptV1,
  decodeCreateBotCommandV1,
} from "@frockbot/plugin-flock/shared";

const existing: Record<string, (value: unknown) => unknown> = {
  TurnCommand: decodeClientTurnCommandV1,
  TurnResponse: decodeClientTurnV1,
  AppletDirectory: decodeAppletListViewV1,
  AppletSummary: decodeAppletSummaryV1,
  StopCommand: decodeClientRunStopCommandV1,
  StopReceipt: decodeClientRunStopReceiptV1,
  RunFenceCommand: decodeClientRunAdmissionFenceCommandV1,
  ReconcileCommand: decodeClientRunReconciliationCommandV1,
  ConversationList: decodeClientConversationListV1,
  ConversationProjection: decodeClientRunPageV1,
  ConversationQuery: decodeClientRunListQueryV1,
  RunLookup: decodeClientRunLookupV1,
  Run: (value) =>
    decodeClientRunPageV1({
      schemaVersion: 1,
      runs: [value],
      page: { truncated: false },
    }),
  TurnRefusal: (value) => {
    const decoded = decodeClientTurnRefusalV1(value);
    if (!decoded) throw new Error("not a refusal");
    return decoded;
  },
  StateFrame: (value) => decodeBotStateChannelFrameV1(JSON.stringify(value)),
  ObserverCursor: decodeBotStateCursorV1,
  RunCursor: (value) => {
    if (typeof value !== "string") throw new Error("not a cursor");
    return decodeRunCursorV1(value);
  },
  AppletViewerToken: decodeAppletViewerTokenV1,
  SendPayload: decodeSendToUserPayloadV1,
  SkillRef: decodeSkillRefV1,
  NotificationList: decodeNotificationList,
  NotificationAck: decodeClientNotificationAcknowledgementCommandV1,
  Acknowledgement: decodeAcknowledgement,
  BotDirectory: decodeDirectoryViewV1,
  BotLifecycle: decodeBotLifecycleViewV1,
  BotLifecycleCommand: decodeBotLifecycleCommandV1,
  BotLifecycleReceipt: decodeBotLifecycleReceiptV1,
  BotCreateCommand: decodeCreateBotCommandV1,
  MarkReadCommand: decodeBotUnreadCommandV1,
  UnreadDirectory: decodeBotUnreadDirectoryViewV1,
};

for (const [accepted, fixtures] of [
  [true, valid],
  [false, invalid],
] as const) {
  for (const fixture of fixtures) {
    const decoder = existing[fixture.schema];
    if (!decoder) continue; // New seams have no existing production decoder.
    test(`existing decoder: ${fixture.name}`, () => {
      if (accepted) expect(() => decoder(fixture.value)).not.toThrow();
      else if (fixture.schema === "Run") {
        // Invalid run bodies remain invalid by the language-neutral schema,
        // but the transcript decoder contains their failure to that one row.
        // Its envelope stays readable so neighbouring runs do not disappear.
        expect(decoder(fixture.value)).toMatchObject({
          runs: [
            {
              status: "failed",
              events: [],
              failure: CLIENT_VERSION_DEGRADED_MESSAGE_V1,
            },
          ],
        });
      } else expect(() => decoder(fixture.value)).toThrow();
    });
  }
}
