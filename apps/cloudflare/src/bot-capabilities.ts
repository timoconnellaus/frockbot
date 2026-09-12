// The loopback CAPABILITIES service binding a Plugin worker sees.
//
// Minted once per User with the User as its only prop. Which Turn, Bot and
// Plugin a call is for arrives on the call as its scope; the Bot Durable Object
// it is routed to resolves that Turn's authority when it is called and refuses
// a scope that is not the Turn it is running. So nothing here can go stale in
// a cached worker, and nothing here can hand out authority the Bot does not
// hold: the stub is an address, not a snapshot.
import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  IsolateCapabilityListOutcomeV1,
  IsolateConnectionOutcomeV1,
  IsolateMemoryOutcomeV1,
  IsolateModelOutcomeV1,
  IsolateScheduleOutcomeV1,
  IsolateScopeV1,
  IsolateSettingsOutcomeV1,
  IsolateStorageListOutcomeV1,
  IsolateStorageOutcomeV1,
  IsolateWorkspaceOutcomeV1,
} from "@frockbot/core/contracts";
import {
  decodeIsolateCapabilityListV1,
  decodeIsolateMemoryReadRequestV1,
  decodeIsolateMemoryWriteRequestV1,
  decodeIsolateModelInvocationV1,
  decodeIsolateScheduleRequestV1,
  decodeIsolateScopeV1,
  decodeIsolateStorageDeleteRequestV1,
  decodeIsolateStorageGetRequestV1,
  decodeIsolateStorageListRequestV1,
  decodeIsolateStoragePutRequestV1,
  decodeIsolateWorkspaceDeleteRequestV1,
  decodeIsolateWorkspaceListRequestV1,
  decodeIsolateWorkspacePathV1,
  decodeIsolateWorkspaceWriteRequestV1,
  decodeNormalizedModelRequestV1,
} from "@frockbot/core/contracts";
import type { BotCapabilitiesPropsV1 } from "@frockbot/app/isolates/capabilities";
import type { BotState } from "./bot-state.js";

function unavailable(reason: string): {
  status: "unavailable";
  reason: string;
} {
  return { status: "unavailable", reason };
}

export type { BotCapabilitiesPropsV1 };

export interface BotCapabilitiesEnv {
  BOT_STATES: DurableObjectNamespace<BotState>;
}

interface BotIsolateRpc {
  isolateAuthority(input: unknown): Promise<unknown>;
  isolateInvokeModel(input: unknown): Promise<unknown>;
  isolateMemoryRead(input: unknown): Promise<IsolateMemoryOutcomeV1>;
  isolateMemoryWrite(input: unknown): Promise<IsolateMemoryOutcomeV1>;
  isolateMemoryForget(input: unknown): Promise<IsolateMemoryOutcomeV1>;
  isolateWorkspaceRead(input: unknown): Promise<IsolateWorkspaceOutcomeV1>;
  isolateWorkspaceList(input: unknown): Promise<IsolateWorkspaceOutcomeV1>;
  isolateWorkspaceStat(input: unknown): Promise<IsolateWorkspaceOutcomeV1>;
  isolateWorkspaceWrite(input: unknown): Promise<IsolateWorkspaceOutcomeV1>;
  isolateWorkspaceDelete(input: unknown): Promise<IsolateWorkspaceOutcomeV1>;
  isolateConnection(input: unknown): Promise<IsolateConnectionOutcomeV1>;
  isolateSchedule(input: unknown): Promise<IsolateScheduleOutcomeV1>;
  isolateStorageGet(input: unknown): Promise<IsolateStorageOutcomeV1>;
  isolateStoragePut(input: unknown): Promise<IsolateStorageOutcomeV1>;
  isolateStorageDelete(input: unknown): Promise<IsolateStorageOutcomeV1>;
  isolateStorageList(input: unknown): Promise<IsolateStorageListOutcomeV1>;
  isolateSettings(input: unknown): Promise<IsolateSettingsOutcomeV1>;
}

