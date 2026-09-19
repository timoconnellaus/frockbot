// Bot-authored source, end to end through the tools that write it, in workerd.
//
// The Bot-authored Applet and Plugin hosts keep their source in the User's
// durable Workspace root, and `applet_*` / `plugin_*` are the tools that read
// and write it. This drives those tools against a real Bot Durable Object: a
// real Turn calls them, the bytes land in the real R2-backed root, and the next
// listing, read, check and R2 head read back what was written. Nothing is a
// stand-in except the build service, which needs a container this pool cannot
// start (`applet-build-fake.ts`), and even there the request the app posts is
// read back off the wire.
//
// What it is for: both artifacts go through one shared source repository, and
// this is the surface that says the consolidation preserved what each host's
// callers observe — the media type each file is stored under, the order and
// scope of a listing, the optimistic write, the exact text read back, and the
// bounds a check refuses on.
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { APPLET_BUILD_LIMITS } from "@frockbot/applets/build-contract";
import { appletsSourceRootV1 } from "@frockbot/applets/root";
import { workspaceObjectKeyV1 } from "@frockbot/core/workspace-store";
import { pluginsSourceRootV1 } from "@frockbot/app/plugins/root";
import { frockbotToolCallPrompt } from "./harness/miniflare.ts";
import { provisionBot } from "./provision-bot.ts";
import type { FakeAppletBuildRequestV1 } from "./applet-build-fake.ts";

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
  features: { applets?: boolean; pluginAuthoring?: boolean },
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
      applets: features.applets ?? false,
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

/** What `applet_files` and `plugin_files` list, in the order they list it. */
function listedFiles(content: string): Array<{ path: string; size: number }> {
  const lines = content.split("\n").slice(1);
  return lines.map((line) => {
    const match = /^(.*) — (\d+) bytes$/u.exec(line);
    if (!match) throw new Error(`unreadable listing line: ${line}`);
    return { path: match[1] ?? "", size: Number(match[2]) };
  });
}

/** The appletId an Applet was created under, from the directory that minted it. */
async function appletIdNamed(
  identity: Identity,
  displayName: string,
): Promise<string> {
  const directory = env.USER_CONFIGURATIONS.getByName(
    identity.userId,
  ) as unknown as {
    listApplets(input: unknown): Promise<{
      applets: Array<{ appletId: string; displayName: string }>;
    }>;
  };
  const { applets } = await directory.listApplets({
    schemaVersion: 1,
    ...identity,
  });
  const applet = applets.find(
    (candidate) => candidate.displayName === displayName,
  );
  if (!applet) throw new Error(`the directory has no "${displayName}"`);
  return applet.appletId;
}

