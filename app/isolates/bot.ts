// The authority a Bot isolate member holds, as the Bot Durable Object grants
// it: what a member is mounted with, and the six grants it may call back on.
// Every call is fenced against the Turn that is actually running — a member
// naming a run this object is not executing is told the grant is unavailable,
// never given it.
//
// `capabilities.ts` beside this file is the isolate-side host; this is the
// Bot-side authority that mints it.

import type {
  FoundationAgentPackage,
  RuntimeModelSelection,
} from "@frockbot/app/agent-runtime";
import {
  decodeIsolateMemoryReadRequestV1,
  decodeIsolateMemoryWriteRequestV1,
  decodeIsolateScheduleRequestV1,
  decodeIsolateStorageDeleteRequestV1,
  decodeIsolateStorageGetRequestV1,
  decodeIsolateStorageListRequestV1,
  decodeIsolateStoragePutRequestV1,
  decodeIsolateWorkspaceDeleteRequestV1,
  decodeIsolateWorkspaceListRequestV1,
  decodeIsolateWorkspacePathV1,
  decodeIsolateWorkspaceWriteRequestV1,
  decodeWorkspacePathV1,
  decodeWorkspaceRootV1,
  MAX_ISOLATE_STORAGE_LIST_V1,
  type BotCapabilitiesStub,
  type IsolateCapabilityListOutcomeV1,
  type IsolateConnectionOutcomeV1,
  type IsolateConnectionV1,
  type IsolateMemoryOutcomeV1,
  type IsolateModelInvocationV1,
  type IsolateScheduleOutcomeV1,
  type IsolateSettingsOutcomeV1,
  type IsolateStorageListOutcomeV1,
  type IsolateStorageOutcomeV1,
  type IsolateWorkspaceOutcomeV1,
  type NormalizedModelRequest,
  type PluginDescriptorV1,
  type WorkspacePathV1,
} from "@frockbot/core/contracts";
import {
  resolveEffectiveBotModelV1,
  type BotSettingsViewV1,
} from "@frockbot/core/configuration";
import type { BotIdentity } from "@frockbot/core/durable";
import { frockbotToolCallV1 } from "@frockbot/core/tools";
import { memoryScopeRootV1 } from "@frockbot/app/memory/roots";
import { notePluginFailureV1 } from "@frockbot/app/plugins/health-bot";
import {
  readBotSettingsV1,
  userConfigurationV1,
} from "@frockbot/app/settings/bot";
import { createShellCompositionHost } from "@frockbot/app/shell/backend-composition";
import { readPinnedCompositionGenerationV1 } from "@frockbot/app/composition/bot";
import type { ShellIsolateMountOptions } from "@frockbot/app/shell/backend-composition";
import { createBotMemoryHost } from "@frockbot/app/shell/backend-memory";
import { agentRuntime } from "@frockbot/app/shell/runtime-mount";
import { admitRunEffect } from "@frockbot/app/shell/turn";
import { notificationIdV1 } from "@frockbot/app/shell/notification-id";
import {
  executionPackagesV1,
  type ActiveTurnV1,
  type ShellBotStateV1,
} from "@frockbot/app/shell/backend-state";
import {
  BOT_ISOLATE_COMPATIBILITY_DATE,
  createIsolateCapabilityHost,
  createR2PackageArtifactStore,
  pluginEgressPolicyV1,
  pluginWorkerBindingDigestV1,
  type BotCapabilitiesPropsV1,
  type IsolateCapabilityHost,
  type IsolateModelBindingV1,
  type IsolateModelPath,
  type PluginEgressPropsV1,
} from "./capabilities.js";

/** Where one Plugin's per-Bot key-value entries live in the Bot object. */
export function pluginStorageKeyV1(pluginId: string, key: string): string {
  return `plugin:storage:${pluginId}:${key}`;
}

