// The Bot's own `bot_export_template`.
//
// GATE. Register line 446: `create_bot_share_json` is gated by `gates.botShare`
// — a turn-type gate. The manifest Capability declares `turnTypes: ["chat"]`,
// and the registration reads that ceiling back out of the manifest rather than
// restating it, so an automation or subagent Turn is never offered
// this tool. Packing a Bot into a shareable recipe is a thing a User is in the
// room for.
//
// AUTHORITY. The tool *stages*, and staging is always `visibility: "private"`.
// "Publication beyond the authoring User is a User action": choosing `link` or
// `public` is a click in Bot settings, and there is no tool argument, no
// second tool, and no host method here that could do it. What the tool returns
// is an `agent-card` naming what was packed and what was scrubbed — the one
// voice a Bot has to its User (`kernel-contracts/src/send-to-user.ts`).
//
// REPLAY. `idempotent: true`, and honestly so: the staging command id is
// derived from the durable tool-call occurrence, so a replay after eviction
// carries the same `commandId`, meets the receipt the User Durable Object
// already wrote, and reports the share it already made instead of staging a
// second one.
import {
  decodeTurnTypeV1,
  type Session,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type TurnTypeV1,
} from "@frockbot/kernel-contracts";
// Merges the Agent loop's event declarations into the cordis Context type.
import type {} from "@frockbot/kernel-agent-loop/agent";
import type { Plugin } from "cordis";
import manifest from "../frockbot.json" with { type: "json" };
import { describeTemplateSummaryV1 } from "./scrub.js";
import type { TemplateShareReceiptV1 } from "./shared.js";

export const BOT_EXPORT_TEMPLATE_TOOL_V1 = "bot_export_template";
export const BOT_TEMPLATE_EXPORT_CAPABILITY_V1 = "bot-template-export";

/** The User and Bot one admitted Turn's export runs as. */
export interface BotTemplateOwnerV1 {
  userId: string;
  botId: string;
}

/**
 * The host seam, supplied by the Bot Durable Object for one admitted Turn.
 *
 * Exactly one method, and it is the User's own `template/stage` command. There
 * is no `setVisibility` here and no `revoke`: a Bot cannot publish, so the seam
 * it holds cannot express publication.
 */
export interface BotTemplateRuntimeHostV1 {
  owner: BotTemplateOwnerV1;
  stageTemplate(input: {
    commandId: string;
    botId: string;
  }): Promise<TemplateShareReceiptV1>;
}

/** The manifest's own ceiling for a Capability, read back from the manifest. */
export function botTemplateAdmissionCeilingV1(
  capabilityId: string,
): readonly TurnTypeV1[] | undefined {
  const capabilities = (
    manifest as {
      configuration?: {
        capabilities?: Array<{
          id: string;
          admission?: { turnTypes: string[] };
        }>;
      };
    }
  ).configuration?.capabilities;
  const turnTypes = capabilities?.find(
    (candidate) => candidate.id === capabilityId,
  )?.admission?.turnTypes;
  if (!turnTypes) return undefined;
  return turnTypes.map((turnType) =>
    decodeTurnTypeV1(
      turnType,
      `bot-template capability "${capabilityId}" admission`,
    ),
  );
}

function refusal(reason: string): ToolExecutionResult {
  return { content: reason, isError: true };
}

/** The open step a send belongs to, mirroring the Shell's own rule. */
function openStepPositionV1(
  session: Session,
  tool: string,
): { turn: number; step: number } {
  const started = session.events.findLast(
    (event) => event.type === "step/start",
  );
  const ended = session.events.findLast((event) => event.type === "step/end");
  if (started?.type !== "step/start") {
    throw new Error(`${tool} has no open step to record against`);
  }
  if (
    ended?.type === "step/end" &&
    ended.turn === started.turn &&
    ended.step === started.step
  ) {
    throw new Error(`${tool} has no open step to record against`);
  }
  return { turn: started.turn, step: started.step };
}

/** A `commandId` derived from the occurrence, so a retry reuses one receipt. */
export function stageCommandIdV1(effectId: string): string {
  return `template-stage-${effectId.replace(/[^a-zA-Z0-9._-]/g, "-")}`.slice(
    0,
    120,
  );
}

const DESCRIPTION = [
  "Pack yourself into a shareable Bot template: a recipe, not a backup.",
  "It carries your name, description, your own Skills, your Routines' prompts,",
  "the Catalog Packages your User installed, and public MCP server addresses.",
  "It never carries Memory, credentials, Connections, Assignments, your model,",
  "webhook keys, uploaded images, or anything from your Computer.",
  "The template is staged privately and shared with nobody:",
  "only your User can choose to publish it, from Bot settings.",
].join(" ");

export function createBotExportTemplateTool(
  host: BotTemplateRuntimeHostV1,
  sessions: { get(sessionId: string): Session | undefined },
): ToolDefinition {
  return {
    name: BOT_EXPORT_TEMPLATE_TOOL_V1,
    description: DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    admission: { turnTypes: ["chat"] },
    // The staging command id is derived from the occurrence, so re-running
    // meets the durable receipt and reports the same share.
    idempotent: true,
    validate: (input: unknown) =>
      input === undefined ||
      (typeof input === "object" &&
        input !== null &&
        !Array.isArray(input) &&
        Object.keys(input).length === 0),
    execute: async (
      _input: unknown,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> => {
      let receipt: TemplateShareReceiptV1;
      try {
        receipt = await host.stageTemplate({
          commandId: stageCommandIdV1(context.effectId),
          botId: host.owner.botId,
        });
      } catch (error) {
        return refusal(
          `${BOT_EXPORT_TEMPLATE_TOOL_V1} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const body = receipt.summary
        ? describeTemplateSummaryV1(receipt.summary)
        : "The template was staged privately. Nothing is shared until your User chooses a visibility.";
      const session = sessions.get(context.sessionId);
      if (session) {
        try {
          session.append({
            type: "send/to-user",
            ...openStepPositionV1(session, BOT_EXPORT_TEMPLATE_TOOL_V1),
            occurrenceId: context.effectId,
            payload: {
              type: "agent-card",
              agentId: host.owner.botId,
              title: "Bot template staged",
              body,
            },
          });
          await session.flush();
        } catch {
          // The share is already durable. A card that could not be recorded is
          // a missing card, never a reason to look as if the export failed.
        }
      }
      return {
        content: `Staged a private Bot template (${receipt.share.shareId}). ${body}`,
        isError: false,
      };
    },
  };
}

/**
 * The runtime Contribution. One tool, bounded by the manifest's own ceiling,
 * and registered only when the host seam exists — a Turn with no User authority
 * to stage through is a Turn where the tool is simply absent.
 */
export function createBotTemplateRuntimePlugin(
  host: BotTemplateRuntimeHostV1,
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) => {
    const ceiling = botTemplateAdmissionCeilingV1(
      BOT_TEMPLATE_EXPORT_CAPABILITY_V1,
    );
    const dispose = ctx.tools.register(
      createBotExportTemplateTool(host, ctx.sessions),
      ceiling ? { admissionCeiling: ceiling } : undefined,
    );
    return () => dispose();
  };
  plugin.inject = ["tools", "sessions"];
  return plugin;
}

export default createBotTemplateRuntimePlugin;
