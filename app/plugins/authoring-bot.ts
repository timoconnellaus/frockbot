// The Bot Durable Object's side of Plugin authoring (ADR 0026): the gate,
// the seams the authoring host runs over, and what an approved intent does.
//
// `applyApprovedPluginIntentV1` is the one place a Plugin reaches the User's
// Composition and this Bot's enable map. It runs *after* the transaction that
// recorded the decision, because a proposal is a cross-object call, and it is
// idempotent on what the Composition already holds: a crash between the
// commit and this call is a retry, never a second generation.
import type { BotIdentity } from "@frockbot/core/durable";
import {
  CompositionPinConflictError,
  compositionArtifactSetHashV1,
  compositionGenerationIdV1,
  decodeCompositionGenerationV1,
  type CompositionGenerationV1,
  type CompositionMemberV1,
} from "@frockbot/core/durable";
import { decodeUserFeaturesV1 } from "@frockbot/app/admin/shared";
import { appletBuildService } from "@frockbot/app/applets-host/bot";
import { appletRpcSnapshotV1 as rpcJsonSnapshotV1 } from "@frockbot/app/applets-host/records";
import {
  currentUserCompositionV1,
  proposeUserCompositionV1,
} from "@frockbot/app/composition/bot";
import { pluginSettingsKeyV1 } from "@frockbot/app/isolates/bot";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import {
  recordPluginIntentOutcomeV1,
  type PluginIntentRecordV1,
} from "./approval.js";
import {
  createPluginAuthoringHostV1,
  type PluginAuthoringTurnV1,
  switchPluginForBotV1,
} from "./authoring.js";
import { DEPLOYMENT_PLUGIN_CATALOG_V1 } from "./catalog.js";
import type { PluginAuthoringRuntimeHostV1 } from "./feature.js";

/** How many times a proposal re-reads and retries after losing the pin race. */
const PROPOSE_ATTEMPTS = 3;

/**
 * The master toggle: an admin-held Account feature that gates Bot authoring
 * only (ADR 0026). A switch that cannot be read is off.
 */
