// The Plugin authoring gate, in workerd (ADR 0026 step 7b).
//
// The ten `plugin_*` tools are mounted per Turn behind the account's
// admin-held `pluginAuthoring` switch, and off means not mounted at all
// rather than mounted and refusing. That is what a scripted model asking for
// one proves here, against a real Bot Durable Object: with the switch on the
// tool answers, with it off the Turn is told the tool does not exist. The
// managed `plugins` Skill goes with them, so this also reads the Skill list
// the same Turn would be offered.
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { frockbotToolCallPrompt } from "./harness/miniflare.ts";
import { provisionBot } from "./provision-bot.ts";

function suffix(): string {
  return crypto.randomUUID().slice(0, 8);
}

function botStub(userId: string, botId: string) {
  return env.BOT_STATES.getByName(`${userId}:${botId}`);
}

/** What an admin does before an account's Bots see the Plugin tools. */
async function setPluginAuthoring(
  userId: string,
  pluginAuthoring: boolean,
): Promise<void> {
  const user = env.USER_CONFIGURATIONS.getByName(userId) as unknown as {
    setFeatures(input: unknown): Promise<unknown>;
  };
  await user.setFeatures({
    schemaVersion: 1,
    userId,
    command: {
      schemaVersion: 1,
      type: "user/set-features",
      applets: false,
      pluginAuthoring,
    },
    updatedBy: "workerd-admin",
  });
}

/** The one tool result a scripted single-call Turn recorded. */
function toolResult(turn: {
  events: Array<{ type: string; content?: string; isError?: boolean }>;
}): { content: string; isError: boolean } {
  const result = turn.events.find((event) => event.type === "tool/result");
  if (!result) throw new Error("the Turn recorded no tool result");
  return { content: result.content ?? "", isError: result.isError === true };
}

async function callTool(
  identity: { userId: string; botId: string },
  runId: string,
  name: string,
  input: unknown = {},
): Promise<{ content: string; isError: boolean }> {
  const bot = botStub(identity.userId, identity.botId);
  const turn = await bot.run({
    schemaVersion: 1,
    ...identity,
    command: {
      runId,
      sessionId: `${identity.userId}:${identity.botId}`,
      acceptedAt: new Date().toISOString(),
      text: frockbotToolCallPrompt(name, input),
    },
  });
  return toolResult(turn as never);
}

/** The Skill list the composer reads, which is the Turn's own catalog. */
async function skillRefs(identity: {
  userId: string;
  botId: string;
}): Promise<string[]> {
  const catalog = (await (
    botStub(identity.userId, identity.botId) as unknown as {
      listSkills(identity: unknown): Promise<{
        skills: Array<{ ref: string }>;
      }>;
    }
  ).listSkills({ schemaVersion: 1, ...identity })) as {
    skills: Array<{ ref: string }>;
  };
  return catalog.skills.map((entry) => entry.ref);
}

describe("the Plugin authoring switch inside a real Bot", () => {
  test("the switch on offers the tools and the managed Skill", async () => {
    const id = suffix();
    const identity = { userId: `plug-on-${id}`, botId: `plug-onbot-${id}` };
    await provisionBot(identity);
    await setPluginAuthoring(identity.userId, true);

    const listed = await callTool(identity, `run-list-${id}`, "plugin_list");
    expect(listed.isError).toBe(false);
    expect(listed.content).toContain("plugin_create");

    const created = await callTool(
      identity,
      `run-create-${id}`,
      "plugin_create",
      { displayName: "Notes" },
    );
    expect(created.isError).toBe(false);
    expect(created.content).toContain('Created "notes"');
    expect(created.content).toContain("plugin.ts");
    expect(created.content).toContain("plugin.json");

    // The scaffold is source, not a Plugin yet: `plugin_files` reads it back
    // off the Workspace root, while `plugin_list` — which lists the account's
    // Composition — still has nothing, because only a publish the User
    // approves puts a Plugin there.
    const files = await callTool(identity, `run-files-${id}`, "plugin_files", {
      pluginId: "notes",
    });
    expect(files.isError).toBe(false);
    expect(files.content).toContain("plugin.ts");
    expect(files.content).toContain("plugin.json");

    const again = await callTool(identity, `run-relist-${id}`, "plugin_list");
    expect(again.content).toContain("no Plugins yet");

    expect(await skillRefs(identity)).toContain("managed/plugins");
  });

  test("the switch off offers neither the tools nor the Skill", async () => {
    const id = suffix();
    const identity = { userId: `plug-off-${id}`, botId: `plug-offbot-${id}` };
    await provisionBot(identity);
    await setPluginAuthoring(identity.userId, false);

    for (const name of ["plugin_list", "plugin_create", "plugin_publish"]) {
      const result = await callTool(identity, `run-${name}-${id}`, name, {
        displayName: "Notes",
        pluginId: "notes",
      });
      expect(result.isError, `${name} answered instead of being absent`).toBe(
        true,
      );
      expect(result.content).toContain(`Tool not found: "${name}"`);
    }

    const listed = await skillRefs(identity);
    expect(listed).not.toContain("managed/plugins");
    // Only that Skill follows this switch; the rest of the managed set stays.
    expect(listed).toContain("managed/add-connector");
  });
});