export class BotCapabilities extends WorkerEntrypoint<
  BotCapabilitiesEnv,
  BotCapabilitiesPropsV1
> {
  /** The Bot the scope names, which is always one of this User's. */
  private rpc(scope: IsolateScopeV1): BotIsolateRpc {
    const id = this.env.BOT_STATES.idFromName(
      `${this.ctx.props.userId}:${scope.botId}`,
    );
    return this.env.BOT_STATES.get(id) as unknown as BotIsolateRpc;
  }

  /**
   * The envelope every Bot RPC takes. The scope is decoded here — Plugin code
   * wrote it, through the wrapper — and the User comes from the props, which
   * Plugin code cannot forge.
   */
  private scoped(
    rawScope: unknown,
    request: unknown,
  ): { rpc: BotIsolateRpc; envelope: Record<string, unknown> } {
    const scope = decodeIsolateScopeV1(rawScope);
    return {
      rpc: this.rpc(scope),
      envelope: {
        schemaVersion: 1,
        userId: this.ctx.props.userId,
        botId: scope.botId,
        runId: scope.runId,
        sessionId: scope.sessionId,
        turnId: scope.turnId,
        packageId: scope.pluginId,
        generationId: scope.generationId,
        request,
      },
    };
  }

  async list(scope: unknown): Promise<IsolateCapabilityListOutcomeV1> {
    try {
      const { rpc, envelope } = this.scoped(scope, null);
      return decodeIsolateCapabilityListV1(
        await rpc.isolateAuthority(envelope),
      );
    } catch {
      return unavailable("capabilities are unavailable");
    }
  }

  async invokeModel(
    scope: unknown,
    request: unknown,
  ): Promise<IsolateModelOutcomeV1> {
    try {
      const { rpc, envelope } = this.scoped(
        scope,
        decodeNormalizedModelRequestV1(request),
      );
      return decodeIsolateModelInvocationV1(
        await rpc.isolateInvokeModel(envelope),
      );
    } catch {
      return unavailable("the model request could not be served");
    }
  }

  async memoryRead(
    scope: unknown,
    request: unknown,
  ): Promise<IsolateMemoryOutcomeV1> {
    try {
      const { rpc, envelope } = this.scoped(
        scope,
        decodeIsolateMemoryReadRequestV1(request),
      );
      return await rpc.isolateMemoryRead(envelope);
    } catch {
      return unavailable("Memory is unavailable");
    }
  }

  async memoryWrite(
    scope: unknown,
    request: unknown,
  ): Promise<IsolateMemoryOutcomeV1> {
    try {
      const { rpc, envelope } = this.scoped(
        scope,
        decodeIsolateMemoryWriteRequestV1(request),
      );
      return await rpc.isolateMemoryWrite(envelope);
    } catch {
      return unavailable("Memory is unavailable");
    }
  }

  async memoryForget(
    scope: unknown,
    request: unknown,
  ): Promise<IsolateMemoryOutcomeV1> {
    try {
      const { rpc, envelope } = this.scoped(
        scope,
        decodeIsolateMemoryWriteRequestV1(request),
      );
      return await rpc.isolateMemoryForget(envelope);
    } catch {
      return unavailable("Memory is unavailable");
    }
  }

  async workspaceRead(
    scope: unknown,
    request: unknown,
  ): Promise<IsolateWorkspaceOutcomeV1> {
    try {
      const { rpc, envelope } = this.scoped(
        scope,
        decodeIsolateWorkspacePathV1(request),
      );
      return await rpc.isolateWorkspaceRead(envelope);
    } catch {
      return unavailable("Workspace is unavailable");
    }
  }

  async workspaceList(
    scope: unknown,
    request: unknown,
  ): Promise<IsolateWorkspaceOutcomeV1> {
    try {
      const { rpc, envelope } = this.scoped(
        scope,
        decodeIsolateWorkspaceListRequestV1(request),
      );
      return await rpc.isolateWorkspaceList(envelope);
    } catch {
      return unavailable("Workspace is unavailable");
    }
  }

  async workspaceStat(
    scope: unknown,
    request: unknown,
  ): Promise<IsolateWorkspaceOutcomeV1> {
    try {
      const { rpc, envelope } = this.scoped(
        scope,
        decodeIsolateWorkspacePathV1(request),
      );
      return await rpc.isolateWorkspaceStat(envelope);
    } catch {
      return unavailable("Workspace is unavailable");
    }
  }

  async workspaceWrite(
    scope: unknown,
    request: unknown,
  ): Promise<IsolateWorkspaceOutcomeV1> {
    try {
      const { rpc, envelope } = this.scoped(
        scope,
        decodeIsolateWorkspaceWriteRequestV1(request),
      );
      return await rpc.isolateWorkspaceWrite(envelope);
    } catch {
      return unavailable("Workspace is unavailable");
    }
  }

  async workspaceDelete(
    scope: unknown,
    request: unknown,
  ): Promise<IsolateWorkspaceOutcomeV1> {
    try {
      const { rpc, envelope } = this.scoped(
        scope,
        decodeIsolateWorkspaceDeleteRequestV1(request),
      );
      return await rpc.isolateWorkspaceDelete(envelope);
    } catch {
      return unavailable("Workspace is unavailable");
    }
  }

  async connection(
    scope: unknown,
    connectionId: unknown,
  ): Promise<IsolateConnectionOutcomeV1> {
    if (
      typeof connectionId !== "string" ||
      connectionId.length === 0 ||
      connectionId.length > 256
    ) {
      return unavailable("the Connection is unavailable");
    }
    try {
      const { rpc, envelope } = this.scoped(scope, connectionId);
      return await rpc.isolateConnection(envelope);
    } catch {
      return unavailable("the Connection is unavailable");
    }
  }

  async schedule(
    scope: unknown,
    request: unknown,
  ): Promise<IsolateScheduleOutcomeV1> {
    try {
      const { rpc, envelope } = this.scoped(
        scope,
        decodeIsolateScheduleRequestV1(request),
      );
      return await rpc.isolateSchedule(envelope);
    } catch {
      return unavailable("durable scheduling is unavailable");
    }
  }

  async storageGet(
    scope: unknown,
    request: unknown,
  ): Promise<IsolateStorageOutcomeV1> {
    try {
      const { rpc, envelope } = this.scoped(
        scope,
        decodeIsolateStorageGetRequestV1(request),
      );
      return await rpc.isolateStorageGet(envelope);
    } catch {
      return unavailable("storage is unavailable");
    }
  }

  async storagePut(
    scope: unknown,
    request: unknown,
  ): Promise<IsolateStorageOutcomeV1> {
    try {
      const { rpc, envelope } = this.scoped(
        scope,
        decodeIsolateStoragePutRequestV1(request),
      );
      return await rpc.isolateStoragePut(envelope);
    } catch {
      return unavailable("storage is unavailable");
    }
  }

  async storageDelete(
    scope: unknown,
    request: unknown,
  ): Promise<IsolateStorageOutcomeV1> {
    try {
      const { rpc, envelope } = this.scoped(
        scope,
        decodeIsolateStorageDeleteRequestV1(request),
      );
      return await rpc.isolateStorageDelete(envelope);
    } catch {
      return unavailable("storage is unavailable");
    }
  }

  async storageList(
    scope: unknown,
    request: unknown,
  ): Promise<IsolateStorageListOutcomeV1> {
    try {
      const { rpc, envelope } = this.scoped(
        scope,
        decodeIsolateStorageListRequestV1(request ?? {}),
      );
      return await rpc.isolateStorageList(envelope);
    } catch {
      return unavailable("storage is unavailable");
    }
  }

  async settings(scope: unknown): Promise<IsolateSettingsOutcomeV1> {
    try {
      const { rpc, envelope } = this.scoped(scope, null);
      return await rpc.isolateSettings(envelope);
    } catch {
      return unavailable("settings are unavailable");
    }
  }
}