export async function pluginAuthoringEnabled(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<boolean> {
  const id = state.env.USER_CONFIGURATIONS.idFromName(identity.userId);
  // SAFETY: this namespace is bound to UserConfiguration; generated Worker
  // types do not expose its account features RPC surface.
  const rpc = state.env.USER_CONFIGURATIONS.get(id) as unknown as {
    readFeatures(input: unknown): Promise<unknown>;
  };
  return decodeUserFeaturesV1(
    rpcJsonSnapshotV1(
      await rpc.readFeatures({ schemaVersion: 1, userId: identity.userId }),
    ),
  ).pluginAuthoring;
}

/**
 * The Plugins feature's seam for one admitted Turn, or `undefined` when this
 * host cannot author Plugins — no artifact bucket or no Workspace — or when
 * the account's switch is off. Off, and the tools are not mounted at all: a
 * gate that let them exist and refuse would still have told the model they
 * were there.
 */
export async function pluginAuthoringRuntimeHost(
  state: ShellBotStateV1,
  identity: BotIdentity,
  turn: PluginAuthoringTurnV1,
): Promise<PluginAuthoringRuntimeHostV1 | undefined> {
  const artifacts = state.env.APPLICATION_ARTIFACTS;
  const workspace = state.env.WORKSPACE_FILES;
  if (!artifacts || !workspace) return undefined;
  let enabled: boolean;
  try {
    enabled = await pluginAuthoringEnabled(state, identity);
  } catch {
    enabled = false;
  }
  if (!enabled) return undefined;
  const bucket = artifacts;
  const buildService = appletBuildService(state);
  const plugins = createPluginAuthoringHostV1({
    userId: identity.userId,
    botId: identity.botId,
    turn,
    workspace,
    ...(buildService ? { buildService } : {}),
    artifacts: {
      putPackageArtifact: async (contentHash, module) => {
        await bucket.put(`packages/${contentHash}.mjs`, module, {
          httpMetadata: { contentType: "application/javascript" },
        });
      },
    },
    composition: {
      current: () => currentUserCompositionV1(state, identity),
    },
    storage: {
      get: <T>(key: string) => state.ctx.storage.get<T>(key),
      put: (key: string, value: unknown) => state.ctx.storage.put(key, value),
    },
    settings: {
      async read(pluginId) {
        const stored = await state.ctx.storage.get<unknown>(
          pluginSettingsKeyV1(pluginId),
        );
        return stored && typeof stored === "object" && !Array.isArray(stored)
          ? (stored as Record<string, unknown>)
          : {};
      },
      write: (pluginId, values) =>
        state.ctx.storage.put(pluginSettingsKeyV1(pluginId), values),
    },
    catalog: DEPLOYMENT_PLUGIN_CATALOG_V1,
  });
  return { plugins, turn };
}

/** The member set with one Plugin's new version in place, or appended. */
export function membersWithPluginV1(
  members: readonly CompositionMemberV1[],
  member: CompositionMemberV1,
): CompositionMemberV1[] {
  const index = members.findIndex(
    (candidate) => candidate.packageId === member.packageId,
  );
  if (index === -1) return [...members, member];
  return members.map((candidate, at) => (at === index ? member : candidate));
}

/**
 * The generation a published Plugin joins: the current one, with this Plugin
 * replaced or appended, keyed to the current generation so a lost race is a
 * conflict and never an overwrite.
 */
export async function generationWithPluginV1(
  current: CompositionGenerationV1,
  member: CompositionMemberV1,
  intent: Pick<PluginIntentRecordV1, "runId" | "sessionId" | "turnId">,
  now: Date,
): Promise<CompositionGenerationV1> {
  const members = membersWithPluginV1(current.members, member);
  const createdAt = now.toISOString();
  const artifactSetHash = await compositionArtifactSetHashV1(
    members,
    current.applets ?? [],
  );
  return decodeCompositionGenerationV1({
    schemaVersion: 1,
    generationId: compositionGenerationIdV1(createdAt, artifactSetHash),
    artifactSetHash,
    parentGenerationId: current.generationId,
    summary: `${member.descriptor.displayName} ${member.version} published by a Bot`,
    createdAt,
    origin: {
      kind: "bot-authored",
      runId: intent.runId,
      sessionId: intent.sessionId,
      turnId: intent.turnId,
    },
    members,
    ...(current.applets && current.applets.length > 0
      ? { applets: current.applets }
      : {}),
    status: "pending",
  });
}

/**
 * What an approved intent does, after its decision committed.
 *
 * A `publish` proposes the generation on the User — skipped when the current
 * generation already holds this exact artifact, which is what makes a retry
 * safe — and then switches the Plugin on for this Bot. An `enable` only
 * switches. Either way the outcome is recorded on the intent, so a person
 * reading it later sees what their approval came to.
 */
export async function applyApprovedPluginIntentV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  intent: PluginIntentRecordV1,
  now: () => Date = () => new Date(),
): Promise<PluginIntentRecordV1 | undefined> {
  if (intent.decision !== "approved" || intent.outcome !== undefined) {
    return intent;
  }
  const at = () => now().toISOString();
  const pluginId =
    intent.action.kind === "publish"
      ? intent.action.member.packageId
      : intent.action.pluginId;
  try {
    let generationId: string | undefined;
    if (intent.action.kind === "publish") {
      const member = intent.action.member;
      for (let attempt = 0; attempt < PROPOSE_ATTEMPTS; attempt += 1) {
        const current = await currentUserCompositionV1(state, identity);
        const held = current.members.find(
          (candidate) => candidate.packageId === member.packageId,
        );
        if (held?.artifact.contentHash === member.artifact.contentHash) {
          generationId = current.generationId;
          break;
        }
        const generation = await generationWithPluginV1(
          current,
          member,
          intent,
          now(),
        );
        try {
          await proposeUserCompositionV1(state, identity, {
            generation,
            pin: true,
            expectedCurrentGenerationId: current.generationId,
          });
          generationId = generation.generationId;
          break;
        } catch (error) {
          // A lost race is a re-read, not a failure. Across the User RPC the
          // error arrives as a plain Error, so its name is matched as well.
          const conflict =
            error instanceof CompositionPinConflictError ||
            (error instanceof Error &&
              /composition pointer moved/.test(error.message));
          if (conflict && attempt + 1 < PROPOSE_ATTEMPTS) continue;
          throw error;
        }
      }
    }
    await switchPluginForBotV1(state.ctx.storage, pluginId, true, now());
    return await recordPluginIntentOutcomeV1(
      state.ctx.storage,
      intent.approvalId,
      {
        status: "applied",
        at: at(),
        ...(generationId === undefined ? {} : { generationId }),
      },
    );
  } catch (error) {
    return await recordPluginIntentOutcomeV1(
      state.ctx.storage,
      intent.approvalId,
      {
        status: "failed",
        reason: (error instanceof Error ? error.message : String(error)).slice(
          0,
          1_024,
        ),
        at: at(),
      },
    );
  }
}
