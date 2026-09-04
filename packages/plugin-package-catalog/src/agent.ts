// Chat-facing Catalog tools. The Package owns no authority: the Bot Durable
// Object host performs every read and mutation after this seam decodes input.
import type {
  Session,
  ToolDefinition,
  ToolExecutionContext,
} from "@frockbot/kernel-contracts";
import type { Plugin } from "cordis";
import {
  PACKAGE_INSPECT_INPUT_SCHEMA_V1,
  PACKAGE_INSTALL_INPUT_SCHEMA_V1,
  PACKAGE_REMOVE_INPUT_SCHEMA_V1,
  PACKAGE_SEARCH_INPUT_SCHEMA_V1,
  PACKAGE_UPDATE_INPUT_SCHEMA_V1,
  type PackageCatalogChangeActionV1,
  type PackageCatalogChangeOutcomeV1,
  type PackageCatalogInspectOutcomeV1,
  type PackageCatalogSearchOutcomeV1,
  type PackageInspectInputV1,
  type PackageInstallInputV1,
  type PackageRemoveInputV1,
  type PackageSearchInputV1,
  decodePackageInspectInputV1,
  decodePackageInstallInputV1,
  decodePackageRemoveInputV1,
  decodePackageSearchInputV1,
  decodePackageUpdateInputV1,
} from "./shared.js";

export interface PackageCatalogTurnPositionV1 {
  turn: number;
  step: number;
}

export type PackageCatalogChangeInputV1 =
  | { action: "install" | "update"; input: PackageInstallInputV1 }
  | { action: "remove"; input: PackageRemoveInputV1 };

export interface PackageCatalogChangeRequestV1 {
  effectId: string;
  sessionId: string;
  position: PackageCatalogTurnPositionV1;
  change: PackageCatalogChangeInputV1;
}

export interface PackageCatalogHost {
  effectIdFor(change: PackageCatalogChangeInputV1): Promise<string>;
  search(input: PackageSearchInputV1): Promise<PackageCatalogSearchOutcomeV1>;
  inspect(
    input: PackageInspectInputV1,
  ): Promise<PackageCatalogInspectOutcomeV1>;
  change(
    request: PackageCatalogChangeRequestV1,
  ): Promise<PackageCatalogChangeOutcomeV1>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function openTurnPosition(session: Session): PackageCatalogTurnPositionV1 {
  const started = session.events.findLast(
    (event) => event.type === "step/start",
  );
  const ended = session.events.findLast((event) => event.type === "step/end");
  if (
    started?.type !== "step/start" ||
    (ended?.type === "step/end" &&
      ended.turn === started.turn &&
      ended.step === started.step)
  ) {
    throw new Error(
      "Package Catalog change has no open step to record against",
    );
  }
  return { turn: started.turn, step: started.step };
}

function readTool<T>(input: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  decode(value: unknown): T;
  read(value: T): Promise<unknown>;
}): ToolDefinition {
  return {
    name: input.name,
    admission: { subagentRoles: ["executor"] },
    description: input.description,
    inputSchema: input.inputSchema,
    idempotent: true,
    validate: (value) => {
      try {
        input.decode(value);
        return true;
      } catch {
        return false;
      }
    },
    execute: async (value) => {
      try {
        return {
          content: JSON.stringify(
            await input.read(input.decode(value)),
            null,
            2,
          ),
          isError: false,
        };
      } catch (error) {
        return {
          content: `${input.name} failed: ${errorMessage(error)}`,
          isError: true,
        };
      }
    },
  };
}

/**
 * Close an open `package/catalog-change-intent` with the failure that ended
 * it. A failure to record the failure must not hide the original one, so this
 * never throws.
 */
async function appendEffectFailure(
  session: Session,
  position: PackageCatalogTurnPositionV1,
  effectId: string,
  reason: string,
): Promise<void> {
  try {
    session.append({
      type: "package/effect-failed",
      ...position,
      effectId,
      effect: "catalog-change",
      reason,
    });
    await session.flush();
  } catch {
    // Deliberately swallowed.
  }
}

