// The Applets Package pressure test, in workerd.
//
// The shipped Applets member, run for real: a provisioned Bot, the foundation
// Composition, the real isolate host, and `applet_list` and `applet_create`
// called by a scripted model. That is what proves the artifact-backed
// first-party member is not merely present but mounted, tool-registered, and
// reaching `ctx.applets` and `ctx.workspace`.
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import {
  APPLETS_PACKAGE_ARTIFACT_V1,
  APPLETS_PACKAGE_PAGES_V1,
} from "@frockbot/application-foundation/generated/applets-artifact";
import { compileFoundationApplication } from "@frockbot/application-foundation/runtime";
import appletsManifest from "@frockbot/plugin-applets/manifest";
import { toolCallTriggerPrompt } from "./harness/miniflare.ts";
import { dynamicToolInputV1 } from "./dynamic-tools.ts";
import { provisionBot } from "./provision-bot.ts";

const APPLETS_SPECIFIER = "@frockbot/plugin-applets";

function suffix(): string {
  return crypto.randomUUID().slice(0, 8);
}

function botStub(userId: string, botId: string) {
  return env.BOT_STATES.getByName(`${userId}:${botId}`);
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

/** The manifest shape both halves are compared through. */
interface ManifestLike {
  id: string;
  tools?: Array<{ name: string; description: string; inputSchema: unknown }>;
  roots?: Array<{ id: string; scope: string }>;
  contributions: {
    runtime?: { entry: string; host?: string };
    backend?: unknown;
    client?: {
      kind?: string;
      pages?: Array<{
        id: string;
        artifact: { contentHash: string; size: number };
        mounts: Array<{ slot: string; order?: number }>;
      }>;
      entries?: Array<Record<string, unknown>>;
    };
  };
}

const shipped = appletsManifest as unknown as ManifestLike;

/** The one tool result a scripted single-call Turn recorded. */
function toolResult(turn: {
  events: Array<{ type: string; content?: string; isError?: boolean }>;
}): { content: string; isError: boolean } {
  const result = turn.events.find((event) => event.type === "tool/result");
  if (!result) throw new Error("the Turn recorded no tool result");
  return { content: result.content ?? "", isError: result.isError === true };
}

describe("the Applets Package as the foundation ships it", () => {
  test("is an artifact-backed first-party member with no in-process code", async () => {
    const plan = await compileFoundationApplication();
    const member = plan.packages.find(
      (pkg) => pkg.specifier === APPLETS_SPECIFIER,
    );

    expect(member).toBeDefined();
    expect(member!.artifact).toEqual(APPLETS_PACKAGE_ARTIFACT_V1);
    expect(shipped.contributions.runtime).toEqual({
      entry: "./package",
      host: "bot-isolate",
    });
    expect(shipped.contributions.backend).toBeUndefined();
    expect(shipped.contributions.client?.kind).toBe("iframe");
    expect(shipped.roots).toEqual([{ id: "source", scope: "user" }]);
  });
});

describe("the shipped member inside a real Bot", () => {
  test("offers applet_list and applet_create, and applet_create scaffolds the source", async () => {
    const id = suffix();
    const identity = {
      userId: `applets-user-${id}`,
      botId: `applets-bot-${id}`,
    };
    await provisionBot(identity);
    const bot = botStub(identity.userId, identity.botId);

    const empty = await bot.run({
      schemaVersion: 1,
      ...identity,
      command: {
        runId: `run-list-${id}`,
        sessionId: `${identity.userId}:${identity.botId}`,
        acceptedAt: new Date().toISOString(),
        text: toolCallTriggerPrompt([
          "call_dynamic_tool",
          dynamicToolInputV1({
            namespace: "applets",
            toolName: "applet_list",
            input: {},
            description: "List the Applets",
          }),
        ]),
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
        sessionId: `${identity.userId}:${identity.botId}`,
        acceptedAt: new Date().toISOString(),
        text: toolCallTriggerPrompt([
          "call_dynamic_tool",
          dynamicToolInputV1({
            namespace: "applets",
            toolName: "applet_create",
            input: { displayName: "Weekly Todos" },
            description: "Create the Weekly Todos Applet",
          }),
        ]),
      },
    });

    const createdResult = toolResult(created as never);
    expect(createdResult.isError).toBe(false);
    expect(createdResult.content).toContain("Weekly Todos");
    expect(createdResult.content).toContain(
      "/home/box/agent-data/user-packages/applets/source/",
    );
    expect(createdResult.content).toContain("applet check");
    expect(createdResult.content).toContain("applet_publish");

    // And it is in the list now, which is the directory answering, not the
    // module remembering.
    const again = await bot.run({
      schemaVersion: 1,
      ...identity,
      command: {
        runId: `run-list-again-${id}`,
        sessionId: `${identity.userId}:${identity.botId}`,
        acceptedAt: new Date().toISOString(),
        text: toolCallTriggerPrompt([
          "call_dynamic_tool",
          dynamicToolInputV1({
            namespace: "applets",
            toolName: "applet_list",
            input: {},
            description: "List the Applets",
          }),
        ]),
      },
    });
    const relisted = toolResult(again as never);
    expect(relisted.content).toContain("Weekly Todos");
  });

  test("dispatches the envelope discovery returns, with no mcpDetails", async () => {
    // The Applets Package ships as a bundled artifact and mounts through the
    // isolate host, whose namespaces used to register `external: true`. The
    // dispatch guard then refused every call that carried no
    // `mcpDetails.description` — a field the discovery envelope, the namespace
    // prompt block and the `call_dynamic_tool` blurb all told the model to
    // omit. So the envelope offered was the envelope refused and an Applet
    // could not be created by chat at all. Every test above passes a
    // `description`, which is exactly why none of them caught it.
    const id = suffix();
    const identity = {
      userId: `applets-envelope-${id}`,
      botId: `applets-envelopebot-${id}`,
    };
    await provisionBot(identity);
    const bot = botStub(identity.userId, identity.botId);

    const created = await bot.run({
      schemaVersion: 1,
      ...identity,
      command: {
        runId: `run-envelope-${id}`,
        sessionId: `${identity.userId}:${identity.botId}`,
        acceptedAt: new Date().toISOString(),
        text: toolCallTriggerPrompt([
          "call_dynamic_tool",
          dynamicToolInputV1({
            namespace: "applets",
            toolName: "applet_create",
            input: { displayName: "Envelope Applet" },
          }),
        ]),
      },
    });

    const result = toolResult(created as never);
    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("requires mcpDetails.description");
    expect(result.content).toContain("Envelope Applet");
  });

  test("the iframe catalog carries both pages, the sidebar entry, and FrockBot provenance", async () => {
    const id = suffix();
    const identity = {
      userId: `applets-ui-${id}`,
      botId: `applets-uibot-${id}`,
    };
    await provisionBot(identity);
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
    expect(
      contribution!.pages.map((page) => page.artifact.contentHash),
    ).toEqual(APPLETS_PACKAGE_PAGES_V1.map((page) => page.contentHash));
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
    expect(contribution!.declaredTools).toEqual(
      (shipped.tools ?? []).map((tool) => tool.name),
    );
  });
});
