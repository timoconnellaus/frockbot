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
  decodeIsolateWorkspaceDeleteRequestV1,
  decodeIsolateWorkspaceListRequestV1,
  decodeIsolateWorkspacePathV1,
  decodeIsolateWorkspaceWriteRequestV1,
  decodeWorkspacePathV1,
  decodeWorkspaceRootV1,
  type BotCapabilitiesStub,
  type IsolateConnectionOutcomeV1,
  type IsolateConnectionV1,
  type IsolateMemoryOutcomeV1,
  type IsolateModelInvocationV1,
  type IsolateScheduleOutcomeV1,
  type IsolateWorkspaceOutcomeV1,
  type NormalizedModelRequest,
  type WorkspacePathV1,
} from "@frockbot/core/contracts";
import {
  resolveEffectiveBotModelV1,
  type BotSettingsViewV1,
} from "@frockbot/core/configuration";
import type { BotIdentity } from "@frockbot/core/durable";
import { frockbotToolCallV1 } from "@frockbot/core/tools";
import { memoryScopeRootV1 } from "@frockbot/app/memory/roots";
import {
  readBotSettingsV1,
  userConfigurationV1,
} from "@frockbot/app/settings/bot";
import { createShellCompositionHost } from "@frockbot/app/shell/backend-composition";
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
  isolateBindingDigestV1,
  type BotCapabilitiesPropsV1,
  type IsolateCapabilityHost,
  type IsolateModelBindingV1,
  type IsolateModelPath,
} from "./capabilities.js";

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
    settings: BotSettingsViewV1;
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
      };
    }
  ).exports;
  if (!loader || !artifacts || !exports?.BotCapabilities) return undefined;
  const authority = await isolateAuthoritySnapshot(
    state,
    identity,
    turn.settings,
  );
  const mintCapabilities = exports.BotCapabilities;
  return {
    userId: identity.userId,
    runId: turn.runId,
    turnId: turn.runId,
    loader,
    artifacts: createR2PackageArtifactStore(artifacts),
    capabilitiesFor: (member) =>
      mintCapabilities({
        props: {
          userId: identity.userId,
          botId: identity.botId,
          runId: turn.runId,
          sessionId: turn.sessionId,
          turnId: turn.runId,
          generationId: turn.generationId,
          packageId: member.packageId,
          connections: structuredClone(authority.connections),
          ...(authority.model
            ? { model: structuredClone(authority.model) }
            : {}),
          memory: authority.memory,
          workspace: authority.workspace,
        },
      }),
    bindingDigest: await isolateBindingDigestV1({
      userId: identity.userId,
      botId: identity.botId,
      runId: turn.runId,
      connections: authority.connections,
      ...(authority.model ? { model: authority.model } : {}),
      compositionGenerationId: turn.generationId,
    }),
    compatibilityDate: BOT_ISOLATE_COMPATIBILITY_DATE,
  };
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
  if (!activeIsolateTurn(state, input)) {
    return {
      status: "unavailable",
      reason: "the Package is not running in this Bot's active Composition",
    };
  }
  const settings = await readBotSettingsV1(state, identity);
  const authority = await isolateAuthoritySnapshot(state, identity, settings);
  let runtime:
    | {
        agentPackages: FoundationAgentPackage[];
        modelSelection: RuntimeModelSelection;
      }
    | undefined;
  if (authority.model) {
    try {
      runtime = await agentRuntime(state, identity, settings);
    } catch {
      runtime = undefined;
    }
  }
  return isolateCapabilities(
    state,
    {
      botId: identity.botId,
      packageId: input.packageId,
      generationId: input.generationId,
    },
    authority,
    runtime && authority.model
      ? { path: isolateModelPath(state, identity, runtime, input.generationId) }
      : undefined,
  ).invokeModel(input.request);
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
  const active = activeIsolateTurn(state, input);
  const files = state.env.WORKSPACE_FILES;
  if (!active || !files) {
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
  const active = activeIsolateTurn(state, input);
  const files = state.env.WORKSPACE_FILES;
  if (!active || !files) {
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
  const active = activeIsolateTurn(state, input);
  const files = state.env.WORKSPACE_FILES;
  if (!active || !files) {
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
  const active = activeIsolateTurn(state, input);
  const files = state.env.WORKSPACE_FILES;
  if (!active || !files) {
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
  const active = activeIsolateTurn(state, input);
  const files = state.env.WORKSPACE_FILES;
  if (!active || !files) {
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
  if (!activeIsolateTurn(state, input) || typeof input.request !== "string") {
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
  if (!activeIsolateTurn(state, input)) return undefined;
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
      const generation = await state.authority.composition.read(generationId);
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
