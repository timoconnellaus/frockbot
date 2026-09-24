import { describe, expect, test } from "bun:test";
import {
  COMPUTER_CONNECT_START_DELAY_MS,
  createComputerBotBackendContribution,
} from "@frockbot/computer/bot";
import { MemoryStorage } from "@frockbot/core/durable/testing";
import {
  commitPublicationsV1,
  emptyPublicationHeadV1,
  messageEntityIdV1,
  PUBLICATION_REPLAY_MAX_EVENTS_V1,
  readPublicationHeadV1,
} from "@frockbot/core/durable";
import { BotStateChannel, planHandshakeV1 } from "./bot-state-channel.js";

class ChannelStorage extends MemoryStorage {
  getAlarm(): Promise<number | null> {
    return Promise.resolve(this.alarmAt ?? null);
  }
}

function attachedChannel(runsNoticeIntervalMs = 0): {
  channel: BotStateChannel;
  storage: ChannelStorage;
  sent: string[];
  lastSent: { value: string };
} {
  const storage = new ChannelStorage();
  const sent: string[] = [];
  const lastSent = { value: "0" };
  const socket = {
    deserializeAttachment: () => ({
      schemaVersion: 1,
      userId: "user-1",
      botId: "scout",
      epoch: "1",
      lastSent: lastSent.value,
    }),
    serializeAttachment: (value: { lastSent: string }) => {
      lastSent.value = value.lastSent;
    },
    send: (frame: string) => sent.push(frame),
    close: () => undefined,
  };
  const state = {
    storage,
    getWebSockets: () => [socket],
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback(),
  } as unknown as DurableObjectState;
  const channel = new BotStateChannel(state, { runsNoticeIntervalMs });
  return { channel, storage, sent, lastSent };
}

describe("Bot-state channel Computer storage", () => {
  test("leaves the authority alarm armed immediately after connect admission", async () => {
    const storage = new ChannelStorage();
    const state = {
      storage,
      getWebSockets: () => [],
    } as unknown as DurableObjectState;
    const channel = new BotStateChannel(state);
    const now = new Date("2026-09-03T00:00:00.000Z");
    const computer = createComputerBotBackendContribution({
      storage: channel.computerStorage,
      configured: true,
      providerLabel: "Fake Computer",
      openComputer: () => Promise.reject(new Error("alarm has not fired")),
      now: () => now,
    });
    channel.setAlarmRefresher(async (transaction) => {
      const deadlines = await computer.scheduledDeadlines(transaction);
      if (deadlines.length === 0) await transaction.deleteAlarm();
      else await transaction.setAlarm(Math.min(...deadlines));
    });

    expect(
      await computer.execute("user-1", "scout", {
        version: 1,
        commandId: "connect-1",
        botId: "scout",
        type: "connect",
      }),
    ).toMatchObject({ version: 2, status: "accepted" });

    expect(await storage.getAlarm()).toBe(
      now.getTime() + COMPUTER_CONNECT_START_DELAY_MS,
    );
  });
});

