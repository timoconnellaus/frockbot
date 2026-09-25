// The Flock runtime Contribution: what a Bot may change about itself, what it
// records when it does, and what it refuses.
//
// The host here is a small in-memory stand-in for the two Durable Objects,
// built out of the production `applyBotProfilePatchV1` and the production
// `FlockUserBackendContribution`, so what these prove is the real partial-patch
// and directory behaviour rather than a double's.
import { describe, expect, test } from "bun:test";
import {
  applyBotProfilePatchV1,
  ConfigurationConflictError,
  initializeBotSettingsV1,
  type BotSettingsViewV1,
  type ConfigurationCommandV1,
  type OperationReceiptV1,
} from "@frockbot/core/configuration";
import type { SessionEvent } from "@frockbot/core/contracts";
import {
  botCreateCommandIdV1,
  createBotCreateTool,
  createBotMessageTool,
  createGroupBotMessageTool,
  createTeammatesPromptSectionV1,
  createTurnBotDirectoryV1,
  createBotUpdateTool,
  createdBotIdV1,
  decodeBotUpdateInputV1,
  type FlockSelfRuntimeHostV1,
} from "./agent.ts";
import { createFlockUserBackendContribution } from "./user.ts";
import {
  decodeCreateBotCommandV1,
  FlockConflictError,
  type VoiceIdentityViewV1,
} from "./shared.ts";

const OWNER = { userId: "user-1", botId: "bot-1" };
const RUN_ID = "run-chat-1";
const WRITER = {
  kind: "bot" as const,
  botId: "bot-1",
  sessionId: "user-1:bot-1",
  turnId: "turn-4",
};

const CONTEXT = {
  botId: "bot-1",
  agentId: "bot-1",
  sessionId: "user-1:bot-1",
  compositionGenerationId: "2026-08-31T00:00:00.000Z:0123456789abcdef",
  turnType: "chat" as const,
  effectId: "tool:1:1:0",
  signal: new AbortController().signal,
};

/** An in-memory Durable Object storage with the transaction seam Flock uses. */
function memoryStorage() {
  const map = new Map<string, unknown>();
  const surface = {
    get: async <T>(key: string) => map.get(key) as T | undefined,
    put: async (key: unknown, value?: unknown) => {
      if (typeof key === "string") map.set(key, value);
      else
        for (const [entry, item] of Object.entries(
          key as Record<string, unknown>,
        ))
          map.set(entry, item);
    },
    delete: async (key: string) => map.delete(key),
    list: async <T>({ prefix }: { prefix: string }) =>
      new Map(
        [...map.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => [key, value as T]),
      ),
    setAlarm: async () => {},
  };
  return {
    ...surface,
    transaction: async <T>(callback: (tx: typeof surface) => Promise<T>) =>
      callback(surface),
  };
}

interface Harness {
  host: FlockSelfRuntimeHostV1;
  settings(): BotSettingsViewV1;
  announcements(): SessionEvent[];
  commands(): Array<Extract<ConfigurationCommandV1, { botId: string }>>;
  /** Forces the next `commandSelf` to lose an optimistic race exactly once. */
  raceOnce(): void;
  voice(): VoiceIdentityViewV1;
}

