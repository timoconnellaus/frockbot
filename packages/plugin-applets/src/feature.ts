// The Applets feature: seven tools a Bot uses to build the small real-time
// apps that appear beside the conversation.
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
import { APPLET_TEMPLATE_FILES_V1 } from "./template.generated.js";

/** Where the durable root is mounted on a Fly Sprite. */
const COMPUTER_ROOT = "/home/box/agent-data/user-packages/applets/source";

/** The Session, run and Turn one Applet effect is attributed to. */
export interface AppletCapabilityCallScopeV1 {
  sessionId: string;
  runId: string;
  turnId: string;
  effectId: string;
}

/** The Applet authority, as the Bot Durable Object implements it. */
export interface AppletCapabilityHostV1 {
  list(): Promise<AppletSummaryV1[]>;
  create(
    input: { displayName: string },
    scope: AppletCapabilityCallScopeV1,
  ): Promise<AppletSummaryV1>;
  publish(
    input: { appletId: string },
    scope: AppletCapabilityCallScopeV1,
  ): Promise<AppletPublishResultV1>;
  revert(
    input: { appletId: string; generationId: string },
    scope: AppletCapabilityCallScopeV1,
  ): Promise<AppletPublishResultV1>;
  delete(input: { appletId: string }): Promise<{ status: "deleted" }>;
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
  /**
   * Writes one scaffold file under an Applet's source directory, in the
   * Applets Package's declared durable root. Throws with the host's own reason,
   * which the tool hands back to the model verbatim.
   */
  writeSource(input: {
    appletId: string;
    path: string;
    bytes: Uint8Array;
    mediaType: string;
  }): Promise<void>;
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
  return `${applet.displayName} (${applet.appletId}) — ${applet.status}, ${
    applet.currentGenerationId
      ? `generation ${applet.currentGenerationId}`
      : "never published"
  }, ${tools}`;
}

function sourceDirectory(appletId: string): string {
  return `${COMPUTER_ROOT}/${appletId}`;
}

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
  const encoder = new TextEncoder();
  for (const file of scaffold(displayName)) {
    await host.writeSource({
      appletId,
      path: file.path,
      bytes: encoder.encode(file.text),
      mediaType: file.path.endsWith(".json")
        ? "application/json"
        : "text/plain; charset=utf-8",
    });
    written.push(file.path);
  }
  return written;
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
        "List this User's Applets: the small real-time apps that appear beside the conversation. Every Bot of this User sees every Applet. Call this before creating one, so you extend an Applet that already exists instead of building a second one.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      idempotent: true,
      async answer() {
        const applets = await host.applets.list();
        if (applets.length === 0) {
          return "This User has no Applets yet. applet_create scaffolds one from a working todo-list starting point.";
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
        "Create a new Applet and scaffold its source. This makes the directory entry, writes a working todo-list starting point into the Applet's source directory on this User's Computer, and focuses it so the User watches you build it. It does not publish anything: edit the files, run `applet check` and `applet build` on the Computer, then call applet_publish. Load the `applets` Skill before you start editing.",
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
        const directory = sourceDirectory(created.appletId);
        return [
          `Created "${created.displayName}" (${created.appletId}) and put it in the panel beside the conversation.`,
          `Its source is on the Computer at ${directory}: ${written.join(", ")}.`,
          "It is the SDK's todo-list starting point and it already builds.",
          "Next, on the Computer:",
          `1. Read the \`applets\` Skill if you have not already — it is the SDK reference.`,
          `2. Edit server.ts (tables and tools) and ui.tsx (the page) in ${directory}.`,
          `3. Run \`applet check\` in ${directory} and fix every error it prints.`,
          `4. Run \`applet build\` in ${directory}.`,
          `5. Call applet_publish with appletId ${created.appletId}.`,
        ].join("\n");
      },
    }),
    tool({
      name: "applet_publish",
      description:
        "Publish what `applet build` last wrote for this Applet. Reads dist/server.js, dist/ui.html and dist/manifest.json from the Applet's source directory, records an immutable generation, mounts it, and offers its tools to every Bot of this User from the next Turn. Run `applet check` and `applet build` on the Computer first; a publish of a stale or failing build is refused and tells you why.",
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
        "Move an Applet back to an earlier generation. The revert is itself recorded as a generation, and the Applet's stored data is untouched — reverting the code never clears what the User put in it. Use applet_generations to find the id.",
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
        "Delete an Applet permanently: its stored data, its versions, and its entry. This cannot be undone and it is the User's decision, not yours — ask before calling it.",
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
        return `Deleted ${appletId}. Its data, its versions, and its tools are gone; this cannot be undone.`;
      },
    }),
    tool({
      name: "applet_focus",
      description:
        "Show one Applet in the panel beside this conversation, or clear it. Pass null to close the panel. Creating and publishing already focus the Applet, so use this when the User asks to look at a different one.",
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
        "List an Applet's version history, newest first: which generation is current, which failed, and what tools each one offered. Read this before applet_revert.",
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

/** The runtime Contribution: the seven `applet_*` tools, for one Turn. */
export function createAppletsFeature(
  host: AppletsRuntimeHostV1,
): RuntimeFeatureV1<{ tools: ToolRegistration }> {
  return (runtime) => {
    const disposers = appletTools(host).map((definition) =>
      runtime.tools.register(definition),
    );
    return () => {
      for (const dispose of disposers.toReversed()) dispose();
    };
  };
}
