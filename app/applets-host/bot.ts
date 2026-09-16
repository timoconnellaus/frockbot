// The app's side of Applets, inside the Bot Durable Object: the capability
// host a Turn builds, the User Durable Object's Applet directory, the focused
// Applet, and the resolution of that directory into the Bot's next Composition
// generation.
//
// `@frockbot/applets` is the untrusted runtime an Applet is loaded into; this
// is the authority that mounts it.

import type {
  AppletCapabilityHostV1,
  AppletsRuntimeHostV1,
} from "@frockbot/applets/feature";
import {
  APPLET_BUILD_ROUTE,
  APPLET_BUILD_TOKEN_HEADER,
  decodeAppletBuildProblemV1,
  decodeAppletBuildResponseV1,
  encodeAppletBuildRequestV1,
} from "@frockbot/applets/build-contract";
import {
  decodeAppletProvenanceV1,
  decodeAppletSummaryV1,
  decodeAppletToolDeclarationV1,
} from "@frockbot/core/contracts";
import {
  APPLET_FOCUSED_KEY,
  decodeFocusedAppletV1,
  type BotIdentity,
  type FocusedAppletV1,
  type OwnedBotTurnCommand,
} from "@frockbot/core/durable";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import {
  currentUserCompositionV1,
  proposeUserCompositionV1,
} from "@frockbot/app/composition/bot";
import {
  userAccountFeaturesV1,
  type UserAccountFeaturesReadV1,
} from "@frockbot/app/settings/bot";
import {
  createAppletCapabilityHostV1,
  createAppletInstanceBindingV1,
  appletRpcSnapshotV1 as rpcJsonSnapshotV1,
  resolveAppletCompositionV1,
  type AppletBuildServiceV1,
  type AppletUserDirectoryV1,
} from "./records.js";

/**
 * The Applet build service over the `APPLET_BUILD` binding, or `undefined`
 * when this deployment has no binding or no token.
 *
 * Both halves of the seam decode: the request is encoded by the contract the
 * service decodes it with, and the answer is decoded before it is believed.
 * The service is handed source and returns bytes; the R2 write and the hash
 * verification stay here, so a compromised builder holds no authority.
 */
