// The Applets feature: fourteen tools a Bot uses to build, share and hand over
// the small real-time apps that appear beside the conversation.
//
// Everything here is text a model reads. A tool that returns a JSON blob makes
// the model guess; a tool that returns a sentence naming the next command does
// not. So each verb answers with what happened, what it is called now, and the
// single next thing to do.
//
// The Applets an Account holds are plugins — Bot-authored code, isolate-loaded,
// content-addressed. The tools that *manage* them are not: they are ordinary
// first-party code, mounted for a Turn like Memory or Skills, calling the Bot
// Durable Object's authority directly.
import type {
  AppletGenerationSummaryV1,
  AppletPublishResultV1,
  AppletSummaryV1,
  RuntimeFeatureV1,
  ToolDefinition,
  ToolRegistration,
} from "@frockbot/core/contracts";
import type { FocusedAppletV1 } from "@frockbot/core/durable";
import {
  AppletBuildDecodeError,
  decodeAppletSourcePathV1,
} from "./build-contract.js";
import { APPLET_TEMPLATE_FILES_V1 } from "./template.generated.js";

/** The Session, run and Turn one Applet effect is attributed to. */
export interface AppletCapabilityCallScopeV1 {
  sessionId: string;
  runId: string;
  turnId: string;
  effectId: string;
}

/** One file of an Applet's source, as the Bot lists it. */
export interface AppletSourceFileV1 {
  path: string;
  size: number;
}

/**
 * What a check answers. A failure carries the build's own diagnostics, already
 * `path:line:col message`, because that is what a Bot acts on; a success
 * carries the tools the built code declares and — when this deployment serves
 * one — the page it can look at before publishing.
 */
export type AppletCheckResultV1 =
  | { status: "checked"; tools: string[]; previewUrl?: string }
  | { status: "failed"; reason: string; diagnostics: string[] };

/**
 * The Applet authority, as the Bot Durable Object implements it. Every method
 * acts as this Bot: `list` is what it owns or is shared, and everything that
 * reads or changes source, generations or access is refused for an Applet it
 * does not own.
 */
export interface AppletCapabilityHostV1 {
  list(): Promise<AppletSummaryV1[]>;
  create(
    input: { displayName: string },
    scope: AppletCapabilityCallScopeV1,
  ): Promise<AppletSummaryV1>;
  /** One Applet's source paths and their sizes. */
  files(input: { appletId: string }): Promise<AppletSourceFileV1[]>;
  readFile(input: { appletId: string; path: string }): Promise<string>;
  /**
   * Writes one source file, superseding whatever generation it holds. Throws
   * with the store's own reason, which the tool hands back to the model.
   */
  writeFile(
    input: { appletId: string; path: string; text: string },
    scope: AppletCapabilityCallScopeV1,
  ): Promise<void>;
  /** Builds the Applet without publishing it. */
  check(
    input: { appletId: string },
    scope: AppletCapabilityCallScopeV1,
  ): Promise<AppletCheckResultV1>;
  publish(
    input: { appletId: string },
    scope: AppletCapabilityCallScopeV1,
  ): Promise<AppletPublishResultV1>;
  revert(
    input: { appletId: string; generationId: string },
    scope: AppletCapabilityCallScopeV1,
  ): Promise<AppletPublishResultV1>;
  delete(input: { appletId: string }): Promise<{ status: "deleted" }>;
  /** `botId` is the other Bot of this User being given or losing access. */
  share(input: { appletId: string; botId: string }): Promise<AppletSummaryV1>;
  unshare(input: { appletId: string; botId: string }): Promise<AppletSummaryV1>;
  /** Makes `botId` the owner; this Bot keeps shared access. */
  transfer(input: {
    appletId: string;
    botId: string;
  }): Promise<AppletSummaryV1>;
  focus(input: { appletId: string | null }): Promise<FocusedAppletV1>;
  generations(input: {
    appletId: string;
  }): Promise<AppletGenerationSummaryV1[]>;
  /** What the shell reads for the canvas, and what a route projects. */
  readFocused(): Promise<FocusedAppletV1>;
}

/** What the Bot Durable Object hands this feature for one admitted Turn. */
export interface AppletsRuntimeHostV1 {
  readonly applets: AppletCapabilityHostV1;
  /** The Turn every effect this feature records is attributed to. */
  readonly turn: { sessionId: string; runId: string; turnId: string };
}

