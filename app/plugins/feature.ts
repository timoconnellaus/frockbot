// The Plugins feature: the `plugin_*` Tool Namespace a Bot writes a Plugin
// with (ADR 0026).
//
// Everything here is text a model reads, so each verb answers with what
// happened and the single next thing to do. The two verbs that would widen
// what the Bot may do — `plugin_publish` and `plugin_enable` — end in an
// approval card on the Turn's own durable log and never in a running Plugin:
// the intent record is written first, the card second, and what the User
// approves is applied when the decision commits.
import type {
  FirstPartyCardDrawsV1,
  RuntimeFeatureV1,
  Session,
  ToolDefinition,
  ToolExecutionContext,
  ToolRegistration,
} from "@frockbot/core/contracts";
import { latestOpenStepPositionV1 } from "@frockbot/core/contracts";
import { drawFirstPartyCardV1 } from "@frockbot/app/shell/first-party-cards";
import type {
  PluginApprovalAskV1,
  PluginAuthoringHostV1,
  PluginCheckResultV1,
} from "./authoring.js";
import { requirePluginSourcePathV1 } from "./authoring.js";

/** What the Bot Durable Object hands this feature for one admitted Turn. */
export interface PluginAuthoringRuntimeHostV1 {
  readonly plugins: PluginAuthoringHostV1;
  readonly turn: { sessionId: string; runId: string; turnId: string };
}