/** Where one Plugin's per-Bot settings values live in the Bot object. */
export function pluginSettingsKeyV1(pluginId: string): string {
  return `plugin:settings:${pluginId}`;
}

/** The Turn a grant call names, and the member making it. */
export interface IsolateCallScopeV1 {
  userId: string;
  botId: string;
  runId: string;
  sessionId: string;
  turnId: string;
  packageId: string;
  generationId: string;
  request: unknown;
}

/**
 * Everything a Bot isolate member needs. Package identity is attribution only;
 * Connections and model are resolved once for the Bot and every member receives
 * the same list.
 */
export async function isolateMountOptions(
  state: ShellBotStateV1,
  identity: BotIdentity,
  turn: {
    runId: string;
    sessionId: string;
    generationId: string;
    /** The generation's Plugins and which of them this Bot runs. */
    members: readonly { packageId: string; descriptor: PluginDescriptorV1 }[];
    enabled: readonly string[];
  },
): Promise<ShellIsolateMountOptions | undefined> {
  const loader = state.env.BOT_PACKAGES;
  const artifacts = state.env.APPLICATION_ARTIFACTS;
  const exports = (
    state.ctx as unknown as {
      exports?: {
        BotCapabilities?: (options: {
          props: BotCapabilitiesPropsV1;
        }) => BotCapabilitiesStub;
        PluginEgress?: (options: { props: PluginEgressPropsV1 }) => unknown;
      };
    }
  ).exports;
  if (!loader || !artifacts || !exports?.BotCapabilities) return undefined;
  // The stub is per User and carries no snapshot: every call names its Turn
  // and the authority is resolved then. The egress policy is what the enabled
  // Plugins declared, and is the one thing beside the User baked into env.
  const policy = pluginEgressPolicyV1(
    turn.members
      .filter((member) => turn.enabled.includes(member.packageId))
      .map((member) => member.descriptor),
  );
  const egress =
    policy && exports.PluginEgress
      ? exports.PluginEgress({ props: { userId: identity.userId, ...policy } })
      : undefined;
  return {
    userId: identity.userId,
    runId: turn.runId,
    turnId: turn.runId,
    loader,
    artifacts: createR2PackageArtifactStore(artifacts),
    capabilities: exports.BotCapabilities({
      props: { userId: identity.userId },
    }),
    ...(egress === undefined ? {} : { egress }),
    bindingDigest: await pluginWorkerBindingDigestV1({
      userId: identity.userId,
      egress: egress === undefined ? undefined : policy,
    }),
    compatibilityDate: BOT_ISOLATE_COMPATIBILITY_DATE,
    enabled: turn.enabled,
    onPluginFailure: (failure) =>
      notePluginFailureV1(
        state,
        { runId: turn.runId, generationId: turn.generationId },
        failure,
      ),
  };
}

/** What the Bot holds right now, for the Plugin that asked. */
export async function isolateAuthority(
  state: ShellBotStateV1,
  identity: BotIdentity,
  input: IsolateCallScopeV1,
): Promise<IsolateCapabilityListOutcomeV1> {
  if (!isolateCallAdmittedV1(state, input)) {
    return {
      status: "unavailable",
      reason: "the Package is not running in this Bot's active Composition",
    };
  }
  const settings = await readBotSettingsV1(state, identity);
  const authority = await isolateAuthoritySnapshot(state, identity, settings);
  return {
    status: "available",
    connections: authority.connections,
    ...(authority.model ? { model: authority.model } : {}),
    memory: authority.memory,
    workspace: authority.workspace,
    schedule: true,
  };
}

export async function isolateStorageGet(
  state: ShellBotStateV1,
  input: IsolateCallScopeV1,
): Promise<IsolateStorageOutcomeV1> {
  if (!isolateCallAdmittedV1(state, input)) {
    return { status: "unavailable", reason: "storage is unavailable" };
  }
  const request = decodeIsolateStorageGetRequestV1(input.request);
  const value = await state.ctx.storage.get<unknown>(
    pluginStorageKeyV1(input.packageId, request.key),
  );
  return { status: "available", value: value ?? null };
}