function requireString(input: unknown, field: string): string {
  const value = (input as Record<string, unknown> | null | undefined)?.[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} is required`);
  }
  return value;
}

function describe(applet: AppletSummaryV1): string {
  const tools =
    applet.tools.length === 0 ? "no tools yet" : applet.tools.join(", ");
  const access =
    applet.access === "owner"
      ? applet.sharedWithBotIds.length === 0
        ? "yours"
        : `yours, shared with ${applet.sharedWithBotIds.join(", ")}`
      : `shared with you by ${applet.ownerBotId}`;
  return `${applet.displayName} (${applet.appletId}) — ${access}, ${applet.status}, ${
    applet.currentGenerationId
      ? `generation ${applet.currentGenerationId}`
      : "never published"
  }, ${tools}`;
}

function accessText(applet: AppletSummaryV1): string {
  return applet.sharedWithBotIds.length === 0
    ? `${applet.appletId} is shared with no other Bot.`
    : `${applet.appletId} is shared with ${applet.sharedWithBotIds.join(", ")}.`;
}

const TARGET_BOT_SCHEMA = {
  type: "string",
  description:
    "The other Bot's id, as <teammates> names it. It must be an active Bot of this User.",
};

/**
 * The template's bytes, from the base64 the build embedded.
 *
 * Applet source carries import specifiers of its own, so the scaffold travels
 * encoded rather than as literal source inside a generated module.
 */
function decodeTemplate(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

/** The scaffold, with the template's two placeholders filled in. */
function scaffold(displayName: string): Array<{ path: string; text: string }> {
  const slug =
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^[^a-z]*/, "")
      .slice(0, 32) || "applet";
  return APPLET_TEMPLATE_FILES_V1.map((file) => ({
    path: file.path,
    text: decodeTemplate(file.base64)
      .split("__APPLET_ID__")
      .join(slug)
      .split("__APPLET_NAME__")
      .join(displayName),
  }));
}

async function writeScaffold(
  host: AppletsRuntimeHostV1,
  appletId: string,
  displayName: string,
): Promise<string[]> {
  const written: string[] = [];
  for (const file of scaffold(displayName)) {
    await host.applets.writeFile(
      { appletId, path: file.path, text: file.text },
      scopeFor(host, `write:${file.path}`, appletId),
    );
    written.push(file.path);
  }
  return written;
}

/** A source path the build service will accept, or a thrown sentence. */
function requirePath(input: unknown): string {
  try {
    return decodeAppletSourcePathV1(requireString(input, "path"));
  } catch (error) {
    throw new Error(
      error instanceof AppletBuildDecodeError
        ? `path is invalid: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error),
    );
  }
}