function harness(initial?: Partial<BotSettingsViewV1>): Harness {
  let settings: BotSettingsViewV1 = {
    ...initializeBotSettingsV1("bot-1"),
    profile: { name: "General" },
    ...initial,
  };
  const announcements: SessionEvent[] = [];
  const commands: Array<Extract<ConfigurationCommandV1, { botId: string }>> =
    [];
  let race = false;
  // The Bot's voice record, fenced on its own revision exactly as the Bot
  // Durable Object fences it.
  let voice: VoiceIdentityViewV1 = {
    schemaVersion: 1,
    botId: "bot-1",
    revision: 0,
  };
  const storage = memoryStorage();
  const flock = createFlockUserBackendContribution({
    storage,
    now: () => new Date("2026-08-31T10:00:00.000Z"),
    random: () => 0,
    commandBotLifecycle: () => {
      throw new Error("not used");
    },
    readBotLifecycle: () => {
      throw new Error("not used");
    },
  });
  return {
    settings: () => settings,
    announcements: () => announcements,
    commands: () => commands,
    voice: () => structuredClone(voice),
    raceOnce: () => {
      race = true;
    },
    host: {
      owner: OWNER,
      writer: WRITER,
      runId: RUN_ID,
      readSelf: async () => structuredClone(settings),
      commandSelf: async (command): Promise<OperationReceiptV1> => {
        if (race) {
          race = false;
          settings = { ...settings, revision: settings.revision + 1 };
          throw new ConfigurationConflictError(settings.revision);
        }
        if (command.expectedRevision !== settings.revision) {
          throw new ConfigurationConflictError(settings.revision);
        }
        commands.push(command);
        const revision = settings.revision + 1;
        if (command.type === "bot/set-profile") {
          const profile = applyBotProfilePatchV1(
            settings.profile,
            command.profile,
            command.namedBy ?? "user",
          );
          // The Bot Durable Object appends the announcement in the same
          // transaction that writes the name; the seam is reproduced here.
          if (profile.name !== settings.profile.name) {
            announcements.push({
              type: "bot/renamed",
              seq: announcements.length,
              timestamp: "2026-08-31T10:00:00.000Z",
              from: settings.profile.name,
              to: profile.name,
              namedBy: profile.namedBy ?? "user",
              ...(command.writer ? { writer: command.writer } : {}),
            });
          }
          // Hiding mutes in the same write, as the Bot Durable Object does.
          settings = {
            ...settings,
            revision,
            profile,
            ...(profile.hiddenFromSidebar
              ? { notifications: { enabled: false } }
              : {}),
          };
        } else if (command.type === "bot/update-notifications") {
          settings = {
            ...settings,
            revision,
            notifications: command.notifications,
          };
        } else {
          throw new Error(`unexpected command ${command.type}`);
        }
        return {
          schemaVersion: 1,
          commandId: command.commandId,
          revision,
          status: "applied",
        };
      },
      listBots: () => flock.listBots(),
      messageBot: async (request) => ({
        targetBotId: request.targetBotId,
        targetBotName: "Teammate",
        runId: `agent-${request.effectId}`,
        text: "Teammate answer",
      }),
      createBot: (command) =>
        // The command crosses the User Durable Object seam, so it decodes on
        // the way in exactly as the production RPC does.
        flock.createBot(OWNER.userId, decodeCreateBotCommandV1(command)),
      readOwnVoice: async () => ({
        revision: voice.revision,
        ...(voice.voice ? { voice: structuredClone(voice.voice) } : {}),
        // "cat" is the registered character, so an unset voice resolves to its
        // default rather than the deployment-wide one.
        characterId: "cat",
      }),
      updateOwnVoice: async (command) => {
        if (command.expectedRevision !== voice.revision) {
          throw new FlockConflictError(voice.revision);
        }
        voice = {
          schemaVersion: 1,
          botId: command.botId,
          revision: voice.revision + 1,
          voice: structuredClone(command.voice),
        };
        return {
          schemaVersion: 1,
          commandId: command.commandId,
          status: "applied",
          revision: voice.revision,
        };
      },
    },
  };
}