export async function isolateStoragePut(
  state: ShellBotStateV1,
  input: IsolateCallScopeV1,
): Promise<IsolateStorageOutcomeV1> {
  if (!isolateCallAdmittedV1(state, input)) {
    return { status: "unavailable", reason: "storage is unavailable" };
  }
  const request = decodeIsolateStoragePutRequestV1(input.request);
  const key = pluginStorageKeyV1(input.packageId, request.key);
  await state.ctx.storage.put(key, request.value);
  return { status: "available", value: request.value };
}

export async function isolateStorageDelete(
  state: ShellBotStateV1,
  input: IsolateCallScopeV1,
): Promise<IsolateStorageOutcomeV1> {
  if (!isolateCallAdmittedV1(state, input)) {
    return { status: "unavailable", reason: "storage is unavailable" };
  }
  const request = decodeIsolateStorageDeleteRequestV1(input.request);
  const deleted = await state.ctx.storage.delete(
    pluginStorageKeyV1(input.packageId, request.key),
  );
  return { status: "available", value: deleted };
}

export async function isolateStorageList(
  state: ShellBotStateV1,
  input: IsolateCallScopeV1,
): Promise<IsolateStorageListOutcomeV1> {
  if (!isolateCallAdmittedV1(state, input)) {
    return { status: "unavailable", reason: "storage is unavailable" };
  }
  const request = decodeIsolateStorageListRequestV1(input.request ?? {});
  const base = pluginStorageKeyV1(input.packageId, "");
  const limit = request.limit ?? MAX_ISOLATE_STORAGE_LIST_V1;
  const listed = await state.ctx.storage.list<unknown>({
    prefix: base + (request.prefix ?? ""),
    ...(request.cursor === undefined ? {} : { startAfter: request.cursor }),
    limit: limit + 1,
  });
  const entries = [...listed.entries()].map(([storedKey, value]) => ({
    key: storedKey.slice(base.length),
    value,
  }));
  const page = entries.slice(0, limit);
  const last = page.at(-1);
  return {
    status: "available",
    entries: page,
    ...(entries.length > limit && last
      ? { cursor: pluginStorageKeyV1(input.packageId, last.key) }
      : {}),
  };
}

export async function isolateSettings(
  state: ShellBotStateV1,
  input: IsolateCallScopeV1,
): Promise<IsolateSettingsOutcomeV1> {
  if (!isolateCallAdmittedV1(state, input)) {
    return { status: "unavailable", reason: "settings are unavailable" };
  }
  const stored = await state.ctx.storage.get<unknown>(
    pluginSettingsKeyV1(input.packageId),
  );
  const values =
    stored && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  return { status: "available", values: structuredClone(values) };
}

/** The Connections, model, Memory and Workspace every member of one Turn is given. */
export async function isolateAuthoritySnapshot(
  state: ShellBotStateV1,
  identity: BotIdentity,
  settings: BotSettingsViewV1,
): Promise<{
  connections: IsolateConnectionV1[];
  model?: IsolateModelBindingV1;
  memory: boolean;
  workspace: boolean;
}> {
  const user = await userConfigurationV1(state, identity).readConfiguration({
    schemaVersion: 1,
    userId: identity.userId,
  });
  const connections = user.connections.flatMap((connection) =>
    connection.state === "ready" && connection.generation
      ? [
          {
            connectionId: connection.connectionId,
            packageId: connection.packageId,
            connectionTypeId: connection.connectionTypeId,
            displayName: connection.displayName,
            generation: connection.generation,
            safeMetadata: structuredClone(connection.safeMetadata),
          } satisfies IsolateConnectionV1,
        ]
      : [],
  );
  const effective = resolveEffectiveBotModelV1({
    bot: settings,
    user,
    packages: executionPackagesV1(state.application),
  });
  const binding = effective.binding;
  const model =
    effective.model &&
    binding?.state === "ready" &&
    binding.connection?.generation &&
    binding.packageId &&
    binding.providerType
      ? {
          connectionId: binding.connection.connectionId,
          packageId: binding.packageId,
          provider: binding.providerType,
          providerModelId: effective.model.providerModelId,
          connectionGeneration: binding.connection.generation,
          ...(binding.connection.modelCatalog?.generation
            ? {
                catalogGeneration: binding.connection.modelCatalog.generation,
              }
            : {}),
        }
      : undefined;
  return {
    connections,
    ...(model ? { model } : {}),
    memory: Boolean(state.env.MEMORY_WORKSPACE_FILES),
    workspace: Boolean(state.env.WORKSPACE_FILES),
  };
}

