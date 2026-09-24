// The Bot Durable Object's side of Plugin authoring (ADR 0026): the gate,
// the seams the authoring host runs over, and what an approved intent does.
//
// `applyApprovedPluginIntentV1` is the one place a Plugin reaches the User's
// Composition and this Bot's enable map. It runs *after* the transaction that
// recorded the decision, because a proposal is a cross-object call, and it is
// idempotent on what the Composition already holds: a crash between the
// commit and this call is a retry, never a second generation.
import { pluginPageKeyV1 } from "@frockbot/core/contracts";
import type { BotIdentity } from "@frockbot/core/durable";
import {
  CompositionPinConflictError,
  compositionArtifactSetHashV1,
  compositionGenerationIdV1,
  decodeCompositionGenerationV1,
  type CompositionGenerationV1,
  type CompositionMemberV1,
} from "@frockbot/core/durable";
import {
  APPLET_BUILD_TOKEN_HEADER,
  PLUGIN_BUILD_ROUTE,
  decodePluginBuildProblemV1,
  decodePluginBuildResponseV1,
  encodePluginBuildRequestV1,
} from "@frockbot/applets/build-contract";
import type { PluginBuildServiceV1 } from "@frockbot/app/plugins/authoring";
import {
  currentUserCompositionV1,
  proposeUserCompositionV1,
} from "@frockbot/app/composition/bot";
import { pluginSettingsKeyV1 } from "@frockbot/app/isolates/bot";
import type { UserAccountFeaturesReadV1 } from "@frockbot/app/settings/bot";
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
 * The Plugin build service over the `APPLET_BUILD` binding, or `undefined`
 * when this deployment has no binding or no token.
 */
function pluginBuildService(
  state: ShellBotStateV1,
): PluginBuildServiceV1 | undefined {
  const fetcher = state.env.APPLET_BUILD;
  const token = state.env.APPLET_BUILD_TOKEN?.trim();
  if (!fetcher || !token) return undefined;
  return {
    async build(request) {
      const response = await fetcher.fetch(
        new Request(`https://applet-build.internal${PLUGIN_BUILD_ROUTE}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [APPLET_BUILD_TOKEN_HEADER]: token,
          },
          body: JSON.stringify(encodePluginBuildRequestV1(request)),
        }),
      );
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error(
          `the build service answered ${response.status} with no JSON body`,
        );
      }
      if (!response.ok) {
        const problem = decodePluginBuildProblemV1(body);
        throw new Error(`${problem.code}: ${problem.message}`);
      }
      return decodePluginBuildResponseV1(body);
    },
  };
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
  features: UserAccountFeaturesReadV1,
): Promise<PluginAuthoringRuntimeHostV1 | undefined> {
  const artifacts = state.env.APPLICATION_ARTIFACTS;
  const workspace = state.env.WORKSPACE_FILES;
  if (!artifacts || !workspace) return undefined;
  let enabled: boolean;
  try {
    enabled = (await features()).pluginAuthoring;
  } catch {
    enabled = false;
  }
  if (!enabled) return undefined;
  const bucket = artifacts;
  const buildService = pluginBuildService(state);
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
      putPackageUiArtifact: async (contentHash, html) => {
        await bucket.put(pluginPageKeyV1(contentHash), html, {
          httpMetadata: { contentType: "text/html; charset=utf-8" },
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
  const artifactSetHash = await compositionArtifactSetHashV1(members);
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
    status: "pending",
  });
}

/**
 * What an approved intent does, after its decision committed.
 *
 * A `publish` proposes the generation on the User — skipped when the current
 * generation already holds this exact artifact, which is what makes a retry
 * safe — and then switches the Plugin on for this Bot. An `enable` only
 * switches. An application that got through records its outcome on the
 * intent, so a person reading it later sees what their approval came to; one
 * that threw records nothing and raises, leaving an approval a retry can
 * still apply rather than one closed as failed.
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
  const pluginId =
    intent.action.kind === "publish"
      ? intent.action.member.packageId
      : intent.action.pluginId;
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
      at: now().toISOString(),
      ...(generationId === undefined ? {} : { generationId }),
    },
  );
}