describe("bot_update", () => {
  test("changes only the fields it was given", async () => {
    const test1 = harness({
      profile: {
        name: "General",
        description: "A helper.",
        sidebarOrder: 1000,
      },
    });
    const tool = createBotUpdateTool(test1.host);

    const result = await tool.execute(
      { description: "Chief of staff" },
      CONTEXT,
    );

    expect(result.isError).toBe(false);
    expect(test1.settings().profile).toEqual({
      name: "General",
      description: "Chief of staff",
      sidebarOrder: 1000,
    });
    expect(test1.announcements()).toEqual([]);
  });

  test("clears an optional field with the empty string", async () => {
    const test1 = harness({
      profile: { name: "General", description: "A helper." },
    });

    await createBotUpdateTool(test1.host).execute({ description: "" }, CONTEXT);

    expect(test1.settings().profile).toEqual({ name: "General" });
  });

  test("has no title to set", () => {
    expect(() => decodeBotUpdateInputV1({ title: "Aide" })).toThrow(
      "input has unknown fields",
    );
  });

  test("a self-rename records the Bot as the writer and announces it", async () => {
    const test1 = harness();

    const result = await createBotUpdateTool(test1.host).execute(
      { name: "Chief of staff" },
      CONTEXT,
    );

    expect(result.isError).toBe(false);
    expect(test1.settings().profile).toEqual({
      name: "Chief of staff",
      namedBy: "bot",
    });
    expect(test1.announcements()).toEqual([
      {
        type: "bot/renamed",
        seq: 0,
        timestamp: "2026-08-31T10:00:00.000Z",
        from: "General",
        to: "Chief of staff",
        namedBy: "bot",
        writer: WRITER,
      },
    ]);
    // The provenance the command carried is the Bot itself, never a target.
    const command = test1.commands()[0]!;
    expect(command.type).toBe("bot/set-profile");
    expect(
      command.type === "bot/set-profile" ? command.namedBy : undefined,
    ).toBe("bot");
    expect(
      command.type === "bot/set-profile" ? command.writer : undefined,
    ).toEqual(WRITER);
  });

  test("writes nothing when the profile already holds every value", async () => {
    const test1 = harness({
      profile: { name: "General", description: "Aide" },
    });

    const result = await createBotUpdateTool(test1.host).execute(
      { description: "Aide" },
      CONTEXT,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Nothing changed");
    expect(test1.commands()).toEqual([]);
  });

  test("a replay after eviction re-runs without a second announcement", async () => {
    const test1 = harness();
    const tool = createBotUpdateTool(test1.host);

    await tool.execute({ name: "Chief of staff" }, CONTEXT);
    // The registry recovers an idempotent tool by executing it again under the
    // same effect id.
    expect(tool.idempotent).toBe(true);
    const replay = await tool.execute({ name: "Chief of staff" }, CONTEXT);

    expect(replay.isError).toBe(false);
    expect(test1.announcements()).toHaveLength(1);
    expect(test1.commands()).toHaveLength(1);
  });

  test("changes notifications alongside the profile", async () => {
    const test1 = harness();

    const result = await createBotUpdateTool(test1.host).execute(
      { description: "Aide", notify_on_updates: false },
      CONTEXT,
    );

    expect(result.isError).toBe(false);
    expect(test1.settings().notifications).toEqual({ enabled: false });
    expect(test1.commands().map((command) => command.type)).toEqual([
      "bot/set-profile",
      "bot/update-notifications",
    ]);
  });

  test("hiding reports the mute it made, in one command", async () => {
    const test1 = harness();

    const result = await createBotUpdateTool(test1.host).execute(
      { hidden_from_sidebar: true },
      CONTEXT,
    );

    expect(result.content).toBe(
      "Updated hidden_from_sidebar, notify_on_updates. Everything else is unchanged.",
    );
    expect(test1.settings().notifications).toEqual({ enabled: false });
    expect(test1.commands().map((command) => command.type)).toEqual([
      "bot/set-profile",
    ]);
  });

  test("refuses notifications for a hidden Bot before writing anything", async () => {
    const test1 = harness({ profile: { name: "General" } });

    const result = await createBotUpdateTool(test1.host).execute(
      { hidden_from_sidebar: true, notify_on_updates: true },
      CONTEXT,
    );

    expect(result.isError).toBe(true);
    expect(test1.commands()).toEqual([]);
    expect(test1.settings().profile.hiddenFromSidebar).toBeUndefined();
  });

  test("re-issues the command after losing an optimistic race", async () => {
    const test1 = harness();
    test1.raceOnce();

    const result = await createBotUpdateTool(test1.host).execute(
      { description: "Aide" },
      CONTEXT,
    );

    expect(result.isError).toBe(false);
    expect(test1.settings().profile.description).toBe("Aide");
  });

  test("refuses an empty call, an unknown field, and a blank name", () => {
    expect(() => decodeBotUpdateInputV1({})).toThrow();
    expect(() => decodeBotUpdateInputV1({ archived: true })).toThrow();
    expect(() => decodeBotUpdateInputV1({ name: "  " })).toThrow();
  });

  test("offers no way to archive, restore, or delete a Bot", () => {
    const tool = createBotUpdateTool(harness().host);
    const schema = tool.inputSchema as { properties: Record<string, unknown> };

    expect(Object.keys(schema.properties)).toEqual([
      "name",
      "description",
      "hidden_from_sidebar",
      "notify_on_updates",
      "voice",
    ]);
  });
});

describe("bot_create", () => {
  test("registers one Bot in the User's flock with its description", async () => {
    const test1 = harness();

    const result = await createBotCreateTool(
      test1.host,
      createTurnBotDirectoryV1(test1.host),
    ).execute({ name: "Budget", description: "Watches the money." }, CONTEXT);

    expect(result.isError).toBe(false);
    const directory = await test1.host.listBots();
    expect(directory.bots).toHaveLength(1);
    const created = directory.bots[0]!;
    expect(created.initialName).toBe("Budget");
    expect(created.initialDescription).toBe("Watches the money.");
    expect(created.botId).toBe(
      await createdBotIdV1(OWNER, RUN_ID, CONTEXT.effectId, "Budget"),
    );
    // Model and Capability authority resolve account-wide on the new Bot's
    // next admitted Turn; neither is copied into its registration.
    expect(Object.hasOwn(created, "initialModel")).toBe(false);
    expect(result.content).toContain(created.botId);
  });

  test("records the creating Bot and Turn on the registration", async () => {
    const test1 = harness();

    await createBotCreateTool(
      test1.host,
      createTurnBotDirectoryV1(test1.host),
    ).execute({ name: "Budget" }, CONTEXT);

    expect((await test1.host.listBots()).bots[0]!.createdBy).toEqual(WRITER);
  });

  test("a replay after eviction creates exactly one Bot", async () => {
    const test1 = harness();
    const tool = createBotCreateTool(
      test1.host,
      createTurnBotDirectoryV1(test1.host),
    );
    expect(tool.idempotent).toBe(true);

    const first = await tool.execute({ name: "Budget" }, CONTEXT);
    const replay = await tool.execute({ name: "Budget" }, CONTEXT);

    expect(first.isError).toBe(false);
    expect(replay.isError).toBe(false);
    expect(replay.content).toContain("already exists");
    expect((await test1.host.listBots()).bots).toHaveLength(1);
  });

  test("a different occurrence creates a distinct Bot", async () => {
    const test1 = harness();
    const tool = createBotCreateTool(
      test1.host,
      createTurnBotDirectoryV1(test1.host),
    );

    await tool.execute({ name: "Budget" }, CONTEXT);
    await tool.execute(
      { name: "Budget" },
      { ...CONTEXT, effectId: "tool:1:3:0" },
    );

    const ids = (await test1.host.listBots()).bots.map((bot) => bot.botId);
    expect(new Set(ids).size).toBe(2);
  });

  test("the same effect id in another run creates another Bot", async () => {
    // Effect ids restart in every Session: a Bot's first Routine Turn calls
    // `tool:1:1:0` exactly as its first chat Turn did.
    const test1 = harness();
    const commandIds: string[] = [];
    const inRun = (runId: string): FlockSelfRuntimeHostV1 => ({
      ...test1.host,
      runId,
      createBot: (command) => {
        commandIds.push(command.commandId);
        return test1.host.createBot(command);
      },
    });
    const chat = inRun(RUN_ID);
    const routine = inRun("run-routine-1");

    const first = await createBotCreateTool(
      chat,
      createTurnBotDirectoryV1(chat),
    ).execute({ name: "Budget" }, CONTEXT);
    const second = await createBotCreateTool(
      routine,
      createTurnBotDirectoryV1(routine),
    ).execute(
      { name: "Budget" },
      { ...CONTEXT, sessionId: "routine:daily", turnType: "automation" },
    );

    expect(first.isError).toBe(false);
    expect(second.isError).toBe(false);
    expect(second.content).not.toContain("already exists");
    expect(commandIds).toHaveLength(2);
    expect(commandIds[0]).not.toBe(commandIds[1]);
    const ids = (await test1.host.listBots()).bots.map((bot) => bot.botId);
    expect(ids).toEqual([
      await createdBotIdV1(OWNER, RUN_ID, CONTEXT.effectId, "Budget"),
      await createdBotIdV1(OWNER, "run-routine-1", CONTEXT.effectId, "Budget"),
    ]);
  });

  test("derives the same ids for a replay within one run", async () => {
    expect(
      await createdBotIdV1(OWNER, RUN_ID, CONTEXT.effectId, "Budget"),
    ).toBe(await createdBotIdV1(OWNER, RUN_ID, CONTEXT.effectId, "Budget"));
    expect(await botCreateCommandIdV1(OWNER, RUN_ID, CONTEXT.effectId)).toBe(
      await botCreateCommandIdV1(OWNER, RUN_ID, CONTEXT.effectId),
    );
    expect(
      await createdBotIdV1(OWNER, RUN_ID, CONTEXT.effectId, "Budget"),
    ).not.toBe(
      await createdBotIdV1(OWNER, "run-routine-1", CONTEXT.effectId, "Budget"),
    );
    expect(
      await botCreateCommandIdV1(OWNER, RUN_ID, CONTEXT.effectId),
    ).not.toBe(
      await botCreateCommandIdV1(OWNER, "run-routine-1", CONTEXT.effectId),
    );
    // The User Durable Object keys receipts across all its Bots, so another
    // Bot's same run id and effect id is another command.
    expect(
      await botCreateCommandIdV1(OWNER, RUN_ID, CONTEXT.effectId),
    ).not.toBe(
      await botCreateCommandIdV1(
        { ...OWNER, botId: "bot-2" },
        RUN_ID,
        CONTEXT.effectId,
      ),
    );
  });

  test("refuses a nameless call and an unknown field", async () => {
    const host = harness().host;
    const tool = createBotCreateTool(host, createTurnBotDirectoryV1(host));

    expect(tool.validate?.({})).toBe(false);
    expect(tool.validate?.({ name: "Budget", model: "glm" })).toBe(false);
    expect(tool.validate?.({ name: "Budget" })).toBe(true);
  });
});

describe("the self-management seam", () => {
  test("both tools are work tools, offered on every turn type", () => {
    const host = harness().host;

    expect(createBotUpdateTool(host).admission).toBeUndefined();
    expect(
      createBotCreateTool(host, createTurnBotDirectoryV1(host)).admission,
    ).toBeUndefined();
  });
});

describe("bot_message", () => {
  test("returns the target Bot's reply as the tool result", async () => {
    const test1 = harness();
    const result = await createBotMessageTool(test1.host).execute(
      { target_id: "researcher", message: "What changed?" },
      CONTEXT,
    );

    expect(result).toEqual({ content: "Teammate answer", isError: false });
    expect(createBotMessageTool(test1.host).idempotent).toBe(true);
  });

  test("the teammates section names the other Bots and their descriptions", async () => {
    const test1 = harness();
    await createBotCreateTool(
      test1.host,
      createTurnBotDirectoryV1(test1.host),
    ).execute(
      { name: "Researcher", description: "Finds primary sources." },
      CONTEXT,
    );
    const prompt = await createTeammatesPromptSectionV1(
      test1.host,
      createTurnBotDirectoryV1(test1.host),
    ).render({
      sessionId: "user-1:bot-1",
      provider: "test",
      model: "test",
      turnType: "chat",
    });

    expect(prompt).toContain("<teammates>");
    expect(prompt).toContain("Researcher");
    expect(prompt).toContain("Finds primary sources.");
  });

  test("the teammates section reads the flock once a Turn, and again after a create", async () => {
    const test1 = harness();
    let calls = 0;
    const host = {
      ...test1.host,
      listBots: () => {
        calls += 1;
        return test1.host.listBots();
      },
    };
    const flock = createTurnBotDirectoryV1(host);
    const section = createTeammatesPromptSectionV1(host, flock);
    const context = {
      sessionId: "user-1:bot-1",
      provider: "test",
      model: "test",
      turnType: "chat" as const,
    };
    // Two steps of one Turn. The answer cannot have changed between them, and
    // the User Durable Object is single-threaded and shared by every Bot.
    await section.render(context);
    await section.render(context);

    expect(calls).toBe(1);

    await createBotCreateTool(host, flock).execute(
      { name: "Researcher", description: "Finds primary sources." },
      CONTEXT,
    );
    const after = await section.render(context);

    // A Bot made mid-Turn is named in the next step's prompt, not after the
    // Turn ends.
    expect(after).toContain("Researcher");
  });

  test("a failed flock read does not answer for the rest of the Turn", async () => {
    const test1 = harness();
    let calls = 0;
    const host = {
      ...test1.host,
      listBots: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error("User object is busy"))
          : test1.host.listBots();
      },
    };
    const flock = createTurnBotDirectoryV1(host);

    await expect(flock.read()).rejects.toThrow("User object is busy");
    await expect(flock.read()).resolves.toMatchObject({ schemaVersion: 1 });
    expect(calls).toBe(2);
  });
});

