// The Package Authoring runtime Contribution: author, undo, and self-inspect.
//
// The Package holds no authority of its own. It decodes the model's input at
// the seam, appends the two session events that make the effect visible in the
// durable log, and hands the work to the authoring host the Durable Object
// gave it. It never reaches a Worker `env`, a bundler, object storage, or the
// Composition store directly.
import type {
  Session,
  ToolDefinition,
  ToolExecutionContext,
} from "@frockbot/kernel-contracts";
import { BOT_ISOLATE_CONTEXT_SUMMARY_V1 } from "@frockbot/kernel-contracts";
import type { Plugin } from "cordis";
import {
  AUTHOR_PACKAGE_INPUT_SCHEMA_V1,
  PACKAGE_UNDO_INPUT_SCHEMA_V1,
  type AuthorPackageInputV1,
  type AuthorPackageOutcomeV1,
  type PackageInspectSelfOutcomeV1,
  type PackageUndoInputV1,
  type PackageUndoOutcomeV1,
  decodeAuthorPackageInputV1,
  decodePackageUndoInputV1,
  sha256HexV1,
} from "./shared.js";

/** The turn and step an authoring event is recorded under. */
export interface AuthoringTurnPositionV1 {
  turn: number;
  step: number;
}

export interface AuthorPackageRequestV1 {
  input: AuthorPackageInputV1;
  sourceHash: string;
  effectId: string;
  sessionId: string;
  position: AuthoringTurnPositionV1;
}

export interface PackageUndoRequestV1 {
  input: PackageUndoInputV1;
  effectId: string;
  sessionId: string;
  position: AuthoringTurnPositionV1;
}

/**
 * The kernel-hosted seam this Package receives. Implemented by the Durable
 * Object host (`@frockbot/plugin-shell/backend-authoring`), which owns the
 * intent record, the `PACKAGE_BUNDLER` binding, the artifact store, the User
 * quota RPC, and the Composition store.
 */
export interface PackageAuthoringHost {
  /** The idempotency key for this call; deterministic in the admitted run. */
  effectIdFor(input: {
    packageId: string;
    sourceHash: string;
  }): Promise<string>;
  author(request: AuthorPackageRequestV1): Promise<AuthorPackageOutcomeV1>;
  undoEffectIdFor(input: PackageUndoInputV1): Promise<string>;
  undo(request: PackageUndoRequestV1): Promise<PackageUndoOutcomeV1>;
  inspectSelf(): Promise<PackageInspectSelfOutcomeV1>;
}

/**
 * The open step an authoring event belongs to. The session log is the
 * reconstruction surface, so an authoring event without its turn and step
 * would not replay in place.
 */
export function openTurnPositionV1(session: Session): AuthoringTurnPositionV1 {
  const started = session.events.findLast(
    (event) => event.type === "step/start",
  );
  const ended = session.events.findLast((event) => event.type === "step/end");
  if (started?.type !== "step/start") {
    throw new Error("package authoring has no open step to record against");
  }
  if (
    ended?.type === "step/end" &&
    ended.turn === started.turn &&
    ended.step === started.step
  ) {
    throw new Error("package authoring has no open step to record against");
  }
  return { turn: started.turn, step: started.step };
}

function refusalText(
  outcome: Extract<AuthorPackageOutcomeV1, { status: "refused" }>,
): string {
  return [
    `Authoring was refused: ${outcome.reason}`,
    `A durable failure record "${outcome.failureId}" was written; the User can inspect it. Nothing was activated.`,
  ].join(" ");
}