function requireString(input: unknown, field: string): string {
  const value = (input as Record<string, unknown> | null | undefined)?.[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} is required`);
  }
  return value;
}

function requireObject(input: unknown, field: string): Record<string, unknown> {
  const value = (input as Record<string, unknown> | null | undefined)?.[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function checkText(pluginId: string, result: PluginCheckResultV1): string {
  if (result.status === "failed") {
    return [
      `${pluginId} does not build yet: ${result.reason}`,
      ...result.diagnostics,
      "Fix every line above with plugin_write_file, then run plugin_check again. Do not publish over a failing check.",
    ].join("\n");
  }
  if (result.findings.length > 0) {
    return [
      `${pluginId} builds, but the check found what the User will be warned about:`,
      ...result.findings.map((finding) => `- ${finding}`),
      "Fix these with plugin_write_file and check again, or publish and tell the User why they stand.",
    ].join("\n");
  }
  return `${pluginId} builds. Call plugin_publish when it is what you want; the User will be asked to approve it.`;
}

/** What the person said in the Turn this call runs in, oldest first. */
function turnRequestV1(
  sessions: { get(sessionId: string): Session | undefined },
  context: ToolExecutionContext,
): string {
  const session = sessions.get(context.sessionId);
  const position = session ? latestOpenStepPositionV1(session) : undefined;
  if (!session || !position) return "";
  return session.activeRunJournal
    .flatMap((event) =>
      event.type === "user/message" && event.turn === position.turn
        ? [event.text]
        : [],
    )
    .join("\n\n");
}

/**
 * The open step a send belongs to. The session log is the reconstruction
 * surface, so a card without its turn and step would not replay in place.
 */
function openStepPosition(
  session: Session,
  tool: string,
): { turn: number; step: number } {
  const position = latestOpenStepPositionV1(session);
  if (!position) {
    throw new Error(`${tool} has no open step to record against`);
  }
  return position;
}

/**
 * Put the card on the Turn's log. A replayed call — the same effect asked
 * again after an interruption — records nothing twice: the intent is already
 * durable and the card is already on the log under the same occurrence.
 */
async function sendApprovalCard(
  sessions: { get(sessionId: string): Session | undefined },
  context: ToolExecutionContext,
  tool: string,
  ask: PluginApprovalAskV1,
  cards?: FirstPartyCardDrawsV1,
): Promise<void> {
  if (ask.replayed) return;
  const session = sessions.get(context.sessionId);
  if (!session) {
    throw new Error(
      `session "${context.sessionId}" is unavailable, so the approval cannot be recorded.`,
    );
  }
  const position = openStepPosition(session, tool);
  const payload = {
    type: "approval" as const,
    approvalId: ask.approvalId,
    action: ask.action,
    ...(ask.rationale === undefined ? {} : { rationale: ask.rationale }),
    risk: ask.risk,
  };
  session.append({
    type: "send/to-user",
    ...position,
    occurrenceId: context.effectId,
    payload,
  });
  await session.flush();
  // The card is the face of the decision the line above recorded (ADR 0030
  // step 7); the decision itself is still this record, under this id.
  await drawFirstPartyCardV1(cards, payload, context);
}

function tool(
  definition: Omit<ToolDefinition, "execute"> & {
    answer(input: unknown, context: ToolExecutionContext): Promise<string>;
  },
): ToolDefinition {
  const { answer, ...schema } = definition;
  return {
    ...schema,
    async execute(input, context) {
      try {
        return { content: await answer(input, context), isError: false };
      } catch (error) {
        return {
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    },
  };
}

const PLUGIN_ID_PROPERTY = {
  pluginId: { type: "string", description: "The Plugin's id." },
} as const;

export function pluginTools(
  host: PluginAuthoringRuntimeHostV1,
  sessions: { get(sessionId: string): Session | undefined },
  cards: () => FirstPartyCardDrawsV1 | undefined = () => undefined,
): ToolDefinition[] {
  return [
    tool({
      name: "plugin_list",
      description:
        "List the Plugins in this account's Composition: the ones this User's Bots wrote and the ones the deployment ships, with whether each runs on this Bot. Call this before creating one, so you extend a Plugin that exists instead of writing a second.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      idempotent: true,
      async answer() {
        const rows = await host.plugins.list();
        if (rows.length === 0) {
          return "This account has no Plugins yet. plugin_create scaffolds one that already builds.";
        }
        return [
          `${rows.length} Plugin(s):`,
          ...rows.map(
            (row) =>
              `${row.displayName} (${row.pluginId}) — version ${row.version}, ${
                row.authored ? "written by a Bot of this User" : "shipped"
              }, ${row.locked ? "always on" : row.on ? "on for this Bot" : "off for this Bot"}`,
          ),
        ].join("\n");
      },
    }),
    tool({
      name: "plugin_create",
      description:
        "Create a new Plugin and scaffold its source: plugin.ts and plugin.json, a working starting point with two tools over the storage grant. Nothing is built or published. Edit with plugin_write_file, run plugin_check, then plugin_publish. Load the `plugins` Skill before you start editing.",
      inputSchema: {
        type: "object",
        properties: {
          displayName: {
            type: "string",
            description:
              "What the User will call this Plugin, in their words. 1-128 characters; the id is derived from it.",
            minLength: 1,
            maxLength: 128,
          },
        },
        required: ["displayName"],
        additionalProperties: false,
      },
      idempotent: false,
      async answer(input) {
        const created = await host.plugins.create({
          displayName: requireString(input, "displayName"),
        });
        return [
          `Created "${created.pluginId}" with ${created.files.join(" and ")} — a starting point that already builds.`,
          "The loop from here is plugin_write_file, plugin_check, plugin_publish:",
          "1. Read the `plugins` Skill if you have not already — it is the SDK reference.",
          "2. plugin_read_file and plugin_write_file on plugin.ts (the module) and plugin.json (the descriptor). Keep them in step.",
          `3. plugin_check with pluginId ${created.pluginId}, and fix every diagnostic it returns.`,
          `4. plugin_publish with pluginId ${created.pluginId}. The User approves it in the conversation; it runs from the Turn after they do.`,
        ].join("\n");
      },
    }),
    tool({
      name: "plugin_files",
      description:
        "List one Plugin's source files and their sizes. This is the real source: what plugin_check builds and what plugin_publish publishes.",
      inputSchema: {
        type: "object",
        properties: { ...PLUGIN_ID_PROPERTY },
        required: ["pluginId"],
        additionalProperties: false,
      },
      idempotent: true,
      async answer(input) {
        const pluginId = requireString(input, "pluginId");
        const files = await host.plugins.files({ pluginId });
        if (files.length === 0) {
          return `${pluginId} has no source yet. plugin_create scaffolds a working starting point.`;
        }
        return [
          `${pluginId} has ${files.length} source file(s):`,
          ...files.map((file) => `${file.path} — ${file.size} bytes`),
        ].join("\n");
      },
    }),
    tool({
      name: "plugin_read_file",
      description:
        "Read one of a Plugin's source files. Read before you write: plugin_write_file replaces the whole file.",
      inputSchema: {
        type: "object",
        properties: {
          ...PLUGIN_ID_PROPERTY,
          path: {
            type: "string",
            description: "plugin.ts, plugin.json, or a page plugin.json names.",
          },
        },
        required: ["pluginId", "path"],
        additionalProperties: false,
      },
      idempotent: true,
      async answer(input) {
        return await host.plugins.readFile({
          pluginId: requireString(input, "pluginId"),
          path: requirePluginSourcePathV1(requireString(input, "path")),
        });
      },
    }),
    tool({
      name: "plugin_write_file",
      description:
        "Write one of a Plugin's source files, replacing it entirely. Nothing is built or published by this: call plugin_check when the edit is complete.",
      inputSchema: {
        type: "object",
        properties: {
          ...PLUGIN_ID_PROPERTY,
          path: {
            type: "string",
            description:
              "plugin.ts, plugin.json, or a page plugin.json names (tuner.html). Relative, no leading slash and no `..`.",
          },
          text: {
            type: "string",
            description: "The file's whole new contents.",
          },
        },
        required: ["pluginId", "path", "text"],
        additionalProperties: false,
      },
      idempotent: false,
      async answer(input) {
        const pluginId = requireString(input, "pluginId");
        const path = requirePluginSourcePathV1(requireString(input, "path"));
        const text = (input as Record<string, unknown>).text;
        if (typeof text !== "string") throw new Error("text is required");
        await host.plugins.writeFile({ pluginId, path, text });
        return `Wrote ${path} in ${pluginId} (${text.length} characters). Run plugin_check when the edit is complete.`;
      },
    }),
    tool({
      name: "plugin_check",
      description:
        "Type-check a Plugin's source against the SDK without publishing it. Returns every diagnostic as `file:line:col message`, or says it builds. Do this before every publish.",
      inputSchema: {
        type: "object",
        properties: { ...PLUGIN_ID_PROPERTY },
        required: ["pluginId"],
        additionalProperties: false,
      },
      idempotent: true,
      async answer(input, context) {
        const pluginId = requireString(input, "pluginId");
        return checkText(
          pluginId,
          await host.plugins.check({ pluginId }, context.effectId),
        );
      },
    }),
    tool({
      name: "plugin_publish",
      description:
        "Build a Plugin's current source, store it, and ask the User to approve running it on this Bot with a card in the conversation. Nothing runs until they approve; their answer opens a Turn of yours that carries the decision, and an approved Plugin is already live in it. Run plugin_check first; a publish that does not build is refused with the same diagnostics.",
      inputSchema: {
        type: "object",
        properties: {
          ...PLUGIN_ID_PROPERTY,
          purpose: {
            type: "string",
            description:
              "What the person asked this Plugin to do, in a sentence or two. The User is shown a check of the Plugin against it.",
          },
        },
        required: ["pluginId", "purpose"],
        additionalProperties: false,
      },
      idempotent: false,
      // It appends the approval card to the conversation.
      orderedEffect: true,
      async answer(input, context) {
        const pluginId = requireString(input, "pluginId");
        const purpose = requireString(input, "purpose");
        const result = await host.plugins.publish(
          {
            pluginId,
            purpose,
            request: turnRequestV1(sessions, context),
          },
          context.effectId,
        );
        if (result.status === "failed") {
          return [
            `Publishing ${pluginId} failed: ${result.reason}`,
            ...result.diagnostics,
            "Nothing changed: no card was sent and the Plugin is not in the Composition.",
          ].join("\n");
        }
        await sendApprovalCard(
          sessions,
          context,
          "plugin_publish",
          result.ask,
          cards(),
        );
        return [
          `Built ${pluginId} and asked the User to approve it (approval ${result.ask.approvalId}).`,
          ...(result.ask.check === undefined
            ? []
            : [
                `The card warns them:\n${result.ask.check}\nSay plainly what you will do about each point.`,
              ]),
          "Tell the User in your own words what it does and why you built it, then end your Turn.",
          "Their answer opens a Turn of yours that carries the decision; approved, the Plugin is already running on this Bot in that Turn, so tell them it is ready.",
        ].join(" ");
      },
    }),
    tool({
      name: "plugin_enable",
      description:
        "Ask the User to turn a Plugin that is already in the account's Composition on for this Bot, with a card in the conversation. Turning a Plugin on widens what you can do, so it is the User's decision; their answer opens a Turn of yours that carries it.",
      inputSchema: {
        type: "object",
        properties: { ...PLUGIN_ID_PROPERTY },
        required: ["pluginId"],
        additionalProperties: false,
      },
      idempotent: false,
      // It appends the approval card to the conversation.
      orderedEffect: true,
      async answer(input, context) {
        const pluginId = requireString(input, "pluginId");
        const result = await host.plugins.enable(
          { pluginId },
          context.effectId,
        );
        if (result.status === "refused") {
          return `Refused: plugin_enable — ${result.reason}`;
        }
        if (result.status === "already-on") {
          return `${pluginId} is already on for this Bot.`;
        }
        await sendApprovalCard(
          sessions,
          context,
          "plugin_enable",
          result.ask,
          cards(),
        );
        return `Asked the User to turn ${pluginId} on for this Bot (approval ${result.ask.approvalId}). Say why you want it, then end your Turn; their answer opens a Turn of yours that carries the decision.`;
      },
    }),
    tool({
      name: "plugin_disable",
      description:
        "Turn a Plugin off for this Bot, at once. Narrowing what you can do is yours to decide; no approval is asked. Other Bots of this User are not affected.",
      inputSchema: {
        type: "object",
        properties: { ...PLUGIN_ID_PROPERTY },
        required: ["pluginId"],
        additionalProperties: false,
      },
      idempotent: true,
      async answer(input) {
        const pluginId = requireString(input, "pluginId");
        const result = await host.plugins.disable({ pluginId });
        return result.status === "off"
          ? `${pluginId} is off for this Bot from your next Turn.`
          : `Refused: plugin_disable — ${result.reason}`;
      },
    }),
    tool({
      name: "plugin_page_reports",
      description:
        "Read what a Plugin's pages reported from the person's devices, newest first: every error a page threw or left unhandled, every console.error, and whatever it passed to frockbot.log(text). A page runs on their device, not here, so this is the only way to see it fail. Read it after the person has used a page, and before you change one they say misbehaves.",
      inputSchema: {
        type: "object",
        properties: { ...PLUGIN_ID_PROPERTY },
        required: ["pluginId"],
        additionalProperties: false,
      },
      idempotent: true,
      async answer(input) {
        const pluginId = requireString(input, "pluginId");
        return host.plugins.pageReports({ pluginId });
      },
    }),
    tool({
      name: "plugin_settings",
      description:
        "Read a Plugin's settings for this Bot — the values its plugin.json settingsSchema declares — or write them. Pass `values` to write; omit it to read. Never a secret.",
      inputSchema: {
        type: "object",
        properties: {
          ...PLUGIN_ID_PROPERTY,
          values: {
            type: "object",
            description:
              "The whole settings object to store for this Bot. Omit to read.",
          },
        },
        required: ["pluginId"],
        additionalProperties: false,
      },
      idempotent: false,
      async answer(input) {
        const pluginId = requireString(input, "pluginId");
        const raw = (input as Record<string, unknown>).values;
        if (raw === undefined) {
          const read = await host.plugins.readSettings({ pluginId });
          return [
            `${pluginId} settings for this Bot: ${JSON.stringify(read.values)}`,
            read.schema
              ? `Its schema: ${JSON.stringify(read.schema)}`
              : "It declares no settingsSchema, so there is nothing to set.",
          ].join("\n");
        }
        const result = await host.plugins.writeSettings({
          pluginId,
          values: requireObject(input, "values"),
        });
        return result.status === "written"
          ? `Wrote ${pluginId}'s settings for this Bot. The Plugin reads them on its next call.`
          : `Refused: plugin_settings — ${result.reason}`;
      },
    }),
  ];
}

/** The runtime Contribution: the ten `plugin_*` tools, for one Turn. */
export function createPluginsFeature(
  host: PluginAuthoringRuntimeHostV1,
): RuntimeFeatureV1<{
  tools: ToolRegistration;
  sessions: { get(sessionId: string): Session | undefined };
  firstPartyCards?: FirstPartyCardDrawsV1;
}> {
  return (runtime) => {
    const disposers = pluginTools(
      host,
      runtime.sessions,
      // Read at call time, not now: the Plugin host sets it when it mounts.
      () => runtime.firstPartyCards,
    ).map((definition) =>
      runtime.tools.register({ ...definition, namespace: "frockbot" }),
    );
    return () => {
      for (const dispose of disposers.toReversed()) dispose();
    };
  };
}