describe("bot_message in a Group Chat Turn", () => {
  const groupChat = {
    runId: "grp-0123",
    botId: "bot-1",
    origin: {
      kind: "group" as const,
      groupId: "g-0123456789abcdef0123",
      groupName: "Books",
      members: [
        { botId: "bot-1", name: "General" },
        { botId: "xero", name: "Xero Books" },
      ],
      throughSeq: 4,
      reason: "mention" as const,
    },
  };

  test("asks a Bot outside the group under an id scoped to this Turn's run", async () => {
    const asked: string[] = [];
    const test1 = harness();
    const host = {
      ...test1.host,
      groupChat,
      messageBot: async (
        request: Parameters<FlockSelfRuntimeHostV1["messageBot"]>[0],
      ) => {
        asked.push(request.effectId);
        return test1.host.messageBot(request);
      },
    };
    const result = await createGroupBotMessageTool(host).execute(
      { target_id: "researcher", message: "What did Q2 cost?" },
      {
        ...CONTEXT,
        turnType: "agent",
        sessionId: "group:g-0123456789abcdef0123",
      },
    );

    expect(result).toEqual({ content: "Teammate answer", isError: false });
    // The occurrence id is numbered within the group's Session, so on its own
    // it would repeat one from the Bot's own chat.
    expect(asked).toEqual(["grp-0123:tool:1:1:0"]);
  });

  test("refuses a member, who is asked in the thread instead", async () => {
    const test1 = harness();
    const result = await createGroupBotMessageTool({
      ...test1.host,
      groupChat,
    }).execute({ target_id: "xero", message: "Numbers?" }, CONTEXT);

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("@mention");
  });

  test("the teammates section in a group names only the Bots outside it", async () => {
    const test1 = harness();
    const directory = createTurnBotDirectoryV1(test1.host);
    await createBotCreateTool(test1.host, directory).execute(
      { name: "Researcher", description: "Finds primary sources." },
      CONTEXT,
    );
    await createBotCreateTool(test1.host, directory).execute(
      { name: "Xero Books", description: "Bookkeeping." },
      { ...CONTEXT, effectId: "tool:1:2:0" },
    );
    const xero = (await test1.host.listBots()).bots.find(
      (bot) => bot.initialName === "Xero Books",
    )!;
    const inGroup = {
      ...test1.host,
      groupChat: {
        ...groupChat,
        origin: {
          ...groupChat.origin,
          members: [
            { botId: "bot-1", name: "General" },
            { botId: xero.botId, name: "Xero Books" },
          ],
        },
      },
    };
    const prompt = await createTeammatesPromptSectionV1(
      inGroup,
      createTurnBotDirectoryV1(inGroup),
    ).render({
      sessionId: "group:g-0123456789abcdef0123",
      provider: "test",
      model: "test",
      turnType: "agent",
    });

    expect(prompt).toContain("Researcher");
    expect(prompt).not.toContain("Xero Books");
  });
});