export async function isolateInvokeModel(
  state: ShellBotStateV1,
  identity: BotIdentity,
  input: {
    runId: string;
    sessionId: string;
    turnId: string;
    packageId: string;
    generationId: string;
    request: NormalizedModelRequest;
  },
): Promise<IsolateModelInvocationV1> {
  if (!isolateCallAdmittedV1(state, input)) {
    return {
      status: "unavailable",
      reason: "the Package is not running in this Bot's active Composition",
    };
  }
  const settings = await readBotSettingsV1(state, identity);
  const authority = await isolateAuthoritySnapshot(state, identity, settings);
  const admitted = authority.model;
  if (
    !admitted ||
    input.request.provider !== admitted.provider ||
    input.request.model !== admitted.providerModelId
  ) {
    return { status: "unavailable", reason: "the model is unavailable" };
  }
  let runtime:
    | {
        agentPackages: FoundationAgentPackage[];
        modelSelection: RuntimeModelSelection;
      }
    | undefined;
  try {
    runtime = await agentRuntime(state, identity, settings);
  } catch {
    runtime = undefined;
  }
  // The binding is the Bot's, resolved now: a Plugin names a provider and a
  // model, never a Connection.
  const request: NormalizedModelRequest = {
    ...input.request,
    modelBinding: {
      connectionId: admitted.connectionId,
      connectionGeneration: admitted.connectionGeneration,
      ...(admitted.catalogGeneration
        ? { catalogGeneration: admitted.catalogGeneration }
        : {}),
    },
  };
  return isolateCapabilities(
    state,
    {
      botId: identity.botId,
      packageId: input.packageId,
      generationId: input.generationId,
    },
    authority,
    runtime
      ? { path: isolateModelPath(state, identity, runtime, input.generationId) }
      : undefined,
  ).invokeModel(request);
}

/**
 * The Bot's own tool dispatch, reached only by the `schedule` grant.
 *
 * Calling the Bot's tools is not a grant a plugin may name, so this is not
 * exported: `routine_manage` is the one tool a granted plugin reaches, and it
 * reaches it through {@link isolateSchedule}.
 */
