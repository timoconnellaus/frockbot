// Integrated acceptance for the startup packets (V1).
//
// One User, several Bots, and the crash points those packets name. Provider
// time is injected. The client double applies committed updates and holds
// opening speech with the real wire budget; it does not stand in for the
// Durable Object.

import { describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import {
  BotDurableAuthority,
  RUN_PREFIX,
  bootstrapGeneration,
  drainPendingPublicationV1,
  SessionEventLog,
  type BotDurableAuthorityHooks,
  type ConversationUpdateV1,
  type OwnedBotTurnCommand,
  type StoredRunV1,
  createStoredRunCodecV1,
} from "@frockbot/core/durable";
import {
  decodeSessionEvent,
  type SessionEvent,
  type SessionEventInput,
} from "@frockbot/core/contracts";
import { MemoryStorage } from "@frockbot/core/durable/testing";
import {
  initializeBotSettingsV1,
  type BotSettingsViewV1,
  type ConnectionView,
} from "@frockbot/core/configuration";
import { createAgentRuntimeHarness } from "@frockbot/app/testkit";
import type { ToolCall, ToolExecutionContext } from "@frockbot/core/contracts";
import {
  CONNECT_CATALOG_ALARM_FETCHES_V1,
  CONNECT_CATALOG_FIRST_USE_MS_V1,
  cleanUndecodableConnectCatalogsV1,
  commitConnectCatalogJobV1,
  connectCatalogBodyKeyV1,
  connectCatalogJobKeyV1,
  dueConnectCatalogJobsV1,
  publishConnectCatalogV1,
} from "../connect/account-catalog.ts";
import { createConfiguredConnectRuntimeContribution } from "../connect/agent.ts";
import { createConnectUserBackendContribution } from "../connect/user.ts";
import type { ConnectToolV1 } from "../connect/composio.ts";
import type { BotDirectoryViewV1 } from "../flock/shared.ts";
import { cleanRetiredMemoryFactObjectsV1 } from "../memory/cleanup.ts";
import { MemoryEngineV1 } from "../memory/engine.ts";
import {
  memoryScopeKeyV1,
  type MemoryAuthorityV1,
  type MemoryScopeRefV1,
} from "../memory/records.ts";
import type { MemorySqlStorageV1, MemorySqlValueV1 } from "../memory/sql.ts";
import { createTestMemoryAuthorityV1 } from "../memory/testing.ts";
import { readConversationSnapshotV1 } from "../shell/conversation-snapshot.ts";
import { visiblePublicationsV1 } from "../shell/conversation-publication.ts";
import { turnToolCatalogPin } from "../shell/tool-catalog-pin.ts";
import { selectStoredWorkingContextV1 } from "../shell/working-context-store.ts";
import {
  encodeVoiceAssistantPcmEnvelopeV1,
  decodeVoiceAssistantPcmEnvelopeV1,
} from "../voice/opening.ts";
import {
  VOICE_ASSISTANT_OPENING_BUFFER_BYTES_V1,
  VOICE_ASSISTANT_PAUSED_REJOIN_WINDOW_MS_V1,
  VOICE_ASSISTANT_REJOIN_WINDOW_MS_V1,
} from "../voice/shared.ts";
import {
  VoiceLedgerV1,
  voiceCallRejoinsV1,
  voiceMeterDayV1,
} from "../voice/ledger.ts";
import {
  VoiceMaintenanceSchedulerV1,
  dueVoiceWorkV1,
  putVoiceWorkV1,
  sealVoiceCallV1,
  voiceWorkKeyV1,
  VOICE_ACTIVATION_KEY_V1,
  type VoiceWorkRecordV1,
} from "../voice/recovery.ts";
import {
  listDirectoryActivityV1,
  projectOpeningDirectoryV1,
} from "../voice/directory.ts";

const USER = "user-1";
const SESSION = `${USER}:alpha`;
const NOW = Date.parse("2026-09-22T12:00:00.000Z");

class CountingStorage extends MemoryStorage {
  lists: Array<{ prefix?: string; limit?: number }> = [];
  gets: string[] = [];

  override get<T>(key: string): Promise<T | undefined> {
    this.gets.push(key);
    return super.get(key);
  }

  override list<T>(options: {
    prefix?: string;
    start?: string;
    end?: string;
    reverse?: boolean;
    limit?: number;
  }): Promise<Map<string, T>> {
    this.lists.push({
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    return super.list(options);
  }

  getAlarm(): Promise<number | null> {
    return Promise.resolve(this.alarmAt ?? null);
  }
}

function cloneStorage(storage: CountingStorage): CountingStorage {
  const copy = new CountingStorage();
  for (const [key, value] of storage.values) {
    copy.values.set(key, structuredClone(value));
  }
  copy.alarmAt = storage.alarmAt;
  return copy;
}

const codec = createStoredRunCodecV1<BotSettingsViewV1>({
  decodeRunId: (value) => value as string,
  decodeConfigurationSnapshot: (value) => value as BotSettingsViewV1,
});

function command(
  runId: string,
  text: string,
  extra: Partial<OwnedBotTurnCommand> = {},
): OwnedBotTurnCommand {
  return {
    userId: USER,
    botId: "alpha",
    runId,
    sessionId: SESSION,
    acceptedAt: "2026-09-22T12:00:00.000Z",
    text,
    lane: "user",
    ...extra,
  };
}

function stamp(
  inputs: SessionEventInput[],
  start = 0,
): ReturnType<typeof decodeSessionEvent>[] {
  return inputs.map((input, index) =>
    decodeSessionEvent({
      ...input,
      seq: start + index,
      timestamp: new Date(1_700_000_000_000 + start + index).toISOString(),
    }),
  );
}

function chatTurn(turn: number, text: string): SessionEventInput[] {
  const replay = turn === 10;
  const events: SessionEventInput[] = [
    { type: "turn/start", turn },
    { type: "turn/admission", turn, turnType: "chat" },
    { type: "step/start", turn, step: 1 },
    {
      type: "user/message",
      turn,
      step: 1,
      messageId: `m-${turn}`,
      text,
    },
  ];
  if (replay) {
    events.push(
      {
        type: "assistant/message",
        turn,
        step: 1,
        requestId: `r-${turn}`,
        text: "",
        toolCalls: [{ id: `c-${turn}`, name: "search", input: {} }],
        providerState: {
          provider: "openai-compatible",
          model: "m",
          connectionId: "conn",
          content: JSON.stringify({ replay: turn }),
        },
      },
      {
        type: "tool/result",
        turn,
        step: 1,
        occurrenceId: `tool:${turn}:1:0`,
        name: "search",
        content: "found",
        isError: false,
        status: "completed",
      },
    );
  }
  events.push(
    {
      type: "assistant/message",
      turn,
      step: 1,
      requestId: `r2-${turn}`,
      text: `answer ${turn}`,
      toolCalls: [],
    },
    { type: "step/end", turn, step: 1, outcome: "completed" },
    { type: "turn/end", turn, outcome: "completed" },
  );
  return events;
}

interface Bubble {
  id: string;
  revision: number;
  text: string;
  height: number;
  cursor: number;
}

/** The height floor the transcript uses before a row has been measured. */
const ROW_HEIGHT_FLOOR = 200;

class ChatClient {
  readonly rows: Bubble[] = [];
  anchorId: string | undefined;
  transcriptGets = 0;

  apply(updates: readonly ConversationUpdateV1[]): void {
    for (const update of updates) {
      if (update.kind !== "message") continue;
      const text = messageText(update);
      if (text === undefined) continue;
      const existing = this.rows.find((row) => row.id === update.entityId);
      if (existing) {
        if (update.revision <= existing.revision) continue;
        existing.revision = update.revision;
        existing.text = text;
        existing.cursor = update.cursor;
        continue;
      }
      this.rows.push({
        id: update.entityId,
        revision: update.revision,
        text,
        height: text.length > 8 ? 480 : ROW_HEIGHT_FLOOR,
        cursor: update.cursor,
      });
    }
    this.rows.sort((left, right) => left.cursor - right.cursor);
    if (!this.anchorId && this.rows.length > 0) {
      this.anchorId = this.rows[0]?.id;
    }
  }

  /** Distance from the anchor to the end. A reverse list keeps this put. */
  tailHeight(): number {
    const index = this.rows.findIndex((row) => row.id === this.anchorId);
    if (index < 0) return 0;
    return this.rows.slice(index + 1).reduce((sum, row) => sum + row.height, 0);
  }

  applyOlderPage(older: readonly Bubble[]): void {
    for (const row of older) {
      const index = this.rows.findIndex((live) => live.id === row.id);
      if (index < 0) {
        this.rows.push({ ...row });
        continue;
      }
      const live = this.rows[index];
      if (!live || row.revision <= live.revision) continue;
      this.rows[index] = { ...row };
    }
    this.rows.sort((left, right) => left.cursor - right.cursor);
  }
}

function messageText(update: ConversationUpdateV1): string | undefined {
  const payload = update.payload;
  if (!payload || typeof payload !== "object") return undefined;
  const event = (payload as { event?: { payload?: { text?: unknown } } }).event;
  const text = event?.payload?.text;
  return typeof text === "string" ? text : undefined;
}

class OpeningSpeech {
  private readonly held: Uint8Array[] = [];
  private heldBytes = 0;
  readonly sent: Uint8Array[] = [];
  private sequence = 0;
  ready = false;
  overflow = false;

  constructor(private readonly attemptId: string) {}

  speak(pcm: Uint8Array): void {
    if (this.overflow) return;
    if (!this.ready) {
      if (
        this.heldBytes + pcm.byteLength >
        VOICE_ASSISTANT_OPENING_BUFFER_BYTES_V1
      ) {
        this.overflow = true;
        this.held.length = 0;
        this.heldBytes = 0;
        return;
      }
      this.held.push(pcm);
      this.heldBytes += pcm.byteLength;
      return;
    }
    this.emit(pcm);
  }

  markReady(): void {
    this.ready = true;
    const queued = this.held.splice(0);
    this.heldBytes = 0;
    for (const pcm of queued) this.emit(pcm);
  }

  cancel(): void {
    this.held.length = 0;
    this.heldBytes = 0;
    this.ready = false;
  }

  holding(): number {
    return this.held.length;
  }

  private emit(pcm: Uint8Array): void {
    const frame = encodeVoiceAssistantPcmEnvelopeV1({
      attemptId: this.attemptId,
      sequence: this.sequence,
      pcm,
    });
    this.sequence += 1;
    const decoded = decodeVoiceAssistantPcmEnvelopeV1(frame);
    if (!decoded) throw new Error("opening frame did not round-trip");
    this.sent.push(decoded.pcm);
  }
}

function gmailTool(description: string): ConnectToolV1 {
  return {
    slug: "GMAIL_SEND_EMAIL",
    name: "send_email",
    description,
    inputSchema: { type: "object", properties: { to: { type: "string" } } },
    version: "20250930_00",
  };
}

function providerTools(slug: string) {
  const upper = slug.toUpperCase();
  return {
    items: [
      {
        slug: `${upper}_SEND`,
        name: "Send",
        description: `Sends via ${slug}.`,
        version: "20250930_00",
        toolkit: { slug },
        input_parameters: {
          type: "object",
          properties: { to: { type: "string" } },
          required: ["to"],
        },
      },
    ],
    next_cursor: null,
  };
}

function connection(id: string, generation = "g1"): ConnectionView {
  return {
    connectionId: id,
    packageId: "connect",
    connectionTypeId: `connect-${id}`,
    displayName: id,
    state: "ready",
    generation,
    safeMetadata: {
      toolkitSlug: id,
      toolkitName: id,
      connectedAccountId: `ca_${id}`,
      namespace: id,
      startedAt: "2026-09-22T00:00:00.000Z",
    },
  };
}

const ALPHA: MemoryScopeRefV1 = {
  kind: "bot",
  userId: USER,
  botId: "alpha",
};
const USER_SCOPE: MemoryScopeRefV1 = { kind: "user", userId: USER };

function memorySql(): MemorySqlStorageV1 & {
  alarmAt: number | null;
  database: Database;
} {
  const database = new Database(":memory:");
  const handle = {
    alarmAt: null as number | null,
    database,
    sql: {
      exec<Row extends Record<string, MemorySqlValueV1>>(
        query: string,
        ...bindings: SQLQueryBindings[]
      ) {
        const rows = database
          .query<Row, SQLQueryBindings[]>(query)
          .all(...bindings);
        return { toArray: () => rows };
      },
    },
    transactionSync<T>(callback: () => T): T {
      return database.transaction(callback)();
    },
    getAlarm(): number | null {
      return handle.alarmAt;
    },
    setAlarm(at: number): void {
      handle.alarmAt = at;
    },
  };
  return handle;
}

function recallTexts(
  engine: MemoryEngineV1,
  authority: MemoryAuthorityV1,
  query: string,
  scopes: readonly MemoryScopeRefV1[],
  semanticItemId?: string,
): string[] {
  const scopeKey = semanticItemId ? memoryScopeKeyV1(scopes[0]!) : undefined;
  const result = engine.recall({
    authority,
    query,
    scopes: [...scopes],
    ...(semanticItemId && scopeKey
      ? {
          semanticRanks: [{ scopeKey, itemId: semanticItemId, rank: 0 }],
          semanticStatus: "complete" as const,
        }
      : {}),
  });
  return result.hits.map((hit) => hit.item.text);
}

describe("startup combined acceptance", () => {
  test("chat, voice, memory and catalogs survive the packet's crash points", async () => {
    expect(CONNECT_CATALOG_FIRST_USE_MS_V1).toBe(5_000);
    expect(CONNECT_CATALOG_ALARM_FETCHES_V1).toBe(1);
    expect(VOICE_ASSISTANT_REJOIN_WINDOW_MS_V1).toBe(60_000);
    expect(VOICE_ASSISTANT_PAUSED_REJOIN_WINDOW_MS_V1).toBe(24 * 60 * 60_000);
    expect(VOICE_ASSISTANT_OPENING_BUFFER_BYTES_V1).toBe(320_000);

    const bot = new CountingStorage();
    const voice = new CountingStorage();
    const catalog = new CountingStorage();
    await catalog.put("user-id", USER);
    const connections = new Map<string, ConnectionView>([
      ["gmail", connection("gmail")],
      ["calendar", connection("calendar")],
      ["slack", connection("slack")],
      ["notion", connection("notion")],
    ]);
    const fetches: string[] = [];
    const delays = new Map<string, number>();
    const contribution = createConnectUserBackendContribution({
      storage: catalog,
      settings: {
        getConnection: (_userId: string, connectionId: string) =>
          Promise.resolve(connections.get(connectionId)),
      } as never,
      apiKey: "project-key",
      now: () => NOW,
      fetch: async (input) => {
        const url = String(input);
        fetches.push(url);
        const slug = new URL(url).searchParams.get("toolkit_slug") ?? "gmail";
        const wait = delays.get(slug);
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        return Response.json(providerTools(slug));
      },
    });

    const directory: BotDirectoryViewV1 = {
      schemaVersion: 1,
      revision: 2,
      bots: [
        {
          schemaVersion: 1,
          botId: "alpha",
          registeredAt: "2026-09-22T00:00:00.000Z",
          initialName: "Alpha seed",
          avatar: {
            schemaVersion: 1,
            characterId: "pixel",
            primary: "#fc85ae",
          },
          currentProfile: { name: "Alpha", sourceRevision: 3 },
        },
        {
          schemaVersion: 1,
          botId: "beta",
          registeredAt: "2026-09-22T00:00:00.000Z",
          initialName: "Beta",
          avatar: {
            schemaVersion: 1,
            characterId: "pixel",
            primary: "#fc85ae",
          },
        },
        {
          schemaVersion: 1,
          botId: "gamma",
          registeredAt: "2026-09-22T00:00:00.000Z",
          initialName: "Gamma",
          avatar: {
            schemaVersion: 1,
            characterId: "pixel",
            primary: "#fc85ae",
          },
        },
      ],
    };
    let unrelatedBotReads = 0;
    const opening = projectOpeningDirectoryV1({
      directory,
      target: { botId: "alpha", name: "Alpha live", description: "Selected" },
    });
    expect(unrelatedBotReads).toBe(0);
    expect(opening.map((bot) => bot.botId)).toEqual(["alpha", "beta", "gamma"]);
    expect(opening.every((bot) => bot.activity === undefined)).toBe(true);
    expect(opening[0]).toMatchObject({
      name: "Alpha live",
      description: "Selected",
    });

    const history = new SessionEventLog(bot);
    let seq = 0;
    for (let turn = 1; turn <= 10; turn += 1) {
      const events = stamp(chatTurn(turn, `question ${turn}`), seq);
      await history.append(SESSION, events);
      seq += events.length;
    }
    const firstSummary = stamp(
      [
        {
          type: "conversation/compaction-intent",
          effectId: "compact-1",
          throughTurn: 4,
          provider: "foundation",
          model: "m",
        },
        {
          type: "conversation/compacted",
          effectId: "compact-1",
          fromTurn: 1,
          throughTurn: 4,
          summary: "SUMMARY-ONE early ferry",
          identifiers: ["dock-42"],
          provider: "foundation",
          model: "m",
        },
      ],
      seq,
    );
    await history.append(SESSION, firstSummary);
    seq += firstSummary.length;
    const secondSummary = stamp(
      [
        {
          type: "conversation/compaction-intent",
          effectId: "compact-2",
          throughTurn: 8,
          provider: "foundation",
          model: "m",
        },
        {
          type: "conversation/compacted",
          effectId: "compact-2",
          fromTurn: 1,
          throughTurn: 8,
          summary: "SUMMARY-TWO later ferry",
          identifiers: ["dock-42"],
          provider: "foundation",
          model: "m",
        },
      ],
      seq,
    );
    await history.append(SESSION, secondSummary);
    bot.gets = [];
    bot.lists = [];
    const contextRequest = {
      sessionId: SESSION,
      currentTurn: 11,
      currentTurnType: "chat" as const,
      currentMessages: [{ role: "user" as const, content: "now" }],
    };
    const firstContext = await selectStoredWorkingContextV1(
      bot,
      contextRequest,
    );
    const pageGets = bot.gets.filter((key) => key.includes("context:page:"));
    const archiveReads = [
      ...bot.gets,
      ...bot.lists.map((list) => list.prefix ?? ""),
    ].filter((key) => key.includes("session-event"));
    expect(pageGets.length).toBeGreaterThan(0);
    expect(pageGets.length).toBeLessThan(10);
    expect(archiveReads).toEqual([]);
    const rendered = JSON.stringify(firstContext);
    expect(rendered).toContain("SUMMARY-TWO later ferry");
    expect(rendered).toContain("dock-42");
    expect(
      firstContext.some(
        (message) =>
          message.role === "user" && message.content === "question 1",
      ),
    ).toBe(false);
    expect(rendered).not.toContain("SUMMARY-ONE");
    const replay = firstContext.find(
      (message) => message.role === "assistant" && message.providerState,
    );
    expect(
      replay?.role === "assistant" ? replay.providerState : undefined,
    ).toMatchObject({
      provider: "openai-compatible",
      model: "m",
      connectionId: "conn",
      content: JSON.stringify({ replay: 10 }),
    });
    expect(rendered).toContain("c-10");
    const evictedContext = await selectStoredWorkingContextV1(
      bot,
      contextRequest,
    );
    expect(evictedContext).toEqual(firstContext);

    const sql = memorySql();
    const at = new Date(NOW);
    let engine = new MemoryEngineV1({ storage: sql, now: () => at });
    const alpha = createTestMemoryAuthorityV1({
      userId: USER,
      botId: "alpha",
    });
    const beta = createTestMemoryAuthorityV1({ userId: USER, botId: "beta" });
    const ferry = engine.write({
      authority: alpha,
      scope: ALPHA,
      content: "Tim likes the ferry.",
      operationKey: "ferry",
    });
    expect(ferry.status).toBe("ok");
    expect(sql.alarmAt).toBeTypeOf("number");
    expect(recallTexts(engine, alpha, "ferry", [ALPHA])).toEqual([
      "Tim likes the ferry.",
    ]);
    const original = engine.write({
      authority: alpha,
      scope: ALPHA,
      content: "Tim teaches on Tuesdays.",
      operationKey: "teaches",
    });
    expect(original.status).toBe("ok");
    if (original.status !== "ok") throw new Error("unreachable");
    const corrected = engine.write({
      authority: alpha,
      scope: ALPHA,
      content: "Tim teaches on Thursdays.",
      operationKey: "teaches-fixed",
      replaces: original.receipt.itemId,
    });
    expect(corrected.status).toBe("ok");
    const gym = engine.write({
      authority: alpha,
      scope: USER_SCOPE,
      content: "The gym code is 4412.",
      operationKey: "gym",
    });
    expect(gym.status).toBe("ok");
    if (gym.status !== "ok") throw new Error("unreachable");
    expect(recallTexts(engine, alpha, "gym code", [USER_SCOPE])).toEqual([
      "The gym code is 4412.",
    ]);
    const forgotten = engine.forget({
      authority: alpha,
      scope: USER_SCOPE,
      operationKey: "forget-gym",
      itemId: gym.receipt.itemId,
    });
    expect(forgotten.status).toBe("ok");
    expect(recallTexts(engine, alpha, "gym code", [USER_SCOPE])).toEqual([]);
    expect(
      recallTexts(engine, alpha, "gym code", [USER_SCOPE], gym.receipt.itemId),
    ).toEqual([]);
    expect(recallTexts(engine, alpha, "teaches", [ALPHA])).toEqual([
      "Tim teaches on Thursdays.",
    ]);
    const preference = engine.write({
      authority: alpha,
      scope: USER_SCOPE,
      content: "Tim prefers a window seat.",
      operationKey: "window",
    });
    expect(preference.status).toBe("ok");
    const notebook = engine.write({
      authority: alpha,
      scope: ALPHA,
      content: "Alpha's notebook is blue.",
      operationKey: "notebook",
    });
    expect(notebook.status).toBe("ok");
    expect(recallTexts(engine, beta, "window seat", [USER_SCOPE])).toEqual([
      "Tim prefers a window seat.",
    ]);
    expect(recallTexts(engine, beta, "notebook", [ALPHA])).toEqual([]);

    await publishConnectCatalogV1(catalog, {
      connectionId: "gmail",
      generation: "g1",
      toolkitSlug: "gmail",
      namespace: "gmail",
      tools: [gmailTool("Sends an email.")],
      now: NOW,
      readConnection: async () => connections.get("gmail"),
    });
    await commitConnectCatalogJobV1(catalog, {
      schemaVersion: 1,
      connectionId: "calendar",
      generation: "g1",
      toolkitSlug: "calendar",
      namespace: "calendar",
      dueAt: NOW,
      attempts: 0,
    });
    const fetchesBeforeStartup = fetches.length;
    const root = createAgentRuntimeHarness();
    let discloseReads = 0;
    const feature = createConfiguredConnectRuntimeContribution({
      capability: {
        packageId: "connect",
        capabilityId: "connect-gmail-tools",
        connectionId: "gmail",
      },
      userId: USER,
      connection: connections.get("gmail")!,
      apiKey: "project-key",
      readAccountCatalog: async (disclose) => {
        if (disclose) discloseReads += 1;
        return contribution.readToolCatalog({
          userId: USER,
          connectionId: "gmail",
          generation: "g1",
          disclose,
        });
      },
      pinToolCatalog: turnToolCatalogPin(bot, "turn-live"),
      permitConnection: async () => connections.get("gmail")?.state === "ready",
    });
    expect(feature).toBeDefined();
    await root.mount(feature!);
    const listed = await root.tools.prepare(
      { id: "list", name: "get_dynamic_tools", input: {} },
      toolContext(),
    );
    expect(listed.kind).not.toBe("denied");
    if (listed.kind === "denied") throw new Error("unreachable");
    const listResult = await root.tools.executePrepared(listed, toolContext());
    expect(listResult.isError).toBe(false);
    expect(fetches.length).toBe(fetchesBeforeStartup);
    expect(discloseReads).toBe(0);
    expect(unrelatedBotReads).toBe(0);
    const disclosed = await runTool(root, {
      id: "disclose",
      name: "get_dynamic_tools",
      input: { namespace: "gmail" },
    });
    expect(disclosed.isError).toBe(false);
    expect(disclosed.content).toContain("Sends an email.");
    expect(discloseReads).toBe(1);
    expect(fetches.length).toBe(fetchesBeforeStartup);
    await publishConnectCatalogV1(catalog, {
      connectionId: "gmail",
      generation: "g1",
      toolkitSlug: "gmail",
      namespace: "gmail",
      tools: [gmailTool("Sends a revised email.")],
      now: NOW,
      readConnection: async () => connections.get("gmail"),
    });
    const again = await runTool(root, {
      id: "disclose-2",
      name: "get_dynamic_tools",
      input: { namespace: "gmail" },
    });
    expect(again.content).toContain("Sends an email.");
    expect(again.content).not.toContain("Sends a revised email.");
    expect(discloseReads).toBe(1);
    const nextTurn = createAgentRuntimeHarness();
    const nextFeature = createConfiguredConnectRuntimeContribution({
      capability: {
        packageId: "connect",
        capabilityId: "connect-gmail-tools",
        connectionId: "gmail",
      },
      userId: USER,
      connection: connections.get("gmail")!,
      apiKey: "project-key",
      readAccountCatalog: async (disclose) => {
        if (disclose) discloseReads += 1;
        return contribution.readToolCatalog({
          userId: USER,
          connectionId: "gmail",
          generation: "g1",
          disclose,
        });
      },
      pinToolCatalog: turnToolCatalogPin(bot, "turn-next"),
      permitConnection: async () => connections.get("gmail")?.state === "ready",
    });
    await nextTurn.mount(nextFeature!);
    const revised = await runTool(nextTurn, {
      id: "disclose-next",
      name: "get_dynamic_tools",
      input: { namespace: "gmail" },
    });
    expect(revised.content).toContain("Sends a revised email.");
    connections.set("gmail", {
      ...connections.get("gmail")!,
      state: "disabled",
    });
    const refused = await runTool(root, {
      id: "send",
      name: "call_dynamic_tool",
      input: {
        namespace: "gmail",
        toolName: "send_email",
        arguments: { to: "a@example.com" },
      },
    });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("revoked");
    expect(fetches.some((url) => url.includes("/execute/"))).toBe(false);
    delays.set("slack", 40);
    const shared = Promise.all([
      contribution.readToolCatalog({
        userId: USER,
        connectionId: "slack",
        generation: "g1",
        disclose: true,
        firstUseMs: 200,
      }),
      contribution.readToolCatalog({
        userId: USER,
        connectionId: "slack",
        generation: "g1",
        disclose: true,
        firstUseMs: 200,
      }),
    ]);
    delays.set("notion", 80);
    const timedOut = await contribution.readToolCatalog({
      userId: USER,
      connectionId: "notion",
      generation: "g1",
      disclose: true,
      firstUseMs: 20,
    });
    expect(timedOut.kind).toBe("unavailable");
    const slackAnswers = await shared;
    expect(slackAnswers.map((answer) => answer.kind)).toEqual([
      "catalog",
      "catalog",
    ]);
    expect(
      fetches.filter((url) => url.includes("toolkit_slug=slack")),
    ).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const dueBeforeAlarm = await dueConnectCatalogJobsV1(catalog, NOW);
    expect(dueBeforeAlarm.some((job) => job.connectionId === "calendar")).toBe(
      true,
    );
    const fetchesBeforeAlarm = fetches.length;
    await contribution.alarm();
    expect(fetches.length - fetchesBeforeAlarm).toBe(1);
    expect(fetches[fetches.length - 1]?.includes("toolkit_slug=calendar")).toBe(
      true,
    );

    const attempt = "2e780bb8-b4e9-42af-a9bc-f3f6aaf37070";
    const speech = new OpeningSpeech(attempt);
    const hello = new Uint8Array([1, 0, 3, 0]);
    const there = new Uint8Array([5, 0, 7, 0]);
    speech.speak(hello);
    speech.speak(there);
    expect(speech.sent).toEqual([]);
    expect(speech.holding()).toBe(2);
    const ledger = new VoiceLedgerV1(voice, USER);
    const openedAt = new Date(NOW);
    const admitted = await ledger.beginCall({
      callId: "call-live",
      deviceKey: "phone",
      connectionId: "socket-1",
      at: openedAt,
      botId: "alpha",
    });
    expect(admitted.status).toBe("admitted");
    if (admitted.status !== "admitted") throw new Error("unreachable");
    await ledger.setCallPaused("socket-1", true, openedAt);
    expect(speech.holding()).toBe(2);
    speech.markReady();
    expect(speech.sent).toEqual([hello, there]);
    const later = new Date(NOW + 10 * 60_000);
    const rejoined = await ledger.beginCall({
      callId: "call-other",
      deviceKey: "phone",
      connectionId: "socket-2",
      at: later,
      botId: "alpha",
    });
    expect(rejoined.status).toBe("admitted");
    if (rejoined.status !== "admitted") throw new Error("unreachable");
    expect(rejoined.rejoined).toBe(true);
    expect(rejoined.call.callId).toBe("call-live");
    expect(rejoined.call.paused).toBe(true);
    const replaced = new OpeningSpeech(attempt);
    replaced.speak(hello);
    replaced.cancel();
    expect(replaced.sent).toEqual([]);
    expect(replaced.holding()).toBe(0);
    await ledger.setCallPaused("socket-2", false, later);
    const overflow = new OpeningSpeech("6d0f3a18-7c1e-4a1b-9d2e-0b6a9c1d4e11");
    overflow.speak(new Uint8Array(VOICE_ASSISTANT_OPENING_BUFFER_BYTES_V1));
    overflow.speak(new Uint8Array([1, 0]));
    expect(overflow.overflow).toBe(true);
    expect(overflow.sent).toEqual([]);
    expect(overflow.holding()).toBe(0);

    for (let index = 0; index < 30; index += 1) {
      await voice.put(voiceWorkKeyV1("transcript", `old-${index}`), {
        schemaVersion: 1,
        kind: "transcript",
        id: `old-${index}`,
        ref: `voice:call:sealed:old-${index}`,
        callId: `old-${index}`,
        state: "done",
        nextAt: NOW,
        attempts: 1,
      } satisfies VoiceWorkRecordV1);
      await voice.put(`voice:call:sealed:old-${index}`, {
        schemaVersion: 1,
        callId: `old-${index}`,
      });
    }
    voice.lists = [];
    await voice.get(VOICE_ACTIVATION_KEY_V1);
    await ledger.currentCall();
    const due = await dueVoiceWorkV1(voice, NOW);
    expect(
      voice.lists.some((list) =>
        (list.prefix ?? "").startsWith("voice:call:sealed"),
      ),
    ).toBe(false);
    expect(voice.lists.every((list) => list.limit !== undefined)).toBe(true);
    expect(due).toEqual([]);
    const wakes: string[] = [];
    const scheduler = new VoiceMaintenanceSchedulerV1(async (_delay, token) => {
      wakes.push(token);
    });
    await scheduler.commit(async () => {
      await sealVoiceCallV1(voice, {
        callId: "call-done",
        botId: "alpha",
        startedAt: openedAt.toISOString(),
        endedAt: later.toISOString(),
        turnSequence: 1,
        now: NOW,
      });
    });
    expect(wakes).toHaveLength(1);
    const delivered: string[] = [];
    const seen = new Set<string>();
    const receiveTranscript = (callId: string) => {
      if (seen.has(callId)) return;
      seen.add(callId);
      delivered.push(callId);
    };
    const evictedScheduler = new VoiceMaintenanceSchedulerV1(
      async (_delay, token) => {
        wakes.push(token);
      },
    );
    const drainMaintenance = async () => {
      const batch = await dueVoiceWorkV1(voice, NOW);
      const transcript = batch.find((work) => work.kind === "transcript");
      if (transcript) {
        receiveTranscript(transcript.callId);
        receiveTranscript(transcript.callId);
        await putVoiceWorkV1(voice, { ...transcript, state: "done" });
        return;
      }
      const memory = batch.find((work) => work.kind === "memory");
      if (memory) await putVoiceWorkV1(voice, { ...memory, state: "done" });
    };
    const continued = await evictedScheduler.onCallback({
      pending: async () => (await dueVoiceWorkV1(voice, NOW, 1)).length > 0,
      drain: drainMaintenance,
    });
    expect(continued).toBe("continued");
    expect(delivered).toEqual(["call-done"]);
    const memoryPass = await evictedScheduler.onCallback({
      pending: async () => (await dueVoiceWorkV1(voice, NOW, 1)).length > 0,
      drain: drainMaintenance,
    });
    expect(memoryPass).toBe("continued");
    expect(delivered).toEqual(["call-done"]);
    const stopped = await evictedScheduler.onCallback({
      pending: async () => (await dueVoiceWorkV1(voice, NOW, 1)).length > 0,
      drain: async () => {
        delivered.push("again");
      },
    });
    expect(stopped).toBe("stopped");
    expect(delivered).toEqual(["call-done"]);

    const client = new ChatClient();
    let crashCopy: CountingStorage | undefined;
    const generations: string[] = [];
    let releaseRun: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let markPersisted: (() => void) | undefined;
    const persisted = new Promise<void>((resolve) => {
      markPersisted = resolve;
    });
    const settings = initializeBotSettingsV1("alpha");
    const hooks = (
      storage: CountingStorage,
    ): BotDurableAuthorityHooks<BotSettingsViewV1> => ({
      resolveAdmissionSnapshot: () => Promise.resolve(settings),
      bootstrapComposition: () =>
        bootstrapGeneration({ createdAt: "2026-09-22T00:00:00.000Z" }),
      admittedSnapshot: () => Promise.resolve(settings),
      visiblePublications: (input) => visiblePublicationsV1(input),
      deliverPublication: async (updates) => {
        if (!crashCopy) crashCopy = cloneStorage(storage);
        client.apply(updates);
      },
      executeTurn: async (input) => {
        generations.push(input.compositionGenerationId);
        if (input.command.runId === "run-1") {
          if (!client.rows.some((row) => row.text === "hello")) {
            await input.persistSessionEvents(SESSION, [
              stampedSend(input.cursor.nextSeq, "hello", "occ-hello"),
            ]);
          }
          markPersisted?.();
          await gate;
        }
        if (input.command.runId === "run-2") {
          await input.persistSessionEvents(SESSION, [
            stampedSend(input.cursor.nextSeq, "On my way", "occ-reply"),
          ]);
        } else if (input.command.runId !== "run-1") {
          throw new Error(`unexpected run ${input.command.runId}`);
        }
        return {
          runId: input.command.runId,
          text: input.command.text,
          events: [],
        };
      },
      notification: () => undefined,
      scheduledDeadlines: () => Promise.resolve([]),
      scheduledWorkInFlight: () => false,
      deferScheduledWork: () => Promise.resolve(),
      settleScheduledWork: () => Promise.resolve(),
    });
    const authority = new BotDurableAuthority({
      state: { storage: bot } as never,
      codec,
      hooks: hooks(bot),
    });
    const first = authority.run(command("run-1", "hello"));
    const started = await Promise.race([
      persisted.then(() => "persisted" as const),
      first.then(
        () => "finished" as const,
        (error: unknown) => {
          throw error;
        },
      ),
    ]);
    expect(started).toBe("persisted");
    expect(client.rows.map((row) => row.text)).toEqual(["hello"]);
    expect(client.transcriptGets).toBe(0);
    expect(crashCopy).toBeDefined();
    await drainPendingPublicationV1(crashCopy!, (updates) => {
      client.apply(updates);
    });
    expect(client.rows.map((row) => row.text)).toEqual(["hello"]);
    const receipt = await authority.admit(command("run-2", "On my way"));
    expect(receipt.disposition).toBe("queued");
    const admittedPin = (
      bot.values.get(`${RUN_PREFIX}run-2`) as StoredRunV1<BotSettingsViewV1>
    ).compositionGenerationId;
    const evictedBot = cloneStorage(bot);
    evictedBot.values.set("composition:current", {
      schemaVersion: 1,
      generationId: "generation-later",
    });
    releaseRun?.();
    await first;
    const restarted = new BotDurableAuthority({
      state: { storage: evictedBot } as never,
      codec,
      hooks: hooks(evictedBot),
    });
    await restarted.alarm();
    await restarted.alarm();
    expect(client.rows.map((row) => row.text)).toEqual(["hello", "On my way"]);
    expect(new Set(client.rows.map((row) => row.text)).size).toBe(2);
    expect(generations.at(-1)).toBe(admittedPin);
    expect(generations.at(-1)).not.toBe("generation-later");
    expect(client.transcriptGets).toBe(0);
    const listsBeforeSnapshot = bot.lists.length;
    await readConversationSnapshotV1(bot);
    const snapshotLists = bot.lists.slice(listsBeforeSnapshot);
    expect(snapshotLists.every((list) => list.limit !== undefined)).toBe(true);
    expect(
      snapshotLists.some((list) =>
        (list.prefix ?? "").includes("session-event"),
      ),
    ).toBe(false);
    const anchor = client.anchorId;
    const tail = client.tailHeight();
    const reply = client.rows[1]!;
    client.applyOlderPage([
      {
        id: "older-row",
        revision: 1,
        text: "earlier",
        height: 640,
        cursor: 0,
      },
      {
        id: reply.id,
        revision: reply.revision - 1,
        text: "STALE",
        height: 10,
        cursor: reply.cursor,
      },
    ]);
    expect(client.anchorId).toBe(anchor);
    expect(client.tailHeight()).toBe(tail);
    expect(client.rows.find((row) => row.id === reply.id)?.text).toBe(
      "On my way",
    );
    expect(client.rows.find((row) => row.id === reply.id)?.height).toBe(480);
    expect(client.rows.some((row) => row.text === "earlier")).toBe(true);

    const cold = new CountingStorage();
    const coldRuns: string[] = [];
    const coldHooks: BotDurableAuthorityHooks<BotSettingsViewV1> = {
      ...hooks(cold),
      executeTurn: async (input) => {
        coldRuns.push(input.command.runId);
        return { runId: input.command.runId, text: "ok", events: [] };
      },
      deliverPublication: () => Promise.resolve(),
    };
    const coldAuthority = new BotDurableAuthority({
      state: { storage: cold } as never,
      codec,
      hooks: coldHooks,
      kickDriver: false,
    });
    const coldReceipt = await coldAuthority.admit(command("run-cold", "ping"));
    expect(coldReceipt.disposition).toBe("admitted");
    expect(coldRuns).toEqual([]);
    const coldRestarted = new BotDurableAuthority({
      state: { storage: cold } as never,
      codec,
      hooks: coldHooks,
    });
    await coldRestarted.alarm();
    expect(coldRuns).toEqual(["run-cold"]);

    engine = new MemoryEngineV1({ storage: sql, now: () => at });
    expect(engine.nextWakeupAt()).toBeTypeOf("number");
    expect(recallTexts(engine, alpha, "ferry", [ALPHA])).toEqual([
      "Tim likes the ferry.",
    ]);
    const vectors = new Map<string, string>();
    const laterThanJobs = new Date(NOW + 60_000);
    for (let step = 0; step < 12; step += 1) {
      const batch = engine.claimDueWork(laterThanJobs);
      if (batch.kind === "idle") break;
      if (batch.kind === "local") {
        for (const job of batch.jobs) engine.runLocalJob(job);
        continue;
      }
      if (batch.kind === "index") {
        const intent = batch.intent;
        if (intent.operation === "delete") vectors.delete(intent.vectorId);
        else if (intent.text) vectors.set(intent.vectorId, intent.text);
        engine.completeIndexIntent(intent, `mut-${step}`, "unconfirmed");
        continue;
      }
      engine.completeClaimedJob(batch.jobs[0]!, "done");
    }
    expect(engine.claimDueWork(laterThanJobs).kind).toBe("idle");
    const core = engine.preparedCore({
      authority: alpha,
      scopes: [ALPHA, USER_SCOPE],
    });
    const coreText = core.blocks.map((block) => block.text).join("\n");
    expect(coreText).toContain("Tim likes the ferry.");
    expect(coreText).toContain("Tim teaches on Thursdays.");
    expect(coreText).toContain("Tim prefers a window seat.");
    expect(coreText).not.toContain("Tuesdays");
    expect(coreText).not.toContain("4412");
    expect([...vectors.values()]).not.toContain("The gym code is 4412.");
    vectors.set("stale-gym", "The gym code is 4412.");
    expect(
      recallTexts(engine, alpha, "gym code", [USER_SCOPE], gym.receipt.itemId),
    ).toEqual([]);
    expect(recallTexts(engine, beta, "notebook", [ALPHA])).toEqual([]);

    const expiry = new VoiceLedgerV1(new CountingStorage(), USER);
    const liveAt = new Date("2026-09-22T23:00:00.000Z");
    await expiry.beginCall({
      callId: "call-expiry",
      deviceKey: "phone",
      connectionId: "socket-expiry",
      at: liveAt,
      botId: "alpha",
    });
    expect(
      await expiry.endStaleCall(new Date(liveAt.getTime() + 59_000)),
    ).toBeUndefined();
    expect(
      (await expiry.endStaleCall(new Date(liveAt.getTime() + 61_000)))?.callId,
    ).toBe("call-expiry");
    await expiry.beginCall({
      callId: "call-paused",
      deviceKey: "phone",
      connectionId: "socket-paused",
      at: liveAt,
      botId: "alpha",
    });
    await expiry.setCallPaused("socket-paused", true, liveAt);
    const nextMorning = new Date(liveAt.getTime() + 2 * 60 * 60_000);
    expect(voiceMeterDayV1(liveAt)).toBe("2026-09-22");
    expect(voiceMeterDayV1(nextMorning)).toBe("2026-09-23");
    expect(await expiry.rejoins("phone", nextMorning)).toBe(true);
    expect(await expiry.endStaleCall(nextMorning)).toBeUndefined();
    const pausedCall = await expiry.currentCall();
    expect(
      pausedCall && voiceCallRejoinsV1(pausedCall, "phone", nextMorning),
    ).toBe(true);
    expect(
      (await expiry.endStaleCall(new Date(liveAt.getTime() + 25 * 60 * 60_000)))
        ?.callId,
    ).toBe("call-paused");

    const removed: string[] = [];
    const factKeys = Array.from(
      { length: 201 },
      (_value, index) => `bot-memory/log/${index}.md`,
    );
    factKeys.push("bot-memory/notes.md");
    const bucket = {
      list: (options: { prefix: string; limit: number; cursor?: string }) => {
        const start = options.cursor ? Number(options.cursor) : 0;
        const slice = factKeys
          .filter((key) => key.startsWith(options.prefix))
          .slice(start, start + options.limit);
        const next = start + slice.length;
        return Promise.resolve({
          keys: slice,
          ...(next < factKeys.length ? { cursor: String(next) } : {}),
          truncated: next < factKeys.length,
        });
      },
      delete: (key: string) => {
        removed.push(key);
        return Promise.resolve();
      },
    };
    const cleanup = new CountingStorage();
    const firstPass = await cleanRetiredMemoryFactObjectsV1(
      cleanup,
      bucket,
      "bot-memory/",
    );
    expect(firstPass).toBe(200);
    expect(removed).toHaveLength(200);
    expect(removed).not.toContain("bot-memory/notes.md");
    const secondPass = await cleanRetiredMemoryFactObjectsV1(
      cleanup,
      bucket,
      "bot-memory/",
    );
    expect(secondPass).toBe(1);
    expect(removed).toHaveLength(201);
    expect(
      await cleanRetiredMemoryFactObjectsV1(cleanup, bucket, "bot-memory/"),
    ).toBe(0);
    await catalog.put(connectCatalogBodyKeyV1("gmail", "garbage"), "nope");
    await cleanUndecodableConnectCatalogsV1(catalog);
    expect(
      await catalog.get(connectCatalogBodyKeyV1("gmail", "garbage")),
    ).toBeUndefined();
    await cleanUndecodableConnectCatalogsV1(catalog);

    let betaRelease: (() => void) | undefined;
    const betaHeld = new Promise<void>((resolve) => {
      betaRelease = resolve;
    });
    const activity = listDirectoryActivityV1(opening, async (botId) => {
      unrelatedBotReads += 1;
      if (botId === "beta") await betaHeld;
      if (botId === "gamma") return [{ status: "running" }];
      return [{ status: "completed" }];
    });
    expect(opening[1]?.activity).toBeUndefined();
    betaRelease?.();
    const withActivity = await activity;
    expect(unrelatedBotReads).toBe(3);
    expect(withActivity.map((bot) => bot.activity)).toEqual([
      "idle",
      "idle",
      "working",
    ]);
    await root.dispose();
    await nextTurn.dispose();
    sql.database.close();
  });
});

function toolContext(): ToolExecutionContext {
  return {
    botId: "alpha",
    agentId: "alpha",
    sessionId: SESSION,
    compositionGenerationId: "generation",
    effectId: "effect-1",
    turnType: "chat",
    signal: new AbortController().signal,
  };
}

async function runTool(
  root: ReturnType<typeof createAgentRuntimeHarness>,
  call: ToolCall,
) {
  const prepared = await root.tools.prepare(call, toolContext());
  if (prepared.kind === "denied") return prepared.result;
  return root.tools.executePrepared(prepared, toolContext());
}

function stampedSend(
  seq: number,
  text: string,
  occurrenceId: string,
): SessionEvent {
  return {
    type: "send/to-user",
    seq,
    timestamp: "2026-09-22T12:00:10.000Z",
    turn: 1,
    step: 1,
    occurrenceId,
    payload: { type: "text", text },
  } as SessionEvent;
}
