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
} from "@frockbot/configuration-core";
import type { SessionEvent } from "@frockbot/kernel-contracts";
import {
  createBotCreateTool,
  createBotMessageTool,
  createTeammatesPromptSectionV1,
  createBotUpdateTool,
  createdBotIdV1,
  decodeBotUpdateInputV1,
  type FlockSelfRuntimeHostV1,
} from "./agent.ts";
import { createFlockUserBackendContribution } from "./user.ts";
import { decodeCreateBotCommandV1 } from "./shared.ts";

const OWNER = { userId: "user-1", botId: "bot-1" };
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
    raceOnce: () => {
      race = true;
    },
    host: {
      owner: OWNER,
      writer: WRITER,
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
          settings = { ...settings, revision, profile };
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
    },
  };
}

describe("bot_update", () => {
  test("changes only the fields it was given", async () => {
    const test1 = harness({
      profile: { name: "General", description: "A helper.", title: "Aide" },
    });
    const tool = createBotUpdateTool(test1.host);

    const result = await tool.execute({ title: "Chief of staff" }, CONTEXT);

    expect(result.isError).toBe(false);
    expect(test1.settings().profile).toEqual({
      name: "General",
      description: "A helper.",
      title: "Chief of staff",
    });
    expect(test1.announcements()).toEqual([]);
  });

  test("clears an optional field with the empty string", async () => {
    const test1 = harness({
      profile: { name: "General", title: "Aide", description: "A helper." },
    });

    await createBotUpdateTool(test1.host).execute({ title: "" }, CONTEXT);

    expect(test1.settings().profile).toEqual({
      name: "General",
      description: "A helper.",
    });
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
    const test1 = harness({ profile: { name: "General", title: "Aide" } });

    const result = await createBotUpdateTool(test1.host).execute(
      { title: "Aide" },
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
      { title: "Aide", notify_on_updates: false },
      CONTEXT,
    );

    expect(result.isError).toBe(false);
    expect(test1.settings().notifications).toEqual({ enabled: false });
    expect(test1.commands().map((command) => command.type)).toEqual([
      "bot/set-profile",
      "bot/update-notifications",
    ]);
  });

  test("re-issues the command after losing an optimistic race", async () => {
    const test1 = harness();
    test1.raceOnce();

    const result = await createBotUpdateTool(test1.host).execute(
      { title: "Aide" },
      CONTEXT,
    );

    expect(result.isError).toBe(false);
    expect(test1.settings().profile.title).toBe("Aide");
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
      "title",
      "hidden_from_sidebar",
      "notify_on_updates",
    ]);
  });
});

describe("bot_create", () => {
  test("registers one Bot in the User's flock with its description", async () => {
    const test1 = harness();

    const result = await createBotCreateTool(test1.host).execute(
      { name: "Budget", description: "Watches the money." },
      CONTEXT,
    );

    expect(result.isError).toBe(false);
    const directory = await test1.host.listBots();
    expect(directory.bots).toHaveLength(1);
    const created = directory.bots[0]!;
    expect(created.initialName).toBe("Budget");
    expect(created.initialDescription).toBe("Watches the money.");
    expect(created.botId).toBe(
      await createdBotIdV1(OWNER, CONTEXT.effectId, "Budget"),
    );
    // Model and Capability authority resolve account-wide on the new Bot's
    // next admitted Turn; neither is copied into its registration.
    expect(Object.hasOwn(created, "initialModel")).toBe(false);
    expect(result.content).toContain(created.botId);
  });

  test("records the creating Bot and Turn on the registration", async () => {
    const test1 = harness();

    await createBotCreateTool(test1.host).execute({ name: "Budget" }, CONTEXT);

    expect((await test1.host.listBots()).bots[0]!.createdBy).toEqual(WRITER);
  });

  test("a replay after eviction creates exactly one Bot", async () => {
    const test1 = harness();
    const tool = createBotCreateTool(test1.host);
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
    const tool = createBotCreateTool(test1.host);

    await tool.execute({ name: "Budget" }, CONTEXT);
    await tool.execute(
      { name: "Budget" },
      { ...CONTEXT, effectId: "tool:1:3:0" },
    );

    const ids = (await test1.host.listBots()).bots.map((bot) => bot.botId);
    expect(new Set(ids).size).toBe(2);
  });

  test("refuses a nameless call and an unknown field", async () => {
    const tool = createBotCreateTool(harness().host);

    expect(tool.validate?.({})).toBe(false);
    expect(tool.validate?.({ name: "Budget", model: "glm" })).toBe(false);
    expect(tool.validate?.({ name: "Budget" })).toBe(true);
  });
});

describe("the self-management seam", () => {
  test("both tools are work tools, offered on every turn type", () => {
    const host = harness().host;

    expect(createBotUpdateTool(host).admission).toBeUndefined();
    expect(createBotCreateTool(host).admission).toBeUndefined();
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
    await createBotCreateTool(test1.host).execute(
      { name: "Researcher", description: "Finds primary sources." },
      CONTEXT,
    );
    const prompt = await createTeammatesPromptSectionV1(test1.host).render({
      sessionId: "user-1:bot-1",
      provider: "test",
      model: "test",
      turnType: "chat",
    });

    expect(prompt).toContain("<teammates>");
    expect(prompt).toContain("Researcher");
    expect(prompt).toContain("Finds primary sources.");
  });
});