async function invokeBotToolForIsolateV1(
  state: ShellBotStateV1,
  input: {
    userId: string;
    botId: string;
    runId: string;
    sessionId: string;
    turnId: string;
    packageId: string;
    generationId: string;
    request: { callId: string; name: string; input: unknown };
  },
): Promise<IsolateScheduleOutcomeV1> {
  const request = input.request;
  const active = activeIsolateTurn(state, input);
  if (!active) {
    return {
      status: "unavailable",
      reason: "the Package is not running in this Bot's active Composition",
    };
  }
  const session = active.mounted.runtime.services.sessions.get(input.sessionId);
  if (!session) {
    return {
      status: "unavailable",
      reason: "the active Session is unavailable",
    };
  }
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
    return {
      status: "unavailable",
      reason: "the active step is unavailable",
    };
  }
  const effectId = await isolateToolEffectId(input.packageId, request.callId);
  const priorCall = session.events.find(
    (event) =>
      event.type === "package/tool-call" && event.effectId === effectId,
  );
  const priorResult = session.events.find(
    (event) =>
      event.type === "package/tool-result" && event.effectId === effectId,
  );
  if (priorResult?.type === "package/tool-result") {
    return {
      status: "completed",
      content: priorResult.content,
      isError: priorResult.isError,
    };
  }
  if (
    priorCall?.type === "package/tool-call" &&
    (priorCall.packageId !== input.packageId ||
      priorCall.callId !== request.callId ||
      priorCall.name !== request.name ||
      JSON.stringify(priorCall.input) !== JSON.stringify(request.input))
  ) {
    return {
      status: "unavailable",
      reason: "the Package tool idempotency key was reused",
    };
  }
  if (!priorCall) {
    session.append({
      type: "package/tool-call",
      turn: started.turn,
      step: started.step,
      effectId,
      packageId: input.packageId,
      callId: request.callId,
      name: request.name,
      input: request.input,
    });
    await session.flush();
  }
  // The journal keeps the Package's own call — the tool it named and the input
  // it gave — and the registry is reached the way a first-party tool is now
  // reached at all: through the `frockbot` namespace.
  const call = frockbotToolCallV1({
    id: request.callId,
    name: request.name,
    input: request.input,
  });
  const context = {
    botId: input.botId,
    agentId: input.botId,
    sessionId: input.sessionId,
    compositionGenerationId: input.generationId,
    effectId,
    toolCall: call,
    turnType: active.turnType,
    ...(active.subagentRole ? { subagentRole: active.subagentRole } : {}),
    signal: active.signal,
  };
  const preparation = await active.mounted.runtime.services.tools.prepare(
    call,
    context,
  );
  let result: { content: string; isError: boolean };
  if (preparation.kind === "denied") {
    result = preparation.result;
  } else {
    const admitted = await admitRunEffect(
      state,
      { userId: input.userId, botId: input.botId },
      input.runId,
      input.sessionId,
      { kind: "tool", effectId },
    );
    if (!admitted) {
      result = {
        content: "The tool effect was stopped before it started.",
        isError: true,
      };
    } else {
      // A call the object had already started is dispatched again under the
      // same effect id rather than investigated.
      result = await active.mounted.runtime.services.tools.executePrepared(
        preparation,
        context,
      );
    }
  }
  session.append({
    type: "package/tool-result",
    turn: started.turn,
    step: started.step,
    effectId,
    packageId: input.packageId,
    callId: request.callId,
    name: request.name,
    content: result.content,
    isError: result.isError,
  });
  await session.flush();
  return {
    status: "completed",
    content: result.content,
    isError: result.isError,
  };
}

export async function isolateMemoryRead(
  state: ShellBotStateV1,
  input: IsolateCallScopeV1,
): Promise<IsolateMemoryOutcomeV1> {
  const request = decodeIsolateMemoryReadRequestV1(input.request);
  const memory = await isolateMemoryHost(state, input, request);
  if (!memory)
    return { status: "unavailable", reason: "Memory is unavailable" };
  return {
    status: "available",
    value: await memory.store.read(
      memoryScopeRootV1(request.scope, memory.owner, request.projectId),
    ),
  };
}

export async function isolateMemoryWrite(
  state: ShellBotStateV1,
  input: IsolateCallScopeV1,
): Promise<IsolateMemoryOutcomeV1> {
  const request = decodeIsolateMemoryWriteRequestV1(input.request);
  const memory = await isolateMemoryHost(state, input, request);
  if (!memory?.writer) {
    return { status: "unavailable", reason: "Memory is unavailable" };
  }
  return {
    status: "available",
    value: await memory.store.write({
      root: memoryScopeRootV1(request.scope, memory.owner, request.projectId),
      tier: request.tier ?? "log",
      fact: request.fact,
      writer: {
        kind: "bot",
        botId: input.botId,
        ...memory.writer,
      },
    }),
  };
}

