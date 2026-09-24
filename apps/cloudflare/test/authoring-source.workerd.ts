// Bot-authored source, end to end through the tools that write it, in workerd.
//
// The Bot-authored Plugin host keeps its source in the User's durable
// Workspace root, and `plugin_*` are the tools that read and write it. This drives those tools against a real Bot Durable Object: a
// real Turn calls them, the bytes land in the real R2-backed root, and the next
// listing, read, check and R2 head read back what was written. Nothing is a
// stand-in except the build service, which needs a container this pool cannot
// start (`applet-build-fake.ts`), and even there the request the app posts is
// read back off the wire.
//
// What it is for: this is the surface that says what the host's callers
// observe — the media type each file is stored under, the order and scope of a
// listing, the optimistic write, the exact text read back, and the bounds a
// check refuses on.
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { PLUGIN_BUILD_LIMITS } from "@frockbot/applets/build-contract";
import { workspaceObjectKeyV1 } from "@frockbot/core/workspace-store";
import { pluginsSourceRootV1 } from "@frockbot/app/plugins/root";
import { frockbotToolCallPrompt } from "./harness/miniflare.ts";
import { provisionBot } from "./provision-bot.ts";
import type { FakePluginBuildRequestV1 } from "./applet-build-fake.ts";

function suffix(): string {
  return crypto.randomUUID().slice(0, 8);
}

interface Identity {
  userId: string;
  botId: string;
}

function botStub(identity: Identity) {
  return env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`);
}

/** What an admin does before a Bot's account has these tools at all. */
async function setFeatures(
  userId: string,
  features: { pluginAuthoring?: boolean },
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
      pluginAuthoring: features.pluginAuthoring ?? false,
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

let turns = 0;

/** One scripted Turn that calls one tool, as the product's own loop runs it. */
async function callTool(
  identity: Identity,
  name: string,
  input: unknown,
): Promise<{ content: string; isError: boolean }> {
  turns += 1;
  const turn = await botStub(identity).run({
    schemaVersion: 1,
    ...identity,
    command: {
      runId: `run-${turns}-${identity.botId}`,
      sessionId: `${identity.userId}:${identity.botId}`,
      acceptedAt: new Date().toISOString(),
      text: frockbotToolCallPrompt(name, input),
    },
  });
  return toolResult(turn as never);
}

/** The tool result, refused if the tool answered with an error. */
async function tool(
  identity: Identity,
  name: string,
  input: unknown,
): Promise<string> {
  const result = await callTool(identity, name, input);
  expect(result.isError, `${name} answered: ${result.content}`).toBe(false);
  return result.content;
}

/** What `plugin_files` lists, in the order it lists it. */
function listedFiles(content: string): Array<{ path: string; size: number }> {
  const lines = content.split("\n").slice(1);
  return lines.map((line) => {
    const match = /^(.*) — (\d+) bytes$/u.exec(line);
    if (!match) throw new Error(`unreadable listing line: ${line}`);
    return { path: match[1] ?? "", size: Number(match[2]) };
  });
}

async function buildsFor(id: string): Promise<FakePluginBuildRequestV1[]> {
  const response = await env.APPLET_BUILD.fetch(
    "https://applet-build.internal/__fake/requests",
  );
  const { requests } = (await response.json()) as {
    requests: FakePluginBuildRequestV1[];
  };
  return requests.filter((request) => request.id === id);
}

/** The content type one source file is stored in object storage under. */
async function storedMediaType(
  root: Parameters<typeof workspaceObjectKeyV1>[0],
  path: string,
): Promise<string | undefined> {
  const object = await env.MEMORY_FILES.head(workspaceObjectKeyV1(root, path));
  return object?.httpMetadata?.contentType;
}

describe("Bot-authored source through the tools", () => {
  test("a Plugin's files are written, listed, read back, stored under their media type, and scoped away from a neighbour", async () => {
    const id = suffix();
    const identity = { userId: `author-plugin-${id}`, botId: `bot-${id}` };
    await provisionBot(identity);
    await setFeatures(identity.userId, { pluginAuthoring: true });

    const created = await tool(identity, "plugin_create", {
      displayName: "Notes",
    });
    expect(created).toContain('Created "notes"');

    const module = "export const marker = 'notes';\n";
    const wrote = await tool(identity, "plugin_write_file", {
      pluginId: "notes",
      path: "plugin.ts",
      text: module,
    });
    expect(wrote).toContain("plugin.ts");
    expect(wrote).toContain(`${module.length} characters`);

    const files = listedFiles(
      await tool(identity, "plugin_files", { pluginId: "notes" }),
    );
    expect(files.map((file) => file.path)).toEqual([
      "plugin.json",
      "plugin.ts",
    ]);
    expect(files.find((file) => file.path === "plugin.ts")?.size).toBe(
      module.length,
    );
    expect(
      await tool(identity, "plugin_read_file", {
        pluginId: "notes",
        path: "plugin.ts",
      }),
    ).toBe(module);

    // A second Plugin whose id starts with the first one's. Creating it lists
    // its own directory and finds nothing, which is only true if `notes/` is
    // not what `notes-2` reads.
    const neighbour = await tool(identity, "plugin_create", {
      displayName: "Notes 2",
    });
    expect(neighbour).toContain('Created "notes-2"');
    const neighbourModule = "export const marker = 'notes two';\n";
    await tool(identity, "plugin_write_file", {
      pluginId: "notes-2",
      path: "plugin.ts",
      text: neighbourModule,
    });

    // Neither listing borrows the other's files.
    expect(
      listedFiles(await tool(identity, "plugin_files", { pluginId: "notes" })),
    ).toEqual(files);
    expect(
      listedFiles(
        await tool(identity, "plugin_files", { pluginId: "notes-2" }),
      ).map((file) => file.path),
    ).toEqual(["plugin.json", "plugin.ts"]);
    expect(
      await tool(identity, "plugin_read_file", {
        pluginId: "notes-2",
        path: "plugin.ts",
      }),
    ).toBe(neighbourModule);
    expect(
      await tool(identity, "plugin_read_file", {
        pluginId: "notes",
        path: "plugin.ts",
      }),
    ).toBe(module);

    const missing = await callTool(identity, "plugin_read_file", {
      pluginId: "notes",
      path: "gone.ts",
    });
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain('"gone.ts" is not-found');

    const root = pluginsSourceRootV1(identity.userId);
    expect(await storedMediaType(root, "notes/plugin.json")).toBe(
      "application/json",
    );
    expect(await storedMediaType(root, "notes/plugin.ts")).toBe(
      "text/typescript",
    );
  });

  test("a Plugin check reads its source the same way", async () => {
    const id = suffix();
    const identity = {
      userId: `author-plugin-check-${id}`,
      botId: `bot-${id}`,
    };
    await provisionBot(identity);
    await setFeatures(identity.userId, { pluginAuthoring: true });

    await tool(identity, "plugin_create", { displayName: "Checked Notes" });
    const checked = await tool(identity, "plugin_check", {
      pluginId: "checked-notes",
    });
    expect(checked).toContain("checked-notes builds.");

    const [pluginBuild] = await buildsFor("checked-notes");
    expect(pluginBuild?.mode).toBe("check");
    expect(pluginBuild?.files.map((file) => file.path)).toEqual([
      "plugin.json",
      "plugin.ts",
    ]);
    const listed = listedFiles(
      await tool(identity, "plugin_files", { pluginId: "checked-notes" }),
    );
    expect(pluginBuild?.files.map((file) => file.text.length)).toEqual(
      listed.map((file) => file.size),
    );
  });
});
