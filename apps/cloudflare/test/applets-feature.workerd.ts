// The Applets feature pressure test, in workerd.
//
// The shipped tools, run for real: a provisioned Bot, the foundation
// Composition, and `applet_list` and `applet_create` called by a scripted
// model. That is what proves the feature is mounted, tool-registered, and
// reaching the Bot object's Applet authority and the Workspace.
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

/** What an admin does before an account's Bots see the Applet tools. */
async function setApplets(userId: string, applets: boolean): Promise<void> {
  const user = env.USER_CONFIGURATIONS.getByName(userId) as unknown as {
    setFeatures(input: unknown): Promise<unknown>;
  };
  await user.setFeatures({
    schemaVersion: 1,
    userId,
    command: { schemaVersion: 1, type: "user/set-features", applets },
    updatedBy: "workerd-admin",
  });
}

interface IframeCatalog {
  contributions: Array<{
    packageId: string;
    provenance: string;
    pages: Array<{
      id: string;
      artifact: { contentHash: string; size: number; mediaType: string };
      mounts: Array<{ slot: string; order?: number }>;
    }>;
    entries: Array<{
      id: string;
      slot: string;
      order?: number;
      label: string;
      icon: string;
      opens: { kind: string; page: string };
    }>;
    declaredTools: string[];
  }>;
}

/** The one tool result a scripted single-call Turn recorded. */
function toolResult(turn: {
  events: Array<{ type: string; content?: string; isError?: boolean }>;
}): { content: string; isError: boolean } {
  const result = turn.events.find((event) => event.type === "tool/result");
  if (!result) throw new Error("the Turn recorded no tool result");
  return { content: result.content ?? "", isError: result.isError === true };
}

describe("the Applets feature inside a real Bot", () => {
  test("offers applet_list and applet_create, and applet_create scaffolds the source", async () => {
    const id = suffix();
    const identity = {
      userId: `applets-user-${id}`,
      botId: `applets-bot-${id}`,
    };
    await provisionBot(identity);
    await setApplets(identity.userId, true);
    const bot = botStub(identity.userId, identity.botId);
    const sessionId = `${identity.userId}:${identity.botId}`;

    const empty = await bot.run({
      schemaVersion: 1,
      ...identity,
      command: {
        runId: `run-list-${id}`,
        sessionId,
        acceptedAt: new Date().toISOString(),
        text: frockbotToolCallPrompt("applet_list"),
      },
    });

    const listed = toolResult(empty as never);
    expect(listed.isError).toBe(false);
    expect(listed.content).toContain("no Applets yet");

    const created = await bot.run({
      schemaVersion: 1,
      ...identity,
      command: {
        runId: `run-create-${id}`,
        sessionId,
        acceptedAt: new Date().toISOString(),
        text: frockbotToolCallPrompt("applet_create", {
          displayName: "Weekly Todos",
        }),
      },
    });

    const createdResult = toolResult(created as never);
    expect(createdResult.isError).toBe(false);
    expect(createdResult.content).toContain("Weekly Todos");
    // The scaffold is named by the files it wrote and the loop that follows,
    // with no Computer path and no shell step anywhere in it.
    expect(createdResult.content).toContain("server.ts");
    expect(createdResult.content).toContain("applet_write_file");
    expect(createdResult.content).toContain("applet_check");
    expect(createdResult.content).toContain("applet_publish");
    expect(createdResult.content).not.toContain("/home/box");

    // And it is in the list now, which is the directory answering, not the
    // feature remembering.
    const again = await bot.run({
      schemaVersion: 1,
      ...identity,
      command: {
        runId: `run-list-again-${id}`,
        sessionId,
        acceptedAt: new Date().toISOString(),
        text: frockbotToolCallPrompt("applet_list"),
      },
    });
    const relisted = toolResult(again as never);
    expect(relisted.content).toContain("Weekly Todos");
  });

  test("the page catalog carries both pages, the sidebar entry, and FrockBot provenance", async () => {
    const id = suffix();
    const identity = {
      userId: `applets-ui-${id}`,
      botId: `applets-uibot-${id}`,
    };
    await provisionBot(identity);
    await setApplets(identity.userId, true);
    const bot = botStub(identity.userId, identity.botId);

    const catalog = (await (
      bot as unknown as {
        listPackageUi(identity: unknown): Promise<IframeCatalog>;
      }
    ).listPackageUi({ schemaVersion: 1, ...identity })) as IframeCatalog;

    const contribution = catalog.contributions.find(
      (entry) => entry.packageId === "applets",
    );
    expect(contribution).toBeDefined();
    expect(contribution!.provenance).toBe("FrockBot");
    expect(contribution!.pages.map((page) => page.id)).toEqual([
      "list",
      "canvas",
    ]);
    expect(contribution!.pages.map((page) => page.mounts[0]?.slot)).toEqual([
      "frockbot.surface:list",
      "frockbot.right-panel",
    ]);
    expect(contribution!.declaredTools).toEqual(["applet_focus"]);
    expect(contribution!.entries).toEqual([
      {
        id: "open",
        slot: "frockbot.sidebar-actions",
        order: 5,
        label: "Applets",
        icon: "applets",
        opens: { kind: "surface", page: "list" },
      },
    ]);
  });

  test("an account without Applets is offered neither the tools nor the pages", async () => {
    const id = suffix();
    const identity = {
      userId: `applets-off-${id}`,
      botId: `applets-offbot-${id}`,
    };
    await provisionBot(identity);
    const bot = botStub(identity.userId, identity.botId);

    const catalog = (await (
      bot as unknown as {
        listPackageUi(identity: unknown): Promise<IframeCatalog>;
      }
    ).listPackageUi({ schemaVersion: 1, ...identity })) as IframeCatalog;
    expect(
      catalog.contributions.some((entry) => entry.packageId === "applets"),
    ).toBe(false);

    const turn = await bot.run({
      schemaVersion: 1,
      ...identity,
      command: {
        runId: `run-off-${id}`,
        sessionId: `${identity.userId}:${identity.botId}`,
        acceptedAt: new Date().toISOString(),
        text: frockbotToolCallPrompt("applet_list"),
      },
    });
    const result = toolResult(turn as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Tool not found: "applet_list"');
  });
});