function checkText(appletId: string, result: AppletCheckResultV1): string {
  if (result.status === "failed") {
    return [
      `${appletId} does not build yet: ${result.reason}`,
      ...result.diagnostics,
      "Fix every line above with applet_write_file, then run applet_check again. Do not publish over a failing check.",
    ].join("\n");
  }
  return [
    `${appletId} builds.`,
    result.tools.length === 0
      ? "It declares no tools."
      : `It declares ${result.tools.join(", ")}.`,
    result.previewUrl
      ? `Its page is at ${result.previewUrl} — nothing is published and no data is live there.`
      : undefined,
    "Call applet_publish when it is what you want.",
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
}

function publishText(result: AppletPublishResultV1, verb: string): string {
  if (result.status === "published") {
    const tools =
      result.tools.length === 0
        ? "It declares no tools."
        : `Its tools are now ${result.tools.join(", ")}, offered from your next Turn.`;
    return [
      `${verb} ${result.appletId} as generation ${result.generationId}.`,
      tools,
      result.compositionGenerationId
        ? `Recorded as Composition generation ${result.compositionGenerationId}.`
        : undefined,
      "It is in the panel beside the conversation now.",
    ]
      .filter((part): part is string => part !== undefined)
      .join(" ");
  }
  return [
    `${verb === "Published" ? "Publishing" : "Reverting"} ${result.appletId} failed: ${result.reason}`,
    ...result.diagnostics,
    "Nothing changed: the Applet is still on the generation it was on.",
  ].join("\n");
}

function generationsText(
  appletId: string,
  generations: AppletGenerationSummaryV1[],
): string {
  if (generations.length === 0) {
    return `${appletId} has no generations yet. Build it and call applet_publish.`;
  }
  return [
    `${appletId} has ${generations.length} generation(s), newest first:`,
    ...generations.map(
      (generation) =>
        `${generation.generationId} — ${generation.origin}, ${generation.status}${
          generation.isCurrent ? ", current" : ""
        }, tools: ${
          generation.tools.length === 0 ? "none" : generation.tools.join(", ")
        }`,
    ),
  ].join("\n");
}

/**
 * The scope one effect is recorded under. An Applet id — or `new` for a
 * create — keys the effect, so a retried call after an interruption is
 * recognised rather than repeated.
 */
function scopeFor(
  host: AppletsRuntimeHostV1,
  op: string,
  appletId?: string,
): AppletCapabilityCallScopeV1 {
  return {
    ...host.turn,
    effectId: `applet:${host.turn.turnId}:${op}:${appletId ?? "new"}`,
  };
}

function tool(
  definition: Omit<ToolDefinition, "execute"> & {
    answer(input: unknown): Promise<string>;
  },
): ToolDefinition {
  const { answer, ...schema } = definition;
  return {
    ...schema,
    async execute(input) {
      try {
        return { content: await answer(input), isError: false };
      } catch (error) {
        // The reason is the whole answer: a Bot told "Applets are unavailable"
        // retries forever, where "run `applet build` first" ends the loop.
        return {
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    },
  };
}

function appletTools(host: AppletsRuntimeHostV1): ToolDefinition[] {
  return [
    tool({
      name: "applet_list",
      description:
        "List the Applets you can use: the small real-time apps that appear beside the conversation. Each is either yours — you own it and may change it — or shared with you by the Bot that owns it, which lets you open it and call its tools but not change it. Call this before creating one, so you extend an Applet you own instead of building a second one.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      idempotent: true,
      async answer() {
        const applets = await host.applets.list();
        if (applets.length === 0) {
          return "You have no Applets yet, and none is shared with you. applet_create scaffolds one from a working todo-list starting point.";
        }
        return [
          `${applets.length} Applet(s):`,
          ...applets.map((applet) => describe(applet)),
        ].join("\n");
      },
    }),
    tool({
      name: "applet_create",
      description:
        "Create a new Applet you own and scaffold its source. This makes the directory entry, writes a working todo-list starting point, and focuses it so the User watches you build it. It does not publish anything: edit the files with applet_write_file, run applet_check, then call applet_publish. No other Bot can use it until you share it. Load the `applets` Skill before you start editing.",
      inputSchema: {
        type: "object",
        properties: {
          displayName: {
            type: "string",
            description:
              "What the User will call this Applet, in their words. 1-128 characters.",
            minLength: 1,
            maxLength: 128,
          },
        },
        required: ["displayName"],
        additionalProperties: false,
      },
      idempotent: false,
      async answer(input) {
        const displayName = requireString(input, "displayName");
        const created = await host.applets.create(
          { displayName },
          scopeFor(host, "create"),
        );
        const written = await writeScaffold(
          host,
          created.appletId,
          displayName,
        );
        return [
          `Created "${created.displayName}" (${created.appletId}) and put it in the panel beside the conversation.`,
          `Its source is ${written.join(", ")} — the SDK's todo-list starting point, which already builds.`,
          "The loop from here is applet_write_file, applet_check, applet_publish:",
          "1. Read the `applets` Skill if you have not already — it is the SDK reference.",
          "2. applet_read_file and applet_write_file on server.ts (tables and tools) and ui.tsx (the page).",
          `3. applet_check with appletId ${created.appletId}, and fix every diagnostic it returns.`,
          `4. applet_publish with appletId ${created.appletId}.`,
        ].join("\n");
      },
    }),
    tool({
      name: "applet_files",
      description:
        "List the source files of an Applet you own, and their sizes. This is the Applet's real source: what applet_check builds and what applet_publish publishes. An Applet shared with you has no source you can read.",
      inputSchema: {
        type: "object",
        properties: {
          appletId: { type: "string", description: "The Applet's id." },
        },
        required: ["appletId"],
        additionalProperties: false,
      },
      idempotent: true,
      async answer(input) {
        const appletId = requireString(input, "appletId");
        const files = await host.applets.files({ appletId });
        if (files.length === 0) {
          return `${appletId} has no source yet. applet_create scaffolds a working starting point.`;
        }
        return [
          `${appletId} has ${files.length} source file(s):`,
          ...files.map((file) => `${file.path} — ${file.size} bytes`),
        ].join("\n");
      },
    }),
    tool({
      name: "applet_read_file",
      description:
        "Read one source file of an Applet you own. Read before you write: applet_write_file replaces the whole file, so an edit made from memory loses whatever you did not remember.",
      inputSchema: {
        type: "object",
        properties: {
          appletId: { type: "string", description: "The Applet's id." },
          path: {
            type: "string",
            description:
              "The file's path inside the Applet, such as server.ts or ui.tsx.",
          },
        },
        required: ["appletId", "path"],
        additionalProperties: false,
      },
      idempotent: true,
      async answer(input) {
        const appletId = requireString(input, "appletId");
        const path = requirePath(input);
        return await host.applets.readFile({ appletId, path });
      },
    }),
    tool({
      name: "applet_write_file",
      description:
        "Write one source file of an Applet you own, replacing it entirely. Nothing is built or published by this: call applet_check when the edit is complete.",
      inputSchema: {
        type: "object",
        properties: {
          appletId: { type: "string", description: "The Applet's id." },
          path: {
            type: "string",
            description:
              "The file's path inside the Applet, such as server.ts or ui.tsx. Relative, no leading slash and no `..`.",
          },
          text: {
            type: "string",
            description: "The file's whole new contents.",
          },
        },
        required: ["appletId", "path", "text"],
        additionalProperties: false,
      },
      idempotent: false,
      async answer(input) {
        const appletId = requireString(input, "appletId");
        const path = requirePath(input);
        const text = (input as Record<string, unknown>).text;
        if (typeof text !== "string") throw new Error("text is required");
        await host.applets.writeFile(
          { appletId, path, text },
          scopeFor(host, `write:${path}`, appletId),
        );
        return `Wrote ${path} in ${appletId} (${text.length} characters). Run applet_check when the edit is complete.`;
      },
    }),
    tool({
      name: "applet_check",
      description:
        "Type-check, lint and build the current source of an Applet you own, without publishing it. Returns every diagnostic as `file:line:col message`, or — when it builds — the tools it declares and a URL for its page. Do this before every publish.",
      inputSchema: {
        type: "object",
        properties: {
          appletId: { type: "string", description: "The Applet's id." },
        },
        required: ["appletId"],
        additionalProperties: false,
      },
      idempotent: true,
      async answer(input) {
        const appletId = requireString(input, "appletId");
        return checkText(
          appletId,
          await host.applets.check(
            { appletId },
            scopeFor(host, "check", appletId),
          ),
        );
      },
    }),
    tool({
      name: "applet_publish",
      description:
        "Build the current source of an Applet you own and publish it. Records an immutable generation, mounts it, and offers its tools to you and every Bot it is shared with from the next Turn. Run applet_check first; a publish that does not build is refused and returns the same diagnostics.",
      inputSchema: {
        type: "object",
        properties: {
          appletId: { type: "string", description: "The Applet's id." },
        },
        required: ["appletId"],
        additionalProperties: false,
      },
      idempotent: false,
      async answer(input) {
        const appletId = requireString(input, "appletId");
        return publishText(
          await host.applets.publish(
            { appletId },
            scopeFor(host, "publish", appletId),
          ),
          "Published",
        );
      },
    }),
    tool({
      name: "applet_revert",
      description:
        "Move an Applet you own back to an earlier generation. The revert is itself recorded as a generation, and the Applet's stored data is untouched — reverting the code never clears what the User put in it. Use applet_generations to find the id.",
      inputSchema: {
        type: "object",
        properties: {
          appletId: { type: "string", description: "The Applet's id." },
          generationId: {
            type: "string",
            description: "The generation to make current again.",
          },
        },
        required: ["appletId", "generationId"],
        additionalProperties: false,
      },
      idempotent: false,
      async answer(input) {
        const appletId = requireString(input, "appletId");
        const generationId = requireString(input, "generationId");
        return publishText(
          await host.applets.revert(
            { appletId, generationId },
            scopeFor(host, "revert", appletId),
          ),
          "Reverted",
        );
      },
    }),
    tool({
      name: "applet_delete",
      description:
        "Delete an Applet you own permanently: its stored data, its versions, and its entry, for you and for every Bot it is shared with. This cannot be undone and it is the User's decision, not yours — ask before calling it. To stop using an Applet another Bot owns, ask that Bot to unshare it.",
      inputSchema: {
        type: "object",
        properties: {
          appletId: { type: "string", description: "The Applet's id." },
        },
        required: ["appletId"],
        additionalProperties: false,
      },
      idempotent: false,
      async answer(input) {
        const appletId = requireString(input, "appletId");
        await host.applets.delete({ appletId });
        return `Deleted ${appletId}. Its data, its versions, and its tools are gone for every Bot that used it; this cannot be undone.`;
      },
    }),
    tool({
      name: "applet_share",
      description:
        "Let another active Bot of this User use an Applet you own: it can open the Applet, use its page and call its published tools, but it cannot read or change the source, publish, revert, delete or share it. Its tools reach that Bot from its next Turn.",
      inputSchema: {
        type: "object",
        properties: {
          appletId: { type: "string", description: "The Applet's id." },
          botId: TARGET_BOT_SCHEMA,
        },
        required: ["appletId", "botId"],
        additionalProperties: false,
      },
      idempotent: true,
      async answer(input) {
        const appletId = requireString(input, "appletId");
        const botId = requireString(input, "botId");
        const shared = await host.applets.share({ appletId, botId });
        return `Shared ${appletId} with ${botId}. ${accessText(shared)} Its tools reach ${botId} from its next Turn.`;
      },
    }),
    tool({
      name: "applet_unshare",
      description:
        "Stop another Bot using an Applet you own. It can no longer open the Applet, and its tools leave that Bot from its next Turn; a Turn it is already running keeps them until it ends. Nothing about the Applet's data changes.",
      inputSchema: {
        type: "object",
        properties: {
          appletId: { type: "string", description: "The Applet's id." },
          botId: TARGET_BOT_SCHEMA,
        },
        required: ["appletId", "botId"],
        additionalProperties: false,
      },
      idempotent: true,
      async answer(input) {
        const appletId = requireString(input, "appletId");
        const botId = requireString(input, "botId");
        const unshared = await host.applets.unshare({ appletId, botId });
        return `${botId} no longer has access to ${appletId}. ${accessText(unshared)}`;
      },
    }),
    tool({
      name: "applet_transfer",
      description:
        "Hand an Applet you own to another active Bot of this User. That Bot becomes its owner and is the only one who can change it from now on; you keep shared access, so you can still open it and call its tools. Its source, versions and data move nowhere. Only do this when the User asks.",
      inputSchema: {
        type: "object",
        properties: {
          appletId: { type: "string", description: "The Applet's id." },
          botId: TARGET_BOT_SCHEMA,
        },
        required: ["appletId", "botId"],
        additionalProperties: false,
      },
      idempotent: false,
      async answer(input) {
        const appletId = requireString(input, "appletId");
        const botId = requireString(input, "botId");
        await host.applets.transfer({ appletId, botId });
        return `${botId} now owns ${appletId}. You keep shared access: you can open it and call its tools, and ${botId} is the one to ask for any change to it.`;
      },
    }),
    tool({
      name: "applet_focus",
      description:
        "Show one Applet you own or that is shared with you in the panel beside this conversation, or clear it. Pass null to close the panel. Creating and publishing already focus the Applet, so use this when the User asks to look at a different one.",
      inputSchema: {
        type: "object",
        properties: {
          appletId: {
            type: ["string", "null"],
            description: "The Applet to show, or null to close the panel.",
          },
        },
        required: ["appletId"],
        additionalProperties: false,
      },
      idempotent: false,
      async answer(input) {
        const raw = (input as Record<string, unknown> | null | undefined)
          ?.appletId;
        if (raw !== null && typeof raw !== "string") {
          throw new Error("appletId must be an Applet id or null");
        }
        const focused = await host.applets.focus({ appletId: raw });
        return focused.appletId === null
          ? "Closed the Applet panel."
          : `Showing ${focused.appletId} in the panel beside the conversation.`;
      },
    }),
    tool({
      name: "applet_generations",
      description:
        "List the version history of an Applet you own, newest first: which generation is current, which failed, and what tools each one offered. Read this before applet_revert.",
      inputSchema: {
        type: "object",
        properties: {
          appletId: { type: "string", description: "The Applet's id." },
        },
        required: ["appletId"],
        additionalProperties: false,
      },
      idempotent: true,
      async answer(input) {
        const appletId = requireString(input, "appletId");
        return generationsText(
          appletId,
          await host.applets.generations({ appletId }),
        );
      },
    }),
  ];
}

/** The runtime Contribution: the fourteen `applet_*` tools, for one Turn. */
export function createAppletsFeature(
  host: AppletsRuntimeHostV1,
): RuntimeFeatureV1<{ tools: ToolRegistration }> {
  return (runtime) => {
    const disposers = appletTools(host).map((definition) =>
      runtime.tools.register({ ...definition, namespace: "frockbot" }),
    );
    return () => {
      for (const dispose of disposers.toReversed()) dispose();
    };
  };
}
