// The Applets Package's isolate module.
//
// This is the whole Package. There is no in-process code anywhere in
// `@frockbot/plugin-applets`: ADR 0022 decision 8 makes the Applets product
// itself the pressure test for "every Contribution kind is resolved from the
// manifest and an artifact, never from a switch over Package identity", so the
// seven `applet_*` tools are written the way a Bot would have to write them —
// one `package.ts` exporting `tools` and `execute`, reaching the kernel only
// through the narrow `ctx` the generated wrapper hands it.
//
// Everything here is text a model reads. A tool that returns a JSON blob makes
// the model guess; a tool that returns a sentence naming the next command does
// not. So each verb answers with what happened, what it is called now, and the
// single next thing to do.
//
// The imports are type-only and one generated value module, so the bundled
// artifact has no import at all — `findUnresolvedSpecifier` in the bundler
// refuses a module that still carries one, and the isolate's module map has
// exactly two entries.
import type {
  AppletGenerationSummaryV1,
  AppletPublishResultV1,
  AppletSummaryV1,
  BotPackageContextV1,
  IsolateAppletsOutcomeV1,
  IsolateWorkspaceOutcomeV1,
} from "@frockbot/kernel-contracts";
import { APPLET_TEMPLATE_FILES_V1 } from "./template.generated.js";

/** Matches `frockbot.json`'s `id` and its declared root. */
const PACKAGE_ID = "applets";
const SOURCE_ROOT_ID = "source";
/** Where the durable root is mounted on a Fly Sprite. */
const COMPUTER_ROOT = "/home/box/agent-data/user-packages/applets/source";

export const tools = [
  {
    name: "applet_list",
    description:
      "List this User's Applets: the small real-time apps that appear beside the conversation. Every Bot of this User sees every Applet. Call this before creating one, so you extend an Applet that already exists instead of building a second one.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    idempotent: true,
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
];

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function requireString(input: unknown, field: string): string {
  const value = (input as Record<string, unknown> | null | undefined)?.[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} is required`);
  }
  return value;
}

/**
 * Unwrap a capability outcome, or throw the reason as the tool's answer.
 *
 * An `unavailable` outcome is a fact about this Bot's authority, not a bug, so
 * the model is told the reason verbatim rather than a generic failure.
 */
function value(outcome: IsolateAppletsOutcomeV1): unknown {
  if (outcome.status !== "available") {
    throw new Error(`Applets are unavailable: ${text(outcome.reason)}`);
  }
  return outcome.value;
}

function summary(input: unknown): AppletSummaryV1 {
  return input as AppletSummaryV1;
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
 * Not a nicety: the Package bundler refuses a module whose text carries an
 * import specifier it cannot resolve, and Applet source carries several, so
 * the scaffold travels encoded and is decoded here.
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
function scaffold(
  appletId: string,
  displayName: string,
): Array<{ path: string; text: string }> {
  const slug =
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^[^a-z]*/, "")
      .slice(0, 32) || "applet";
  return APPLET_TEMPLATE_FILES_V1.map((file) => ({
    path: `${appletId}/${file.path}`,
    text: decodeTemplate(file.base64)
      .split("__APPLET_ID__")
      .join(slug)
      .split("__APPLET_NAME__")
      .join(displayName),
  }));
}

async function writeScaffold(
  ctx: BotPackageContextV1,
  appletId: string,
  displayName: string,
): Promise<string[]> {
  const written: string[] = [];
  const encoder = new TextEncoder();
  for (const file of scaffold(appletId, displayName)) {
    const outcome: IsolateWorkspaceOutcomeV1 = await ctx.workspace.write({
      path: {
        root: {
          kind: "package-declared",
          packageId: PACKAGE_ID,
          rootId: SOURCE_ROOT_ID,
        },
        path: file.path,
      },
      bytes: encoder.encode(file.text),
      expectedGenerationId: null,
      mediaType: file.path.endsWith(".json")
        ? "application/json"
        : "text/plain; charset=utf-8",
    });
    if (outcome.status !== "available") {
      throw new Error(
        `the Applet was created but its source could not be written: ${text(
          outcome.reason,
        )}`,
      );
    }
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
    `${verb} of ${result.appletId} failed: ${result.reason}`,
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

export async function execute(
  tool: string,
  input: unknown,
  ctx: BotPackageContextV1,
): Promise<string> {
  switch (tool) {
    case "applet_list": {
      const applets = (value(await ctx.applets.list()) as unknown[]).map(
        summary,
      );
      if (applets.length === 0) {
        return "This User has no Applets yet. applet_create scaffolds one from a working todo-list starting point.";
      }
      return [
        `${applets.length} Applet(s):`,
        ...applets.map((applet) => describe(applet)),
      ].join("\n");
    }

    case "applet_create": {
      const displayName = requireString(input, "displayName");
      const created = summary(value(await ctx.applets.create({ displayName })));
      const written = await writeScaffold(ctx, created.appletId, displayName);
      const directory = sourceDirectory(created.appletId);
      return [
        `Created "${created.displayName}" (${created.appletId}) and put it in the panel beside the conversation.`,
        `Its source is on the Computer at ${directory}: ${written
          .map((path) => path.slice(created.appletId.length + 1))
          .join(", ")}.`,
        "It is the SDK's todo-list starting point and it already builds.",
        "Next, on the Computer:",
        `1. Read the \`applets\` Skill if you have not already — it is the SDK reference.`,
        `2. Edit server.ts (tables and tools) and ui.tsx (the page) in ${directory}.`,
        `3. Run \`applet check\` in ${directory} and fix every error it prints.`,
        `4. Run \`applet build\` in ${directory}.`,
        `5. Call applet_publish with appletId ${created.appletId}.`,
      ].join("\n");
    }

    case "applet_publish": {
      const appletId = requireString(input, "appletId");
      const result = value(
        await ctx.applets.publish({ appletId }),
      ) as AppletPublishResultV1;
      return publishText(result, "Published");
    }

    case "applet_revert": {
      const appletId = requireString(input, "appletId");
      const generationId = requireString(input, "generationId");
      const result = value(
        await ctx.applets.revert({ appletId, generationId }),
      ) as AppletPublishResultV1;
      return publishText(result, "Reverted");
    }

    case "applet_delete": {
      const appletId = requireString(input, "appletId");
      value(await ctx.applets.delete({ appletId }));
      return `Deleted ${appletId}. Its data, its versions, and its tools are gone; this cannot be undone.`;
    }

    case "applet_focus": {
      const raw = (input as Record<string, unknown> | null | undefined)
        ?.appletId;
      if (raw !== null && typeof raw !== "string") {
        throw new Error("appletId must be an Applet id or null");
      }
      const focused = value(await ctx.applets.focus({ appletId: raw })) as {
        appletId: string | null;
      };
      return focused.appletId === null
        ? "Closed the Applet panel."
        : `Showing ${focused.appletId} in the panel beside the conversation.`;
    }

    case "applet_generations": {
      const appletId = requireString(input, "appletId");
      const generations = value(
        await ctx.applets.generations({ appletId }),
      ) as AppletGenerationSummaryV1[];
      return generationsText(appletId, generations);
    }

    default:
      throw new Error(`the Applets Package does not implement "${tool}"`);
  }
}