function authoredText(
  outcome: Extract<AuthorPackageOutcomeV1, { status: "authored" }>,
): string {
  return [
    `Authored Package "${outcome.packageId}" version ${outcome.version}.`,
    outcome.supersededVersion
      ? `It supersedes version ${outcome.supersededVersion}.`
      : undefined,
    `Its artifact is ${outcome.contentHash} and it is recorded as Composition generation ${outcome.generationId}.`,
    "That generation is pending: this Turn keeps running on the Composition it was admitted under, and the new Package activates on the next Turn.",
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
}

export function createPackageAuthorTool(
  host: PackageAuthoringHost,
  sessions: { get(sessionId: string): Session | undefined },
): ToolDefinition {
  return {
    name: "package_author",
    // A general work tool: the full toolset an `executor` subagent gets, and
    // not part of the narrow reach of `browserUse`, `computerUse`, or the two
    // video roles. See `@frockbot/plugin-subagents` `SUBAGENT_TOOL_REACH_V1`.
    admission: { subagentRoles: ["executor"] },
    description: `Author a Package for yourself: tools implemented in one TypeScript file that runs in your own isolate. Declare every exported tool in tools; the names must match exactly. The Package is recorded as a new Composition generation and activates on your next Turn. ${BOT_ISOLATE_CONTEXT_SUMMARY_V1}`,
    inputSchema: AUTHOR_PACKAGE_INPUT_SCHEMA_V1,
    idempotent: false,
    validate: (input: unknown) => {
      try {
        decodeAuthorPackageInputV1(input);
        return true;
      } catch {
        return false;
      }
    },
    execute: async (input: unknown, context: ToolExecutionContext) => {
      let decoded: AuthorPackageInputV1;
      try {
        decoded = decodeAuthorPackageInputV1(input);
      } catch (error) {
        return {
          content: `package_author input was rejected: ${
            error instanceof Error ? error.message : String(error)
          }`,
          isError: true,
        };
      }
      const session = sessions.get(context.sessionId);
      if (!session) {
        return {
          content: `package_author cannot record its intent: session "${context.sessionId}" is unavailable`,
          isError: true,
        };
      }
      const sourceHash = await sha256HexV1(decoded.source);
      const effectId = await host.effectIdFor({
        packageId: decoded.packageId,
        sourceHash,
      });
      const position = openTurnPositionV1(session);
      // Intent before effect: the session event and the durable intent record
      // are both written before the bundler is reached.
      session.append({
        type: "package/author-intent",
        ...position,
        effectId,
        packageId: decoded.packageId,
        sourceHash,
      });
      await session.flush();

      const outcome = await host.author({
        input: decoded,
        sourceHash,
        effectId,
        sessionId: context.sessionId,
        position,
      });
      if (outcome.status === "refused") {
        return { content: refusalText(outcome), isError: true };
      }
      session.append({
        type: "package/authored",
        ...position,
        effectId,
        packageId: outcome.packageId,
        version: outcome.version,
        contentHash: outcome.contentHash,
        generationId: outcome.generationId,
      });
      // The model must not be told it succeeded before the record is durable.
      await session.flush();
      return { content: authoredText(outcome), isError: false };
    },
  };
}

export function createPackageUndoTool(
  host: PackageAuthoringHost,
  sessions: { get(sessionId: string): Session | undefined },
): ToolDefinition {
  return {
    name: "package_undo",
    admission: { subagentRoles: ["executor"] },
    description:
      "Undo your latest Package setup change, or restore an earlier Composition generation. This only changes Package setup; it never undoes actions taken through Connections. The resulting generation activates on the next Turn.",
    inputSchema: PACKAGE_UNDO_INPUT_SCHEMA_V1,
    idempotent: false,
    validate: (input) => {
      try {
        decodePackageUndoInputV1(input);
        return true;
      } catch {
        return false;
      }
    },
    execute: async (input: unknown, context: ToolExecutionContext) => {
      let decoded: PackageUndoInputV1;
      try {
        decoded = decodePackageUndoInputV1(input);
      } catch (error) {
        return {
          content: `package_undo input was rejected: ${errorMessage(error)}`,
          isError: true,
        };
      }
      const session = sessions.get(context.sessionId);
      if (!session) {
        return {
          content: `package_undo cannot record its intent: session "${context.sessionId}" is unavailable`,
          isError: true,
        };
      }
      const effectId = await host.undoEffectIdFor(decoded);
      const position = openTurnPositionV1(session);
      session.append({
        type: "package/undo-intent",
        ...position,
        effectId,
        ...(decoded.generationId
          ? { requestedGenerationId: decoded.generationId }
          : {}),
      });
      await session.flush();
      const outcome = await host.undo({
        input: decoded,
        effectId,
        sessionId: context.sessionId,
        position,
      });
      if (outcome.status === "refused") {
        return {
          content: `Package undo was refused: ${outcome.reason} A durable failure record "${outcome.failureId}" was written. No connection action was undone.`,
          isError: true,
        };
      }
      session.append({
        type: "package/undo-recorded",
        ...position,
        effectId,
        generationId: outcome.generationId,
        targetGenerationId: outcome.targetGenerationId,
      });
      await session.flush();
      return {
        content: `Package setup will return to Composition generation "${outcome.targetGenerationId}" through new pending generation "${outcome.generationId}". It activates on the next Turn. This changed Package setup only; it did not undo any action taken through a Connection.`,
        isError: false,
      };
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPackageInspectSelfTool(
  host: PackageAuthoringHost,
): ToolDefinition {
  return {
    name: "package_inspect_self",
    admission: { subagentRoles: ["executor"] },
    description:
      "Read your exact Package execution context contract, current Composition (including your stored Package source), and latest authoring or activation failure per authored Package.",
    inputSchema: { type: "object", additionalProperties: false },
    idempotent: true,
    validate: (input) =>
      Boolean(input && typeof input === "object" && !Array.isArray(input)) &&
      Object.keys(input as Record<string, unknown>).length === 0,
    execute: async () => ({
      content: JSON.stringify(await host.inspectSelf(), null, 2),
      isError: false,
    }),
  };
}

/** The runtime Contribution. Registers the three chat-first setup tools. */
export function createAuthoringRuntimePlugin(
  host: PackageAuthoringHost,
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) => {
    const disposers = [
      ctx.tools.register(createPackageAuthorTool(host, ctx.sessions)),
      ctx.tools.register(createPackageUndoTool(host, ctx.sessions)),
      ctx.tools.register(createPackageInspectSelfTool(host)),
    ];
    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  };
  plugin.inject = ["tools", "sessions"];
  return plugin;
}
