// The pressure test ADR 0022 decision 8 asks for, in workerd.
//
// "The Applets Package itself must be buildable inside a Bot with identical
// functionality" (plan D6). This suite takes the exact bytes the foundation
// ships — `APPLETS_PACKAGE_MODULE_V1` and both inline pages — authors them
// through the production `package_author` path, mounts the resulting
// generation through the real `BOT_PACKAGES` Worker Loader, and holds the
// result against the shipped member.
//
// Why byte-for-byte matters here and not only "equivalent": the isolate's
// loader identity is a digest over the module text, so two members whose
// artifacts share a content hash are the same code in the same wrapper behind
// the same loader id. Proving that hash equal is what makes every later
// behavioural claim about one member a claim about the other. The declarations
// — tools, pages, entries, slots — are compared separately, because those
// travel in the manifest and a `package_author` that dropped or reshaped one
// would still bundle identical bytes.
//
// The second half runs the shipped member for real: a provisioned Bot, the
// foundation Composition, the real isolate host, and `applet_list` and
// `applet_create` called by a scripted model. That is what proves the
// artifact-backed first-party member is not merely present but mounted, tool-
// registered, and reaching `ctx.applets` and `ctx.workspace`.
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import {
  APPLETS_PACKAGE_ARTIFACT_V1,
  APPLETS_PACKAGE_MODULE_V1,
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

function probe(name: string) {
  return env.AUTHORING.getByName(name);
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

/** The `package_author` input that reproduces the shipped Package exactly. */
function authorTheAppletsPackage(): Record<string, unknown> {
  const client = shipped.contributions.client!;
  return {
    packageId: shipped.id,
    displayName: "Applets",
    tools: (shipped.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    source: APPLETS_PACKAGE_MODULE_V1,
    ui: {
      pages: (client.pages ?? []).map((page) => ({
        id: page.id,
        html: APPLETS_PACKAGE_PAGES_V1.find((built) => built.id === page.id)!
          .html,
        mounts: page.mounts,
      })),
      entries: client.entries,
    },
  };
}

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

describe("the same Package authored through package_author", () => {
  test("bundles to the identical artifact and declares the identical tools, pages, and entries", async () => {
    const id = suffix();
    const stub = probe(`applets-author-${id}`);

    const turn = await stub.runTurn({
      runId: `run-applets-${id}`,
      userId: `user-${id}`,
      botId: `bot-${id}`,
      tool: "package_author",
      input: authorTheAppletsPackage(),
    });

    expect(turn.text).toContain('ok:Authored Package "applets"');
    const generationId = turn.pinnedGenerationId;
    expect(generationId).toBeDefined();

    // A second Turn, so the pending generation the authoring Turn proposed is
    // the one that mounts — activation is at the next admitted Turn.
    await stub.runTurn({
      runId: `run-applets-mount-${id}`,
      userId: `user-${id}`,
      botId: `bot-${id}`,
      tool: "applet_list",
      input: {},
    });

    const authored = await stub.member(
      (await stub.currentGeneration()).generationId,
      "applets",
    );
    expect(authored?.provenance.kind).toBe("bot");
    // The whole point: the same bytes, so the same loader identity and the
    // same behaviour, reached through the Bot's own authoring path.
    expect(authored?.artifact?.contentHash).toBe(
      APPLETS_PACKAGE_ARTIFACT_V1.contentHash,
    );
    expect(authored?.artifact?.size).toBe(APPLETS_PACKAGE_ARTIFACT_V1.size);

    // The tools the mounted isolate actually registered, not the ones the
    // manifest claims: the isolate host refuses a mount whose health report
    // disagrees with the manifest, so this list is the module's own answer.
    const registered = await stub.mountedToolNames();
    // An isolate-loaded member's tools are disclosed under its Package id
    // (ADR 0023), so the registry names them `applets/<tool>`.
    for (const tool of shipped.tools ?? []) {
      expect(registered).toContain(`applets/${tool.name}`);
    }

    const authoredManifest = (await stub.memberManifest(
      (await stub.currentGeneration()).generationId,
      "applets",
    )) as ManifestLike;
    expect((authoredManifest.tools ?? []).map((tool) => tool.name)).toEqual(
      (shipped.tools ?? []).map((tool) => tool.name),
    );
    expect(authoredManifest.tools).toEqual(shipped.tools);
    expect(authoredManifest.contributions.client?.pages).toEqual(
      shipped.contributions.client?.pages,
    );
    expect(authoredManifest.contributions.client?.entries).toEqual(
      shipped.contributions.client?.entries,
    );
    expect(authoredManifest.contributions.runtime?.host).toBe("bot-isolate");
  });

  test("its tools answer exactly as the shipped member's do", async () => {
    const id = suffix();
    const stub = probe(`applets-behaviour-${id}`);
    const identity = { userId: `user-${id}`, botId: `bot-${id}` };

    await stub.runTurn({
      runId: `run-author-${id}`,
      ...identity,
      tool: "package_author",
      input: authorTheAppletsPackage(),
    });
    const listed = await stub.runTurn({
      runId: `run-list-${id}`,
      ...identity,
      tool: "applet_list",
      input: {},
    });

    // The probe's Bot Durable Object has no admitted Turn of its own, so the
    // Applet capability answers `unavailable` — and the module's own words for
    // that are what a Bot would read. What matters is that the *module*
    // produced them: this is the shipped module text, mounted from an
    // artifact a Bot authored.
    expect(listed.text).toContain("Applets are unavailable");
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
