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
  appletSourceFilePathV1,
  appletsSourceRootV1,
} from "@frockbot/applets/root";
import { syncWorkspaceRootNowV1 } from "@frockbot/computer/agent";
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
import type {
  ActiveTurnV1,
  ShellBotStateV1,
} from "@frockbot/app/shell/backend-state";
import {
  createAppletCapabilityHostV1,
  createAppletInstanceBindingV1,
  APPLET_DIST_FILES_V1,
  appletRpcSnapshotV1 as rpcJsonSnapshotV1,
  resolveAppletCompositionV1,
  type AppletUserDirectoryV1,
} from "./records.js";

/**
 * `ctx.applets` for one Bot, or `undefined` when this host cannot reach
 * Applets at all — no instance namespace, no artifact bucket, or no Workspace.
 * An absent capability is an `unavailable` outcome at the isolate boundary,
 * never a thrown error inside Bot code.
 */
function appletCapabilityHost(
  state: ShellBotStateV1,
  identity: BotIdentity,
  active?: ActiveTurnV1,
): AppletCapabilityHostV1 | undefined {
  const namespace = state.env.APPLET_STATES;
  const artifacts = state.env.APPLICATION_ARTIFACTS;
  const workspace = state.env.WORKSPACE_FILES;
  if (!namespace || !artifacts || !workspace) return undefined;
  const bucket = artifacts;
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
    // A publish reads `dist/` from the store, and `applet build` wrote it on
    // the Computer moments earlier in this very Turn — before the Turn's own
    // `turn-end` push. So the one root is reconciled first, through the one
    // sanctioned extra caller of the Computer's sync. It wakes nothing new: a
    // User with no Computer assignment has no root to pull, and the Bot that
    // just built on its Computer has it open already.
    syncSourceRootNow: active
      ? async (appletId) => {
          const root = active.mounted.runtime.services;
          const computerIdentity = { userId: identity.userId };
          if (!root.computers.assignment(computerIdentity)) {
            return { status: "skipped", detail: "" } as const;
          }
          const session = root.sessions.get(active.sessionId);
          const started = session?.events.findLast(
            (event) => event.type === "step/start",
          );
          const turn = started?.type === "step/start" ? started.turn : 0;
          const computer = await root.computers.open(
            computerIdentity,
            { botId: identity.botId },
            { signal: active.signal },
          );
          const summary = await syncWorkspaceRootNowV1({
            computer,
            sessions: root.sessions,
            sessionId: active.sessionId,
            turn,
            root: appletsSourceRootV1(identity.userId),
            requiredPaths: APPLET_DIST_FILES_V1.map(
              (path) => `${appletId}/${path}`,
            ),
            signal: active.signal,
          });
          return {
            status: summary.status,
            detail: summary.detail,
            ...(summary.required ? { required: summary.required } : {}),
          };
        }
      : undefined,
    composition: {
      current: () => state.authority.composition.current(),
      lastKnownGood: () => state.authority.composition.lastKnownGood(),
      propose: (generation, options) =>
        state.authority.composition.propose(generation, options),
    },
  });
}

/**
 * The Applets feature's seam for one admitted Turn, or `undefined` when this
 * host cannot reach Applets at all.
 *
 * The capability host is built per call rather than once: it closes over the
 * Turn's mounted runtime, which is what lets a publish pull the Applet's
 * `dist/` off the Computer, and that runtime does not exist yet when a Turn's
 * features are assembled.
 */
export function appletsRuntimeHost(
  state: ShellBotStateV1,
  identity: BotIdentity,
  turn: { sessionId: string; runId: string; turnId: string },
): AppletsRuntimeHostV1 | undefined {
  const files = state.env.WORKSPACE_FILES;
  if (!state.env.APPLET_STATES || !state.env.APPLICATION_ARTIFACTS || !files) {
    return undefined;
  }
  const capability = (): AppletCapabilityHostV1 => {
    const host = appletCapabilityHost(state, identity, state.turn.current);
    if (!host) throw new Error("Applets are unavailable");
    return host;
  };
  return {
    applets: {
      list: () => capability().list(),
      create: (input, scope) => capability().create(input, scope),
      publish: (input, scope) => capability().publish(input, scope),
      revert: (input, scope) => capability().revert(input, scope),
      delete: (input) => capability().delete(input),
      focus: (input) => capability().focus(input),
      generations: (input) => capability().generations(input),
      readFocused: () => capability().readFocused(),
    },
    turn,
    writeSource: async (input) => {
      const outcome = await files.write({
        path: appletSourceFilePathV1(
          identity.userId,
          input.appletId,
          input.path,
        ),
        bytes: input.bytes,
        writer: {
          kind: "bot",
          botId: identity.botId,
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          runId: turn.runId,
        },
        expectedGenerationId: null,
        mediaType: input.mediaType,
      });
      if (outcome.status !== "ok") {
        throw new Error(
          `the Applet was created but "${input.path}" could not be written: ${outcome.status}`,
        );
      }
    },
  };
}

/** The User Durable Object's Applet directory, decoded on arrival. */
function appletUserDirectory(
  state: ShellBotStateV1,
  identity: BotIdentity,
): AppletUserDirectoryV1 {
  const id = state.env.USER_CONFIGURATIONS.idFromName(identity.userId);
  // SAFETY: this namespace is bound to UserConfiguration; generated Worker
  // types do not expose its Applet directory RPC surface.
  const rpc = state.env.USER_CONFIGURATIONS.get(id) as unknown as {
    listApplets(input: unknown): Promise<unknown>;
    readAppletCompositionInput(input: unknown): Promise<unknown>;
    createApplet(input: unknown): Promise<unknown>;
    recordAppletGeneration(input: unknown): Promise<unknown>;
    deleteApplet(input: unknown): Promise<unknown>;
  };
  const userId = identity.userId;
  return {
    async list() {
      const answer = rpcJsonSnapshotV1(
        await rpc.listApplets({ schemaVersion: 1, userId }),
      ) as { revision?: unknown; applets?: unknown };
      return {
        revision: Number(answer.revision ?? 0),
        applets: Array.isArray(answer.applets)
          ? answer.applets.map((applet) => decodeAppletSummaryV1(applet))
          : [],
      };
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
          await rpc.deleteApplet({ schemaVersion: 1, userId, appletId }),
        ),
      );
    },
  };
}

/** The Session's focused Applet, as the shell and its route read it. */
export async function readFocusedApplet(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<FocusedAppletV1> {
  await state.authority.validateIdentity(identity);
  const stored = await state.ctx.storage.get<unknown>(APPLET_FOCUSED_KEY);
  return stored === undefined
    ? {
        schemaVersion: 1,
        appletId: null,
        changedAt: new Date(0).toISOString(),
      }
    : decodeFocusedAppletV1(stored);
}

export async function setFocusedApplet(
  state: ShellBotStateV1,
  identity: BotIdentity,
  appletId: string | null,
): Promise<FocusedAppletV1> {
  await state.authority.validateIdentity(identity);
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
    await resolveAppletCompositionV1({
      directory: appletUserDirectory(state, identity),
      composition: {
        current: () => state.authority.composition.current(),
        propose: (generation, options) =>
          state.authority.composition.propose(generation, options),
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