/** Every build the fake has been asked for one artifact, oldest first. */
async function buildsFor(id: string): Promise<FakeAppletBuildRequestV1[]> {
  const response = await env.APPLET_BUILD.fetch(
    "https://applet-build.internal/__fake/requests",
  );
  const { requests } = (await response.json()) as {
    requests: FakeAppletBuildRequestV1[];
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
  test("an Applet's files are written, listed, read back, and stored under their media type", async () => {
    const id = suffix();
    const identity = { userId: `author-applet-${id}`, botId: `bot-${id}` };
    await provisionBot(identity);
    await setFeatures(identity.userId, { applets: true });

    const created = await tool(identity, "applet_create", {
      displayName: "Weekly Todos",
    });
    expect(created).toContain("Weekly Todos");
    const appletId = await appletIdNamed(identity, "Weekly Todos");

    // A file the scaffold never wrote, under a directory of its own, so the
    // listing is asked to be both ordered and recursive.
    const notes = "# Notes\n\nWritten by the Bot, in the cloud.\n";
    const wrote = await tool(identity, "applet_write_file", {
      appletId,
      path: "notes/readme.md",
      text: notes,
    });
    expect(wrote).toContain("notes/readme.md");
    expect(wrote).toContain(`${notes.length} characters`);

    const files = listedFiles(await tool(identity, "applet_files", { appletId }));
    // The scaffold's four files, plus the one just written, in the order the
    // repository lists them: `localeCompare`, so `notes/…` sorts before
    // `README.md` rather than by code unit.
    expect(files.map((file) => file.path)).toEqual([
      "applet.json",
      "notes/readme.md",
      "README.md",
      "server.ts",
      "ui.tsx",
    ]);
    expect(files.find((file) => file.path === "notes/readme.md")?.size).toBe(
      notes.length,
    );

    // The bytes read back are the bytes written, exactly.
    expect(
      await tool(identity, "applet_read_file", {
        appletId,
        path: "notes/readme.md",
      }),
    ).toBe(notes);

    // The optimistic write: an existing file is replaced under the generation
    // the writer read, rather than refused as a file that already exists.
    const edited = "# Notes\n\nEdited twice.\n";
    await tool(identity, "applet_write_file", {
      appletId,
      path: "notes/readme.md",
      text: edited,
    });
    expect(
      await tool(identity, "applet_read_file", {
        appletId,
        path: "notes/readme.md",
      }),
    ).toBe(edited);
    expect(
      listedFiles(await tool(identity, "applet_files", { appletId })).find(
        (file) => file.path === "notes/readme.md",
      )?.size,
    ).toBe(edited.length);

    // A file that is not there says so, and names the path it looked for.
    const missing = await callTool(identity, "applet_read_file", {
      appletId,
      path: "notes/gone.md",
    });
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain('"notes/gone.md" is not-found');

    const root = appletsSourceRootV1(identity.userId);
    expect(await storedMediaType(root, `${appletId}/applet.json`)).toBe(
      "application/json",
    );
    expect(await storedMediaType(root, `${appletId}/notes/readme.md`)).toBe(
      "text/plain; charset=utf-8",
    );
  });

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
    expect(files.map((file) => file.path)).toEqual(["plugin.json", "plugin.ts"]);
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

  test("a check posts the whole source it read, in order, and refuses a directory past the file ceiling", async () => {
    const id = suffix();
    const identity = { userId: `author-check-${id}`, botId: `bot-${id}` };
    await provisionBot(identity);
    await setFeatures(identity.userId, { applets: true });

    await tool(identity, "applet_create", { displayName: "Checked Todos" });
    const appletId = await appletIdNamed(identity, "Checked Todos");
    const notes = "# Checked\n";
    await tool(identity, "applet_write_file", {
      appletId,
      path: "notes/readme.md",
      text: notes,
    });

    const listed = listedFiles(
      await tool(identity, "applet_files", { appletId }),
    ).map((file) => file.path);
    const checked = await tool(identity, "applet_check", { appletId });
    expect(checked).toContain(`${appletId} builds.`);

    // What the build service was handed is the file set the listing names, in
    // that order, with the text that was written.
    const [appletBuild] = await buildsFor(appletId);
    expect(appletBuild?.kind).toBe("applet");
    expect(appletBuild?.mode).toBe("build");
    expect(appletBuild?.files.map((file) => file.path)).toEqual(listed);
    expect(
      appletBuild?.files.find((file) => file.path === "notes/readme.md")?.text,
    ).toBe(notes);

    // Past the ceiling a check is refused before anything is posted, with the
    // Applet named and the limit quoted.
    const bulk = listed.length;
    for (let index = bulk; index <= 64; index += 1) {
      const path = `bulk/${String(index).padStart(2, "0")}.ts`;
      await tool(identity, "applet_write_file", {
        appletId,
        path,
        text: `export const n = ${index};\n`,
      });
    }
    expect(
      listedFiles(await tool(identity, "applet_files", { appletId })),
    ).toHaveLength(65);
    const over = await tool(identity, "applet_check", { appletId });
    expect(over).toContain("has more than 64 source files");
    expect(await buildsFor(appletId)).toHaveLength(1);
  });

  test("a check refuses source past the byte ceiling without posting it", async () => {
    const id = suffix();
    const identity = { userId: `author-bytes-${id}`, botId: `bot-${id}` };
    await provisionBot(identity);
    await setFeatures(identity.userId, { applets: true });

    await tool(identity, "applet_create", { displayName: "Heavy Todos" });
    const appletId = await appletIdNamed(identity, "Heavy Todos");

    // As much as one Turn can carry: the RPC contract bounds a Turn's own text
    // at 32,000 bytes, so one file can never reach the per-file ceiling through
    // a tool call. The aggregate one is reachable the other way — enough files
    // that each fits under what a Turn may say — and it is the same branch.
    const piece = "x".repeat(31_000);
    for (let index = 0; index < 34; index += 1) {
      await tool(identity, "applet_write_file", {
        appletId,
        path: `bulk/${String(index).padStart(2, "0")}.ts`,
        text: piece,
      });
    }
    const over = await tool(identity, "applet_check", { appletId });
    expect(over).toContain(
      `is over the ${APPLET_BUILD_LIMITS.sourceBytes}-byte ceiling the build service accepts`,
    );
    expect(await buildsFor(appletId)).toHaveLength(0);
  });

  test("a Plugin check reads its source the same way", async () => {
    const id = suffix();
    const identity = { userId: `author-plugin-check-${id}`, botId: `bot-${id}` };
    await provisionBot(identity);
    await setFeatures(identity.userId, { pluginAuthoring: true });

    await tool(identity, "plugin_create", { displayName: "Checked Notes" });
    const checked = await tool(identity, "plugin_check", {
      pluginId: "checked-notes",
    });
    expect(checked).toContain("checked-notes builds.");

    const [pluginBuild] = await buildsFor("checked-notes");
    expect(pluginBuild?.kind).toBe("plugin");
    expect(pluginBuild?.mode).toBe("check");
    expect(pluginBuild?.files.map((file) => file.path)).toEqual([
      "plugin.json",
      "plugin.ts",
    ]);
    const listed = listedFiles(
      await tool(identity, "plugin_files", { pluginId: "checked-notes" }),
    );
    expect(
      pluginBuild?.files.map((file) => file.text.length),
    ).toEqual(listed.map((file) => file.size));
  });
});