export function appletBuildService(
  state: ShellBotStateV1,
): AppletBuildServiceV1 | undefined {
  const fetcher = state.env.APPLET_BUILD;
  const token = state.env.APPLET_BUILD_TOKEN?.trim();
  if (!fetcher || !token) return undefined;
  return {
    async build(request) {
      const response = await fetcher.fetch(
        new Request(`https://applet-build.internal${APPLET_BUILD_ROUTE}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [APPLET_BUILD_TOKEN_HEADER]: token,
          },
          body: JSON.stringify(encodeAppletBuildRequestV1(request)),
        }),
      );
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error(
          `the Applet build service answered ${response.status} with no JSON body`,
        );
      }
      if (!response.ok) {
        const problem = decodeAppletBuildProblemV1(body);
        throw new Error(`${problem.code}: ${problem.message}`);
      }
      return decodeAppletBuildResponseV1(body);
    },
  };
}

/**
 * `ctx.applets` for one Bot, or `undefined` when this host cannot reach
 * Applets at all — no instance namespace, no artifact bucket, or no Workspace.
 * An absent capability is an `unavailable` outcome at the isolate boundary,
 * never a thrown error inside Bot code.
 */
function appletCapabilityHost(
  state: ShellBotStateV1,
  identity: BotIdentity,
): AppletCapabilityHostV1 | undefined {
  const namespace = state.env.APPLET_STATES;
  const artifacts = state.env.APPLICATION_ARTIFACTS;
  const workspace = state.env.WORKSPACE_FILES;
  if (!namespace || !artifacts || !workspace) return undefined;
  const bucket = artifacts;
  const buildService = appletBuildService(state);
  return createAppletCapabilityHostV1({
    userId: identity.userId,
    botId: identity.botId,
    storage: {
      get: (key) => state.ctx.storage.get(key),
      put: (entries) => state.ctx.storage.put(entries),
    },
    directory: appletUserDirectory(state, identity),
    instanceFor: createAppletInstanceBindingV1(namespace, identity.userId),
    artifacts: {
      putPackageArtifact: async (contentHash, module) => {
        await bucket.put(`packages/${contentHash}.mjs`, module, {
          httpMetadata: { contentType: "application/javascript" },
        });
      },
      putPackageUiArtifact: async (contentHash, html) => {
        await bucket.put(`packages/${contentHash}.html`, html, {
          httpMetadata: { contentType: "text/html; charset=utf-8" },
        });
      },
    },
    workspace,
    ...(buildService ? { buildService } : {}),
    // The deployment's own origin. A preview URL is `ui.<that host>`, the
    // anonymous artifact origin the published page is already served from.
    ...(state.env.BETTER_AUTH_URL
      ? { appOrigin: state.env.BETTER_AUTH_URL }
      : {}),
    composition: {
      current: () => currentUserCompositionV1(state, identity),
      propose: (generation, options) =>
        proposeUserCompositionV1(state, identity, {
          generation,
          ...(options?.pin === undefined ? {} : { pin: options.pin }),
          ...(options?.expectedCurrentGenerationId === undefined
            ? {}
            : {
                expectedCurrentGenerationId:
                  options.expectedCurrentGenerationId,
              }),
        }),
    },
  });
}

/**
 * Whether an administrator has turned Applets on for this Bot's User.
 *
 * Read from the User Durable Object every time it is asked, never cached in
 * the Bot: the switch is the admin's, and a Turn admitted after it moved
 * should see where it is now. Throws when the User object cannot answer;
 * each caller decides what an unanswerable switch means for it.
 */
export async function appletsEnabled(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<boolean> {
  return (await userAccountFeaturesV1(state, identity)).applets;
}

/**
 * The Applets feature's seam for one admitted Turn, or `undefined` when this
 * host cannot reach Applets at all — or when the feature is off for this
 * User. A switch that cannot be read is off for the Turn: a feature gate
 * that let the tools exist and refuse would still have told the model they
 * were there.
 */
export async function appletsRuntimeHost(
  state: ShellBotStateV1,
  identity: BotIdentity,
  turn: { sessionId: string; runId: string; turnId: string },
  features?: UserAccountFeaturesReadV1,
): Promise<AppletsRuntimeHostV1 | undefined> {
  const capability = appletCapabilityHost(state, identity);
  if (!capability) return undefined;
  let enabled: boolean;
  try {
    enabled = features
      ? (await features()).applets
      : await appletsEnabled(state, identity);
  } catch {
    enabled = false;
  }
  if (!enabled) return undefined;
  return { applets: capability, turn };
}

/**
 * The User Durable Object's Applet directory as this Bot sees it, decoded on
 * arrival. The Bot is on every call: the directory answers nothing for "the
 * User" (ADR 0027).
 */
function appletUserDirectory(
  state: ShellBotStateV1,
  identity: BotIdentity,
): AppletUserDirectoryV1 {
  const id = state.env.USER_CONFIGURATIONS.idFromName(identity.userId);
  // SAFETY: this namespace is bound to UserConfiguration; generated Worker
  // types do not expose its Applet directory RPC surface.
  const rpc = state.env.USER_CONFIGURATIONS.get(id) as unknown as {
    listApplets(input: unknown): Promise<unknown>;
    readApplet(input: unknown): Promise<unknown>;
    readAppletCompositionInput(input: unknown): Promise<unknown>;
    readAppletToolNameClashes(input: unknown): Promise<unknown>;
    createApplet(input: unknown): Promise<unknown>;
    recordAppletGeneration(input: unknown): Promise<unknown>;
    deleteApplet(input: unknown): Promise<unknown>;
    shareApplet(input: unknown): Promise<unknown>;
    unshareApplet(input: unknown): Promise<unknown>;
    transferApplet(input: unknown): Promise<unknown>;
  };
  const userId = identity.userId;
  const botId = identity.botId;
  const access = async (
    call: (input: unknown) => Promise<unknown>,
    appletId: string,
    targetBotId: string,
  ) =>
    decodeAppletSummaryV1(
      rpcJsonSnapshotV1(
        await call({ schemaVersion: 1, userId, botId, appletId, targetBotId }),
      ),
    );
  return {
    async list() {
      const answer = rpcJsonSnapshotV1(
        await rpc.listApplets({ schemaVersion: 1, userId, botId }),
      ) as { revision?: unknown; applets?: unknown };
      return {
        revision: Number(answer.revision ?? 0),
        applets: Array.isArray(answer.applets)
          ? answer.applets.map((applet) => decodeAppletSummaryV1(applet))
          : [],
      };
    },
    async read(appletId, options) {
      return decodeAppletSummaryV1(
        rpcJsonSnapshotV1(
          await rpc.readApplet({
            schemaVersion: 1,
            userId,
            botId,
            appletId,
            ...(options?.owner ? { owner: true } : {}),
          }),
        ),
      );
    },
    async compositionInput() {
      const answer = rpcJsonSnapshotV1(
        await rpc.readAppletCompositionInput({ schemaVersion: 1, userId }),
      ) as { revision?: unknown; applets?: unknown };
      return {
        revision: Number(answer.revision ?? 0),
        applets: (Array.isArray(answer.applets) ? answer.applets : []).map(
          (applet) => {
            const entry = applet as Record<string, unknown>;
            if (
              typeof entry.ownerBotId !== "string" ||
              !Array.isArray(entry.sharedWithBotIds) ||
              entry.sharedWithBotIds.some((id) => typeof id !== "string")
            ) {
              throw new Error("Applet composition input names no access");
            }
            return {
              appletId: String(entry.appletId),
              generationId: String(entry.generationId),
              tools: (Array.isArray(entry.tools) ? entry.tools : []).map(
                (tool, index) =>
                  decodeAppletToolDeclarationV1(
                    tool,
                    `Applet tool declaration[${index}]`,
                  ),
              ),
              provenance: decodeAppletProvenanceV1(entry.provenance),
              ownerBotId: entry.ownerBotId,
              sharedWithBotIds: entry.sharedWithBotIds as string[],
            };
          },
        ),
      };
    },
    async create(input) {
      return decodeAppletSummaryV1(
        rpcJsonSnapshotV1(
          await rpc.createApplet({
            schemaVersion: 1,
            userId,
            botId,
            displayName: input.displayName,
            provenance: input.provenance,
          }),
        ),
      );
    },
    async recordGeneration(input) {
      return decodeAppletSummaryV1(
        rpcJsonSnapshotV1(
          await rpc.recordAppletGeneration({
            schemaVersion: 1,
            userId,
            botId,
            appletId: input.appletId,
            generationId: input.generationId,
            tools: input.tools,
          }),
        ),
      );
    },
    async delete(appletId) {
      return decodeAppletSummaryV1(
        rpcJsonSnapshotV1(
          await rpc.deleteApplet({ schemaVersion: 1, userId, botId, appletId }),
        ),
      );
    },
    async toolNameClashes(appletId, names) {
      const answer = rpcJsonSnapshotV1(
        await rpc.readAppletToolNameClashes({
          schemaVersion: 1,
          userId,
          appletId,
          names,
        }),
      );
      if (
        !Array.isArray(answer) ||
        answer.some((name) => typeof name !== "string")
      ) {
        throw new Error("Applet tool name clashes are invalid");
      }
      return answer as string[];
    },
    share: (appletId, targetBotId) =>
      access((input) => rpc.shareApplet(input), appletId, targetBotId),
    unshare: (appletId, targetBotId) =>
      access((input) => rpc.unshareApplet(input), appletId, targetBotId),
    transfer: (appletId, targetBotId) =>
      access((input) => rpc.transferApplet(input), appletId, targetBotId),
  };
}

/**
 * The Session's focused Applet, as the shell and its route read it.
 *
 * Focus lives in this Bot's storage, but what it points at is the User's
 * directory. A deletion, an unshare, a transfer that left this Bot without
 * access, or the owner Bot's archive reaches only the directory, so a focus
 * can outlive this Bot's access to its Applet. It is settled on the read,
 * against this Bot's own listing, where the directory is
 * already reachable: an id the directory no longer lists is cleared durably,
 * so nothing downstream inherits a pointer to an Applet that is gone. A
 * directory that cannot be read says nothing about the Applet, and leaves the
 * focus exactly as it was.
 */
export async function readFocusedApplet(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<FocusedAppletV1> {
  await state.authority.validateIdentity(identity);
  const stored = await state.ctx.storage.get<unknown>(APPLET_FOCUSED_KEY);
  if (stored === undefined)
    return {
      schemaVersion: 1,
      appletId: null,
      changedAt: new Date(0).toISOString(),
    };
  const focused = decodeFocusedAppletV1(stored);
  if (focused.appletId === null) return focused;
  let listed;
  try {
    listed = await appletUserDirectory(state, identity).list();
  } catch {
    return focused;
  }
  if (listed.applets.some((applet) => applet.appletId === focused.appletId))
    return focused;
  // The directory read is a call to another Durable Object, and this one's
  // input gate is open across it. A focus the User set while it was in flight
  // is about an Applet this listing says nothing about, so the clear applies
  // only to the record it was decided against.
  const latest = await state.ctx.storage.get<unknown>(APPLET_FOCUSED_KEY);
  if (latest === undefined) return focused;
  const current = decodeFocusedAppletV1(latest);
  if (
    current.appletId !== focused.appletId ||
    current.changedAt !== focused.changedAt
  )
    return current;
  const cleared = decodeFocusedAppletV1({
    schemaVersion: 1,
    appletId: null,
    changedAt: new Date().toISOString(),
  });
  await state.ctx.storage.put({ [APPLET_FOCUSED_KEY]: cleared });
  return cleared;
}

/**
 * Records the Session's focus, only ever on an Applet this Bot may open: the
 * directory's refusal is the answer for any other, exactly as for an Applet
 * that does not exist.
 */
export async function setFocusedApplet(
  state: ShellBotStateV1,
  identity: BotIdentity,
  appletId: string | null,
): Promise<FocusedAppletV1> {
  await state.authority.validateIdentity(identity);
  if (appletId !== null) {
    await appletUserDirectory(state, identity).read(appletId);
  }
  const focused = decodeFocusedAppletV1({
    schemaVersion: 1,
    appletId,
    changedAt: new Date().toISOString(),
  });
  await state.ctx.storage.put({ [APPLET_FOCUSED_KEY]: focused });
  return focused;
}

/**
 * Resolve the User's Applet directory into this Bot's next Composition
 * generation, before a Turn is admitted.
 *
 * Outside the admission transaction on purpose: the pin is taken in one
 * storage transaction, which cannot make a cross-object call. A publish or a
 * delete therefore activates at the *next* admitted Turn, and an in-flight
 * Turn keeps the set it pinned. A directory that cannot be read leaves the
 * Bot on the generation it has; an Applet change is never a reason a Turn
 * cannot start.
 */
export async function resolveAppletComposition(
  state: ShellBotStateV1,
  identity: BotIdentity,
  command: OwnedBotTurnCommand,
): Promise<void> {
  if (!state.env.APPLET_STATES) return;
  try {
    const directory = appletUserDirectory(state, identity);
    // With the feature off, the directory resolves to no members: the
    // Applets the User already holds keep their data and come back at the
    // first Turn after an admin turns the feature on again.
    const enabled = await appletsEnabled(state, identity);
    await resolveAppletCompositionV1({
      directory: enabled
        ? directory
        : {
            compositionInput: async () => ({
              ...(await directory.compositionInput()),
              applets: [],
            }),
          },
      composition: {
        current: () => currentUserCompositionV1(state, identity),
        propose: (generation, options) =>
          proposeUserCompositionV1(state, identity, {
            generation,
            ...(options?.pin === undefined ? {} : { pin: options.pin }),
            ...(options?.expectedCurrentGenerationId === undefined
              ? {}
              : {
                  expectedCurrentGenerationId:
                    options.expectedCurrentGenerationId,
                }),
          }),
      },
      storage: {
        get: (key) => state.ctx.storage.get(key),
        put: (entries) => state.ctx.storage.put(entries),
      },
      origin: {
        kind: "bot-authored",
        runId: command.runId,
        sessionId: command.sessionId,
        turnId: command.runId,
      },
    });
  } catch {
    // Visible through the Applet's own failure records; never a wedged Turn.
  }
}