describe("Bot-state channel committed updates", () => {
  test("a committed computer write reaches an attached observer as a typed update", async () => {
    const { channel, storage, sent } = attachedChannel();

    await channel.computerStorage.put("computer:one", 1);

    expect(storage.values.get("computer:one")).toBe(1);
    expect(sent.map((frame) => JSON.parse(frame) as unknown)).toEqual([
      {
        schemaVersion: 1,
        type: "state/update",
        epoch: "1",
        cursor: "1",
        kind: "computer",
        entityId: "computer",
        revision: 1,
        payload: {},
      },
    ]);
    expect(await readPublicationHeadV1(storage)).toMatchObject({
      lastCursor: 1,
      broadcastThrough: 1,
    });
  });

  test("a rolled-back computer write produces no visible event", async () => {
    const { channel, sent } = attachedChannel();

    await expect(
      channel.computerStorage.transaction(async (transaction) => {
        await transaction.put("computer:one", 1);
        throw new Error("rolled back");
      }),
    ).rejects.toThrow(/rolled back/);

    expect(sent).toEqual([]);
  });

  test("conversation updates are not coalesced", async () => {
    const { channel, storage, sent } = attachedChannel(40);
    await storage.transaction((transaction) =>
      commitPublicationsV1(transaction, [
        {
          kind: "message",
          entityId: messageEntityIdV1({
            sessionId: "user-1:scout",
            runId: "run-1",
            occurrenceId: "occ-1",
          }),
          payload: {
            runId: "run-1",
            sessionId: "user-1:scout",
            occurrenceId: "occ-1",
            event: {
              type: "send/to-user",
              payload: { type: "text", text: "one" },
              ordinal: 0,
            },
          },
        },
        {
          kind: "message",
          entityId: messageEntityIdV1({
            sessionId: "user-1:scout",
            runId: "run-1",
            occurrenceId: "occ-2",
          }),
          payload: {
            runId: "run-1",
            sessionId: "user-1:scout",
            occurrenceId: "occ-2",
            event: {
              type: "send/to-user",
              payload: { type: "text", text: "two" },
              ordinal: 1,
            },
          },
        },
      ]),
    );
    await channel.drainBroadcast();
    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[0]!).kind).toBe("message");
    expect(JSON.parse(sent[1]!).kind).toBe("message");
  });

  test("a Run's files reach a protocol 3 socket and are left off an older one", () => {
    const sent = new Map<string, string[]>();
    const socket = (name: string, protocol?: number) => {
      sent.set(name, []);
      let lastSent = "0";
      return {
        deserializeAttachment: () => ({
          schemaVersion: 1,
          userId: "user-1",
          botId: "scout",
          epoch: "1",
          lastSent,
          ...(protocol === undefined ? {} : { protocol }),
        }),
        serializeAttachment: (value: { lastSent: string }) => {
          lastSent = value.lastSent;
        },
        send: (frame: string) => sent.get(name)!.push(frame),
        close: () => undefined,
      };
    };
    const state = {
      storage: new ChannelStorage(),
      getWebSockets: () => [socket("current", 3), socket("installed")],
    } as unknown as DurableObjectState;
    const photo = {
      kind: "image",
      uploadId: "a".repeat(64),
      name: "beach.jpg",
      mediaType: "image/jpeg",
      bytes: 482_113,
    };
    new BotStateChannel(state).broadcastCommitted([
      {
        schemaVersion: 1,
        epoch: 1,
        cursor: 1,
        kind: "run",
        entityId: "run-1",
        revision: 1,
        payload: {
          run: {
            schemaVersion: 4,
            runId: "run-1",
            admittedAt: "2026-09-24T00:00:00.000Z",
            messageRunId: "run-1",
            messageAdmittedAt: "2026-09-24T00:00:00.000Z",
            canRetry: false,
            input: "",
            attachments: [photo],
            status: "running",
            events: [],
          },
        },
      } as never,
    ]);
    const runOf = (name: string) =>
      (JSON.parse(sent.get(name)![0]!) as { payload: { run: object } }).payload
        .run;
    expect(runOf("current")).toMatchObject({ attachments: [photo] });
    expect(runOf("installed")).not.toHaveProperty("attachments");
  });

  test("duplicate delivery is skipped by the observer cursor", async () => {
    const { channel, sent } = attachedChannel();
    await channel.computerStorage.put("computer:one", 1);
    expect(sent).toHaveLength(1);
    channel.broadcastCommitted([
      {
        schemaVersion: 1,
        epoch: 1,
        cursor: 1,
        kind: "computer",
        entityId: "computer",
        revision: 1,
        payload: {},
      },
    ]);
    expect(sent).toHaveLength(1);
  });

  test("no attached observer still completes the broadcast attempt", async () => {
    const storage = new ChannelStorage();
    const state = {
      storage,
      getWebSockets: () => [],
    } as unknown as DurableObjectState;
    const channel = new BotStateChannel(state);
    await channel.computerStorage.put("computer:one", 1);
    expect(await readPublicationHeadV1(storage)).toMatchObject({
      lastCursor: 1,
      broadcastThrough: 1,
    });
  });

  test("retention count is the named replay bound", () => {
    expect(PUBLICATION_REPLAY_MAX_EVENTS_V1).toBe(64);
  });

  test("crash after commit and before drain leaves the pending marker", async () => {
    const storage = new ChannelStorage();
    await storage.transaction((transaction) =>
      commitPublicationsV1(transaction, [
        {
          kind: "message",
          entityId: messageEntityIdV1({
            sessionId: "user-1:scout",
            runId: "run-1",
            occurrenceId: "occ-1",
          }),
          payload: {
            runId: "run-1",
            sessionId: "user-1:scout",
            occurrenceId: "occ-1",
            event: {
              type: "send/to-user",
              payload: { type: "text", text: "held" },
              ordinal: 0,
            },
          },
        },
      ]),
    );
    expect(await readPublicationHeadV1(storage)).toMatchObject({
      lastCursor: 1,
      broadcastThrough: 0,
    });
    expect(
      [...storage.values.keys()].some((key) =>
        key.startsWith("publication-pending:"),
      ),
    ).toBe(true);
  });

  test("handshake reasons distinguish initial, replay, gap and epoch", () => {
    const head = {
      ...emptyPublicationHeadV1(),
      lastCursor: 10,
      firstRetainedCursor: 5,
      broadcastThrough: 10,
    };
    expect(planHandshakeV1(head, undefined, undefined)).toBe("initial");
    expect(planHandshakeV1(head, 7, 1)).toBe("replay");
    expect(planHandshakeV1(head, 3, 1)).toBe("gap");
    expect(planHandshakeV1(head, 12, 1)).toBe("cursor-ahead");
    expect(planHandshakeV1(head, 7, 2)).toBe("epoch");
  });
});