describe("bot_update: how the Bot sounds", () => {
  test("sets a voice from the character default, changing only what it names", async () => {
    const test1 = harness();
    const tool = createBotUpdateTool(test1.host);

    const result = await tool.execute(
      { voice: { accent: "australian", turn_length: "terse" } },
      CONTEXT,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("voice");
    expect(test1.voice()).toMatchObject({
      revision: 1,
      voice: {
        schemaVersion: 1,
        // Untouched, so it stays the "cat" character's default.
        voiceName: "Despina",
        delivery: { accent: "australian", turnLength: "terse" },
      },
    });
  });

  test("keeps the dials it was not given, and clears one with the empty string", async () => {
    const test1 = harness();
    const tool = createBotUpdateTool(test1.host);
    await tool.execute({ voice: { accent: "irish", humour: "dry" } }, CONTEXT);

    await tool.execute({ voice: { name: "Gacrux" } }, CONTEXT);
    expect(test1.voice().voice).toEqual({
      schemaVersion: 1,
      voiceName: "Gacrux",
      delivery: { accent: "irish", humour: "dry" },
    });

    await tool.execute({ voice: { humour: "" } }, CONTEXT);
    expect(test1.voice().voice).toEqual({
      schemaVersion: 1,
      voiceName: "Gacrux",
      delivery: { accent: "irish" },
    });
  });

  test("commands nothing when the voice already holds", async () => {
    const test1 = harness();
    const tool = createBotUpdateTool(test1.host);
    await tool.execute({ voice: { attitude: "dry-deadpan" } }, CONTEXT);
    const applied = test1.voice().revision;

    const result = await tool.execute(
      { voice: { attitude: "dry-deadpan" } },
      CONTEXT,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Nothing changed");
    // A replay is a read: the revision is the proof nothing was written.
    expect(test1.voice().revision).toBe(applied);
  });

  test("refuses a slug the voice tables do not hold, writing nothing", async () => {
    const test1 = harness();
    const tool = createBotUpdateTool(test1.host);

    const result = await tool.execute(
      { voice: { accent: "klingon" } },
      CONTEXT,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("voice accent is invalid");
    expect(test1.voice().revision).toBe(0);
  });

  test("refuses a voice argument that is empty or misshapen before the model spends a Turn on it", () => {
    expect(() => decodeBotUpdateInputV1({ voice: {} })).toThrow(
      "voice needs at least one field to change",
    );
    expect(() => decodeBotUpdateInputV1({ voice: { warmth: "high" } })).toThrow(
      "input has unknown fields",
    );
    expect(() => decodeBotUpdateInputV1({ voice: { pace: 3 } })).toThrow(
      "pace must be a string",
    );
  });

  test("changes a profile and a voice in one call", async () => {
    const test1 = harness();
    const tool = createBotUpdateTool(test1.host);

    const result = await tool.execute(
      { description: "Chief of staff", voice: { formality: "formal" } },
      CONTEXT,
    );

    expect(result.content).toBe(
      "Updated description, voice. Everything else is unchanged.",
    );
    expect(test1.settings().profile.description).toBe("Chief of staff");
    expect(test1.voice().voice?.delivery.formality).toBe("formal");
  });
});
