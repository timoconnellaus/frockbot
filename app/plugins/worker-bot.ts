// A Plugin worker mounted for one call outside any Turn (ADR 0026 steps 8–9).
//
// A trigger delivery, a section render and a control's press all need the
// same thing: this Bot's enabled Plugins, in the User's current generation,
// mounted under a synthetic identity that names what the call is for, then
// disposed when the answer is in. The loader serves the same worker a Turn
// would, so nothing is built twice; nothing here holds a Turn open.
import {
  PluginWorkerHost,
  type ActivePluginWorker,
} from "@frockbot/frock-compose";
import { LoopHookListV1 } from "@frockbot/core/contracts";
import type { BotIdentity } from "@frockbot/core/durable";
import { SystemPromptRegistry } from "@frockbot/core/prompt";
import { ToolRegistry } from "@frockbot/core/tools";
import { currentUserCompositionV1 } from "@frockbot/app/composition/bot";
import { isolateMountOptions } from "@frockbot/app/isolates/bot";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import {
  DEPLOYMENT_PLUGIN_CATALOG_V1,
  enabledSeededPluginIdsV1,
} from "./catalog.js";
import { readPluginEnablementV1 } from "./enablement.js";

/** What this Bot would run right now: the generation's members and its switches. */
export interface BotPluginRosterV1 {
  generationId: string;
  members: Awaited<ReturnType<typeof currentUserCompositionV1>>["members"];
  /** The ids of the members this Bot has on. */
  enabled: string[];
}

export async function readBotPluginRosterV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<BotPluginRosterV1> {
  const current = await currentUserCompositionV1(state, identity);
  const enablement = await readPluginEnablementV1(state.ctx.storage);
  return {
    generationId: current.generationId,
    members: current.members,
    enabled: enabledSeededPluginIdsV1(
      current.members,
      enablement,
      DEPLOYMENT_PLUGIN_CATALOG_V1,
    ),
  };
}

export type PluginWorkerMountV1 =
  | {
      status: "mounted";
      active: ActivePluginWorker;
      mounted: string[];
      failures: { pluginId: string; message: string }[];
    }
  | { status: "unavailable"; reason: string };

/**
 * Mounts this Bot's enabled Plugins for one standalone call. The caller runs
 * what it came for on `active` and must `dispose` it; `withPluginWorkerV1`
 * does both. A worker that does not come up is the `unavailable` answer, so
 * a broken Plugin never throws out of a standalone call.
 */
async function mountPluginWorkerV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  roster: BotPluginRosterV1,
  call: { runId: string; deadlineMs: number },
): Promise<PluginWorkerMountV1> {
  // The identity the call runs under: not a Turn, but shaped like one so
  // every loopback call still names what it is for.
  const sessionId = `${identity.userId}:${identity.botId}`;
  const isolate = await isolateMountOptions(state, identity, {
    runId: call.runId,
    sessionId,
    generationId: roster.generationId,
    members: roster.members,
    enabled: roster.enabled,
  });
  if (!isolate) {
    return {
      status: "unavailable",
      reason: "this deployment cannot mount a Plugin worker",
    };
  }
  // The grants admit this call the way they admit a Turn, for the members
  // it mounts and no longer than it lives.
  const release = state.turn.beginStandalone({
    runId: call.runId,
    sessionId,
    turnId: call.runId,
    generationId: roster.generationId,
    members: roster.members.filter((candidate) =>
      roster.enabled.includes(candidate.packageId),
    ),
  });
  const hooks = new LoopHookListV1();
  const host = new PluginWorkerHost({
    ...isolate,
    // Throwaway registries: a standalone call registers nothing anyone calls.
    tools: new ToolRegistry(hooks, new SystemPromptRegistry(hooks)),
    hooks,
    botId: identity.botId,
    sessionId,
    turnId: call.runId,
    generationId: roster.generationId,
    turnType: "automation",
    recordHookFailure: () => Promise.resolve(),
    deadlineMs: call.deadlineMs,
  });
  let prepared: Awaited<ReturnType<typeof host.mount>>;
  let active: ActivePluginWorker;
  try {
    prepared = await host.mount(
      roster.members.filter((candidate) =>
        roster.enabled.includes(candidate.packageId),
      ),
    );
    active = await prepared.commit();
  } catch (error) {
    release();
    return {
      status: "unavailable",
      reason: `this Bot's plugin worker did not mount: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return {
    status: "mounted",
    active: {
      deliverTrigger: (invocation) => active.deliverTrigger(invocation),
      renderView: (invocation) => active.renderView(invocation),
      executeTool: (invocation) => active.executeTool(invocation),
      dispose: async () => {
        release();
        await active.dispose();
      },
    },
    mounted: [...prepared.mounted],
    failures: prepared.failures.map((failure) => ({
      pluginId: failure.pluginId,
      message: failure.message,
    })),
  };
}

/** Mounts, runs `work`, disposes. A worker this deployment cannot mount is the `unavailable` answer. */
export async function withPluginWorkerV1<T>(
  state: ShellBotStateV1,
  identity: BotIdentity,
  roster: BotPluginRosterV1,
  call: { runId: string; deadlineMs: number },
  work: (
    worker: Extract<PluginWorkerMountV1, { status: "mounted" }>,
  ) => Promise<T>,
): Promise<T | { status: "unavailable"; reason: string }> {
  const mount = await mountPluginWorkerV1(state, identity, roster, call);
  if (mount.status !== "mounted") return mount;
  try {
    return await work(mount);
  } finally {
    await mount.active.dispose();
  }
}