function outcomeText(outcome: PackageCatalogChangeOutcomeV1): string {
  if (outcome.status === "refused") {
    return `Package ${outcome.action} was refused: ${outcome.reason} Nothing was activated.`;
  }
  const verb =
    outcome.action === "install"
      ? "Installed"
      : outcome.action === "update"
        ? "Updated"
        : "Removed";
  return [
    `${verb} Package "${outcome.displayName}"${outcome.version ? ` version ${outcome.version}` : ""}.`,
    `The change is pending Composition generation ${outcome.generationId} and activates on the next Turn.`,
    outcome.missingConnectionTypes.length > 0
      ? `It is inert until the User connects its missing Connection Type${outcome.missingConnectionTypes.length === 1 ? "" : "s"}: ${outcome.missingConnectionTypes.join(", ")}. Do not ask or prompt the User to connect it.`
      : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
}

function createChangeTool(input: {
  host: PackageCatalogHost;
  sessions: { get(sessionId: string): Session | undefined };
  action: PackageCatalogChangeActionV1;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  decode(value: unknown): PackageInstallInputV1 | PackageRemoveInputV1;
}): ToolDefinition {
  return {
    name: input.name,
    admission: { subagentRoles: ["executor"] },
    description: input.description,
    inputSchema: input.inputSchema,
    idempotent: false,
    validate: (value) => {
      try {
        input.decode(value);
        return true;
      } catch {
        return false;
      }
    },
    execute: async (value: unknown, context: ToolExecutionContext) => {
      let decoded: PackageInstallInputV1 | PackageRemoveInputV1;
      try {
        decoded = input.decode(value);
      } catch (error) {
        return {
          content: `${input.name} input was rejected: ${errorMessage(error)}`,
          isError: true,
        };
      }
      const session = input.sessions.get(context.sessionId);
      if (!session) {
        return {
          content: `${input.name} cannot record its intent: session "${context.sessionId}" is unavailable`,
          isError: true,
        };
      }
      const change: PackageCatalogChangeInputV1 =
        input.action === "remove"
          ? { action: "remove", input: decoded as PackageRemoveInputV1 }
          : {
              action: input.action,
              input: decoded as PackageInstallInputV1,
            };
      const effectId = await input.host.effectIdFor(change);
      const position = openTurnPosition(session);
      session.append({
        type: "package/catalog-change-intent",
        ...position,
        effectId,
        action: change.action,
        ...(change.action === "remove"
          ? { packageId: change.input.packageId }
          : {
              catalogId: change.input.catalogId,
              ...(change.input.contentHash === undefined
                ? {}
                : { contentHash: change.input.contentHash }),
            }),
      });
      await session.flush();
      // Every `package/catalog-change-intent` closes with an outcome or with
      // the failure that ended it — a refusal and an unmodelled throw alike
      // used to leave the intent unpaired in the session log (finding F12).
      let outcome: PackageCatalogChangeOutcomeV1;
      try {
        outcome = await input.host.change({
          effectId,
          sessionId: context.sessionId,
          position,
          change,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await appendEffectFailure(session, position, effectId, reason);
        return {
          content: `${input.name} failed: ${reason} Nothing was installed or removed.`,
          isError: true,
        };
      }
      if (outcome.status === "refused") {
        await appendEffectFailure(session, position, effectId, outcome.reason);
        return { content: outcomeText(outcome), isError: true };
      }
      session.append({
        type: "package/catalog-changed",
        ...position,
        effectId,
        action: outcome.action,
        packageId: outcome.packageId,
        generationId: outcome.generationId,
        ...(outcome.contentHash ? { contentHash: outcome.contentHash } : {}),
      });
      await session.flush();
      return { content: outcomeText(outcome), isError: false };
    },
  };
}

export function createPackageInstallTool(
  host: PackageCatalogHost,
  sessions: { get(sessionId: string): Session | undefined },
): ToolDefinition {
  return createChangeTool({
    host,
    sessions,
    action: "install",
    name: "package_install",
    description:
      "Install the inspected Catalog entry by catalogId. Pass contentHash only when the entry reported one; a first-party entry publishes no bundle and must be installed by catalogId alone. Supply a short summary for the setup audit when useful. It activates on the next Turn; never ask the User to make a Connection.",
    inputSchema: PACKAGE_INSTALL_INPUT_SCHEMA_V1,
    decode: decodePackageInstallInputV1,
  });
}

/** Registers the five Catalog tools; all authority remains in `host`. */
export function createPackageCatalogRuntimePlugin(
  host: PackageCatalogHost,
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) => {
    const disposers = [
      ctx.tools.register(
        readTool({
          name: "package_search",
          description:
            "Search the Package Catalog generation pinned for this User by name, description, or tag.",
          inputSchema: PACKAGE_SEARCH_INPUT_SCHEMA_V1,
          decode: decodePackageSearchInputV1,
          read: (value) => host.search(value),
        }),
      ),
      ctx.tools.register(
        readTool({
          name: "package_inspect",
          description:
            "Inspect one pinned Catalog entry, including its exact manifest, declared tools, setup fields, Connection readiness, and retained source when published.",
          inputSchema: PACKAGE_INSPECT_INPUT_SCHEMA_V1,
          decode: decodePackageInspectInputV1,
          read: (value) => host.inspect(value),
        }),
      ),
      ctx.tools.register(createPackageInstallTool(host, ctx.sessions)),
      ctx.tools.register(
        createChangeTool({
          host,
          sessions: ctx.sessions,
          action: "update",
          name: "package_update",
          description:
            "Update an installed Catalog Package to the inspected entry. Pass contentHash only when the entry reported one. Supply a short summary for the setup audit when useful. It activates on the next Turn.",
          inputSchema: PACKAGE_UPDATE_INPUT_SCHEMA_V1,
          decode: decodePackageUpdateInputV1,
        }),
      ),
      ctx.tools.register(
        createChangeTool({
          host,
          sessions: ctx.sessions,
          action: "remove",
          name: "package_remove",
          description:
            "Remove a Catalog Package from your next Composition generation. Supply a short summary for the setup audit when useful. Required core Packages cannot be removed.",
          inputSchema: PACKAGE_REMOVE_INPUT_SCHEMA_V1,
          decode: decodePackageRemoveInputV1,
        }),
      ),
    ];
    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  };
  plugin.inject = ["tools", "sessions"];
  return plugin;
}