export async function isolateMemoryForget(
  state: ShellBotStateV1,
  input: IsolateCallScopeV1,
): Promise<IsolateMemoryOutcomeV1> {
  const request = decodeIsolateMemoryWriteRequestV1(input.request);
  const memory = await isolateMemoryHost(state, input, request);
  if (!memory?.writer) {
    return { status: "unavailable", reason: "Memory is unavailable" };
  }
  return {
    status: "available",
    value: await memory.store.forget({
      root: memoryScopeRootV1(request.scope, memory.owner, request.projectId),
      fact: request.fact,
      writer: {
        kind: "bot",
        botId: input.botId,
        ...memory.writer,
      },
    }),
  };
}

export async function isolateWorkspaceRead(
  state: ShellBotStateV1,
  input: IsolateCallScopeV1,
): Promise<IsolateWorkspaceOutcomeV1> {
  const files = state.env.WORKSPACE_FILES;
  if (!isolateCallAdmittedV1(state, input) || !files) {
    return { status: "unavailable", reason: "Workspace is unavailable" };
  }
  const path = isolateWorkspacePath(
    input.userId,
    decodeIsolateWorkspacePathV1(input.request),
  );
  return { status: "available", value: await files.read(path) };
}

export async function isolateWorkspaceList(
  state: ShellBotStateV1,
  input: IsolateCallScopeV1,
): Promise<IsolateWorkspaceOutcomeV1> {
  const files = state.env.WORKSPACE_FILES;
  if (!isolateCallAdmittedV1(state, input) || !files) {
    return { status: "unavailable", reason: "Workspace is unavailable" };
  }
  const request = decodeIsolateWorkspaceListRequestV1(input.request);
  const root = isolateWorkspaceRoot(input.userId, request.root);
  return {
    status: "available",
    value: await files.list({
      root,
      ...(request.prefix === undefined ? {} : { prefix: request.prefix }),
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      ...(request.limit === undefined ? {} : { limit: request.limit }),
    }),
  };
}

export async function isolateWorkspaceStat(
  state: ShellBotStateV1,
  input: IsolateCallScopeV1,
): Promise<IsolateWorkspaceOutcomeV1> {
  const files = state.env.WORKSPACE_FILES;
  if (!isolateCallAdmittedV1(state, input) || !files) {
    return { status: "unavailable", reason: "Workspace is unavailable" };
  }
  const path = isolateWorkspacePath(
    input.userId,
    decodeIsolateWorkspacePathV1(input.request),
  );
  return { status: "available", value: await files.stat(path) };
}

export async function isolateWorkspaceWrite(
  state: ShellBotStateV1,
  input: IsolateCallScopeV1,
): Promise<IsolateWorkspaceOutcomeV1> {
  const files = state.env.WORKSPACE_FILES;
  if (!isolateCallAdmittedV1(state, input) || !files) {
    return { status: "unavailable", reason: "Workspace is unavailable" };
  }
  const request = decodeIsolateWorkspaceWriteRequestV1(input.request);
  return {
    status: "available",
    value: await files.write({
      path: isolateWorkspacePath(input.userId, request.path),
      bytes: request.bytes,
      writer: isolateWorkspaceWriter(input),
      expectedGenerationId: request.expectedGenerationId,
      ...(request.mediaType ? { mediaType: request.mediaType } : {}),
    }),
  };
}

export async function isolateWorkspaceDelete(
  state: ShellBotStateV1,
  input: IsolateCallScopeV1,
): Promise<IsolateWorkspaceOutcomeV1> {
  const files = state.env.WORKSPACE_FILES;
  if (!isolateCallAdmittedV1(state, input) || !files) {
    return { status: "unavailable", reason: "Workspace is unavailable" };
  }
  const request = decodeIsolateWorkspaceDeleteRequestV1(input.request);
  return {
    status: "available",
    value: await files.delete({
      path: isolateWorkspacePath(input.userId, request.path),
      writer: isolateWorkspaceWriter(input),
      expectedGenerationId: request.expectedGenerationId,
    }),
  };
}