describe("Bot-state channel reply drafts", () => {
  function taggedChannel() {
    const sent: { drafts: string[]; plain: string[] } = {
      drafts: [],
      plain: [],
    };
    const sockets = {
      drafts: { send: (frame: string) => sent.drafts.push(frame) },
      plain: { send: (frame: string) => sent.plain.push(frame) },
    };
    const storage = new ChannelStorage();
    const state = {
      storage,
      getWebSockets: (tag?: string) =>
        tag === "bot-state-v1-drafts"
          ? [sockets.drafts]
          : [sockets.drafts, sockets.plain],
    } as unknown as DurableObjectState;
    return { channel: new BotStateChannel(state), sent, storage };
  }

  test("reach only an observer that asked for them, and write nothing", async () => {
    const { channel, sent, storage } = taggedChannel();
    channel.broadcastDraft({
      runId: "run-1",
      ordinal: 2,
      parts: ["", "Half a rep"],
    });
    expect(sent.plain).toEqual([]);
    expect(sent.drafts.map((frame) => JSON.parse(frame) as unknown)).toEqual([
      {
        schemaVersion: 1,
        type: "state/draft",
        runId: "run-1",
        ordinal: 2,
        parts: ["", "Half a rep"],
      },
    ]);
    expect(await readPublicationHeadV1(storage)).toEqual(
      emptyPublicationHeadV1(),
    );
  });

  test("one too large for a frame is not sent, so the draft stops growing", () => {
    const { channel, sent } = taggedChannel();
    channel.broadcastDraft({
      runId: "run-1",
      ordinal: 0,
      parts: ["☃".repeat(30_000)],
    });
    expect(sent.drafts).toEqual([]);
  });

  test("a silenced channel draws nothing", () => {
    const { channel, sent } = taggedChannel();
    channel.silence();
    channel.broadcastDraft({ runId: "run-1", ordinal: 0, parts: ["Hi"] });
    expect(sent.drafts).toEqual([]);
  });
});