export async function isolateConnection(
  state: ShellBotStateV1,
  input: IsolateCallScopeV1,
): Promise<IsolateConnectionOutcomeV1> {
  if (
    !isolateCallAdmittedV1(state, input) ||
    typeof input.request !== "string"
  ) {
    return { status: "unavailable", reason: "the Connection is unavailable" };
  }
  const identity = { userId: input.userId, botId: input.botId };
  const user = await userConfigurationV1(state, identity).readConfiguration({
    schemaVersion: 1,
    userId: input.userId,
  });
  const connection = user.connections.find(
    (candidate) =>
      candidate.connectionId === input.request &&
      candidate.state === "ready" &&
      candidate.generation,
  );
  if (!connection?.generation) {
    await state.authority.recordNotification({
      notificationId: notificationIdV1(
        "package-connection-unavailable",
        input.runId,
        input.packageId,
        input.request,
      ),
      runId: input.runId,
      createdAt: new Date().toISOString(),
      title: "Connection unavailable",
      body: `Package "${input.packageId}" could not use Connection "${input.request}". The User can enable or repair it on Connections.`.slice(
        0,
        240,
      ),
    });
    return { status: "unavailable", reason: "the Connection is unavailable" };
  }
  return {
    status: "available",
    leaseId: crypto.randomUUID(),
    connectionId: connection.connectionId,
    generation: connection.generation,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
}

export async function isolateSchedule(
  state: ShellBotStateV1,
  input: IsolateCallScopeV1,
): Promise<IsolateScheduleOutcomeV1> {
  const request = decodeIsolateScheduleRequestV1(input.request);
  return invokeBotToolForIsolateV1(state, {
    ...input,
    request: {
      callId: request.callId,
      name: "routine_manage",
      input: request.input,
    },
  });
}

async function isolateMemoryHost(
  state: ShellBotStateV1,
  input: IsolateCallScopeV1,
  request: { scope: "bot" | "user" | "project"; projectId?: string },
) {
  if (!isolateCallAdmittedV1(state, input)) return undefined;
  const host = createBotMemoryHost(
    { userId: input.userId, botId: input.botId },
    {
      runId: input.runId,
      sessionId: input.sessionId,
      turnId: input.turnId,
    },
    state.env,
  );
  if (!host) return undefined;
  if (request.scope === "project") {
    const projects = await host.projects?.joined();
    if (
      !request.projectId ||
      !projects?.some((project) => project.projectId === request.projectId)
    ) {
      return undefined;
    }
  }
  return host;
}

/**
 * Whether a loopback call is admitted at all: it names the resident Turn, or
 * a standalone call this object registered (a trigger delivery, a section
 * render, a control's press), and that Turn or call mounted the Plugin the
 * scope names. Grants that need nothing but the Bot's own storage or
 * authority gate on this; the `schedule` grant needs the Turn's runtime and
 * gates on {@link activeIsolateTurn}.
 */
function isolateCallAdmittedV1(
  state: ShellBotStateV1,
  input: {
    runId: string;
    sessionId: string;
    turnId: string;
    packageId: string;
    generationId: string;
  },
): boolean {
  if (activeIsolateTurn(state, input)) return true;
  const call = state.turn.standalone(input.runId);
  return (
    call !== undefined &&
    call.sessionId === input.sessionId &&
    call.turnId === input.turnId &&
    call.generationId === input.generationId &&
    call.members.some(
      (member) => member.packageId === input.packageId && member.artifact,
    )
  );
}

function activeIsolateTurn(
  state: ShellBotStateV1,
  input: {
    runId: string;
    sessionId: string;
    turnId: string;
    packageId: string;
    generationId: string;
  },
): ActiveTurnV1 | undefined {
  const active = state.turn.current;
  if (
    !active ||
    active.runId !== input.runId ||
    active.sessionId !== input.sessionId ||
    active.turnId !== input.turnId ||
    active.generationId !== input.generationId ||
    // Every capability call names the Plugin it is for, from the scope the
    // wrapper put on it; the gate is that this generation mounted that Plugin.
    !active.mounted.generation.members.some(
      (member) => member.packageId === input.packageId && member.artifact,
    )
  ) {
    return undefined;
  }
  return active;
}

async function isolateToolEffectId(
  packageId: string,
  callId: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${packageId}\0${callId}`),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `package-tool:${hex}`;
}

function isolateWorkspaceRoot(
  userId: string,
  root: ReturnType<typeof decodeIsolateWorkspacePathV1>["root"],
) {
  return decodeWorkspaceRootV1(
    root.kind === "user-instructions"
      ? { kind: root.kind, userId }
      : root.kind === "bot-instructions"
        ? { kind: root.kind, userId, botId: root.botId }
        : {
            kind: root.kind,
            userId,
            packageId: root.packageId,
            rootId: root.rootId,
          },
  );
}

function isolateWorkspacePath(
  userId: string,
  path: ReturnType<typeof decodeIsolateWorkspacePathV1>,
): WorkspacePathV1 {
  return decodeWorkspacePathV1({
    root: isolateWorkspaceRoot(userId, path.root),
    path: path.path,
  });
}

function isolateWorkspaceWriter(input: IsolateCallScopeV1) {
  return {
    kind: "bot" as const,
    botId: input.botId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    runId: input.runId,
  };
}

function isolateCapabilities(
  state: ShellBotStateV1,
  scope: {
    botId: string;
    packageId: string;
    generationId: string;
  },
  authority: {
    connections: readonly IsolateConnectionV1[];
    model?: IsolateModelBindingV1;
    memory: boolean;
    workspace: boolean;
  },
  model?: { path: IsolateModelPath },
): IsolateCapabilityHost {
  return createIsolateCapabilityHost({
    storage: {
      put: (key, value) => state.ctx.storage.put(key, value),
      list: (options) => state.ctx.storage.list(options),
    },
    botId: scope.botId,
    packageId: scope.packageId,
    generationId: scope.generationId,
    connections: authority.connections,
    ...(authority.model ? { modelBinding: authority.model } : {}),
    ...(model ? { modelPath: model.path } : {}),
    memory: authority.memory,
    workspace: authority.workspace,
  });
}

/**
 * Streams through the pinned Composition's mounted `ctx.llm` — the same
 * provider path a Turn uses, so whichever provider Plugin serves the request is
 * the one that takes the credential lease.
 */
function isolateModelPath(
  state: ShellBotStateV1,
  identity: BotIdentity,
  runtime: {
    agentPackages: FoundationAgentPackage[];
    modelSelection: RuntimeModelSelection;
  },
  generationId: string,
): IsolateModelPath {
  return {
    async *stream(request, signal) {
      const generation = await readPinnedCompositionGenerationV1(
        state,
        identity,
        generationId,
      );
      if (!generation) {
        throw new Error(
          `isolate model invocation pins unknown Composition generation "${generationId}"`,
        );
      }
      const composition = await createShellCompositionHost({
        botId: identity.botId,
        sessionId: `isolate-model:${request.requestId}`,
        billing: state.env.BILLING?.(
          identity.userId,
          identity.botId,
          `isolate-model:${request.requestId}`,
        ),
        sessionEvents: [],
        agentPackages: runtime.agentPackages,
        modelSelection: runtime.modelSelection,
        admitEffect: () => Promise.resolve(true),
      }).mount(generation, signal);
      try {
        yield* composition.runtime.services.llm.stream(request, signal);
      } finally {
        await composition.dispose();
      }
    },
  };
}
