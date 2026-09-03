// The loopback CAPABILITIES service binding a Bot isolate sees.
//
// Props carry one per-Bot authority snapshot. Package id is attribution only:
// every Package mounted for this Bot lists the same Connections and model.
import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  IsolateAppletsOutcomeV1,
  IsolateCapabilityListOutcomeV1,
  IsolateConnectionOutcomeV1,
  IsolateMemoryOutcomeV1,
  IsolateModelOutcomeV1,
  IsolateNotificationOutcomeV1,
  IsolateScheduleOutcomeV1,
  IsolateToolOutcomeV1,
  IsolateWorkspaceOutcomeV1,
} from "@frockbot/kernel-contracts";
import {
  decodeIsolateAppletsRequestV1,
  decodeIsolateCapabilityListV1,
  decodeIsolateMemoryReadRequestV1,
  decodeIsolateMemoryWriteRequestV1,
  decodeIsolateModelInvocationV1,
  decodeIsolateNotificationRequestV1,
  decodeIsolateScheduleRequestV1,
  decodeIsolateToolRequestV1,
  decodeIsolateWorkspaceDeleteRequestV1,
  decodeIsolateWorkspaceListRequestV1,
  decodeIsolateWorkspacePathV1,
  decodeIsolateWorkspaceWriteRequestV1,
  decodeNormalizedModelRequestV1,
} from "@frockbot/kernel-contracts";
import {
  matchesAdmittedConnectionV1,
  type BotCapabilitiesPropsV1,
} from "@frockbot/plugin-shell/backend-isolate";
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
  isolateInvokeModel(input: unknown): Promise<unknown>;
  isolateInvokeTool(input: unknown): Promise<IsolateToolOutcomeV1>;
  isolateMemoryRead(input: unknown): Promise<IsolateMemoryOutcomeV1>;
  isolateMemoryWrite(input: unknown): Promise<IsolateMemoryOutcomeV1>;
  isolateMemoryForget(input: unknown): Promise<IsolateMemoryOutcomeV1>;
  isolateWorkspaceRead(input: unknown): Promise<IsolateWorkspaceOutcomeV1>;
  isolateWorkspaceList(input: unknown): Promise<IsolateWorkspaceOutcomeV1>;
  isolateWorkspaceStat(input: unknown): Promise<IsolateWorkspaceOutcomeV1>;
  isolateWorkspaceWrite(input: unknown): Promise<IsolateWorkspaceOutcomeV1>;
  isolateWorkspaceDelete(input: unknown): Promise<IsolateWorkspaceOutcomeV1>;
  isolateConnection(input: unknown): Promise<IsolateConnectionOutcomeV1>;
  isolateNotify(input: unknown): Promise<IsolateNotificationOutcomeV1>;
  isolateSchedule(input: unknown): Promise<IsolateScheduleOutcomeV1>;
  isolateApplets(input: unknown): Promise<IsolateAppletsOutcomeV1>;
}

export class BotCapabilities extends WorkerEntrypoint<
  BotCapabilitiesEnv,
  BotCapabilitiesPropsV1
> {
  private get rpc(): BotIsolateRpc {
    const props = this.ctx.props;
    const id = this.env.BOT_STATES.idFromName(`${props.userId}:${props.botId}`);
    return this.env.BOT_STATES.get(id) as unknown as BotIsolateRpc;
  }

  private scope(request: unknown): Record<string, unknown> {
    const props = this.ctx.props;
    return {
      schemaVersion: 1,
      userId: props.userId,
      botId: props.botId,
      runId: props.runId,
      sessionId: props.sessionId,
      turnId: props.turnId,
      packageId: props.packageId,
      generationId: props.generationId,
      request,
    };
  }

  list(): Promise<IsolateCapabilityListOutcomeV1> {
    try {
      return Promise.resolve(
        decodeIsolateCapabilityListV1({
          status: "available",
          connections: this.ctx.props.connections,
          ...(this.ctx.props.model ? { model: this.ctx.props.model } : {}),
          tools: true,
          memory: this.ctx.props.memory,
          workspace: this.ctx.props.workspace,
          notify: true,
          schedule: true,
        }),
      );
    } catch {
      return Promise.resolve(unavailable("capabilities are unavailable"));
    }
  }

  async invokeModel(request: unknown): Promise<IsolateModelOutcomeV1> {
    try {
      const decoded = decodeNormalizedModelRequestV1(request);
      const admitted = this.ctx.props.model;
      if (
        !admitted ||
        decoded.provider !== admitted.provider ||
        decoded.model !== admitted.providerModelId
      ) {
        return unavailable("the model is unavailable");
      }
      return decodeIsolateModelInvocationV1(
        await this.rpc.isolateInvokeModel(
          this.scope({
            ...decoded,
            modelBinding: {
              connectionId: admitted.connectionId,
              connectionGeneration: admitted.connectionGeneration,
              ...(admitted.catalogGeneration
                ? { catalogGeneration: admitted.catalogGeneration }
                : {}),
            },
          }),
        ),
      );
    } catch {
      return unavailable("the model request could not be served");
    }
  }

  async invokeTool(request: unknown): Promise<IsolateToolOutcomeV1> {
    try {
      return await this.rpc.isolateInvokeTool(
        this.scope(decodeIsolateToolRequestV1(request)),
      );
    } catch {
      return unavailable("the tool request could not be served");
    }
  }

  async memoryRead(request: unknown): Promise<IsolateMemoryOutcomeV1> {
    try {
      return await this.rpc.isolateMemoryRead(
        this.scope(decodeIsolateMemoryReadRequestV1(request)),
      );
    } catch {
      return unavailable("Memory is unavailable");
    }
  }

  async memoryWrite(request: unknown): Promise<IsolateMemoryOutcomeV1> {
    try {
      return await this.rpc.isolateMemoryWrite(
        this.scope(decodeIsolateMemoryWriteRequestV1(request)),
      );
    } catch {
      return unavailable("Memory is unavailable");
    }
  }

  async memoryForget(request: unknown): Promise<IsolateMemoryOutcomeV1> {
    try {
      return await this.rpc.isolateMemoryForget(
        this.scope(decodeIsolateMemoryWriteRequestV1(request)),
      );
    } catch {
      return unavailable("Memory is unavailable");
    }
  }

  async workspaceRead(request: unknown): Promise<IsolateWorkspaceOutcomeV1> {
    try {
      return await this.rpc.isolateWorkspaceRead(
        this.scope(decodeIsolateWorkspacePathV1(request)),
      );
    } catch {
      return unavailable("Workspace is unavailable");
    }
  }

  async workspaceList(request: unknown): Promise<IsolateWorkspaceOutcomeV1> {
    try {
      return await this.rpc.isolateWorkspaceList(
        this.scope(decodeIsolateWorkspaceListRequestV1(request)),
      );
    } catch {
      return unavailable("Workspace is unavailable");
    }
  }

  async workspaceStat(request: unknown): Promise<IsolateWorkspaceOutcomeV1> {
    try {
      return await this.rpc.isolateWorkspaceStat(
        this.scope(decodeIsolateWorkspacePathV1(request)),
      );
    } catch {
      return unavailable("Workspace is unavailable");
    }
  }

  async workspaceWrite(request: unknown): Promise<IsolateWorkspaceOutcomeV1> {
    try {
      return await this.rpc.isolateWorkspaceWrite(
        this.scope(decodeIsolateWorkspaceWriteRequestV1(request)),
      );
    } catch {
      return unavailable("Workspace is unavailable");
    }
  }

  async workspaceDelete(request: unknown): Promise<IsolateWorkspaceOutcomeV1> {
    try {
      return await this.rpc.isolateWorkspaceDelete(
        this.scope(decodeIsolateWorkspaceDeleteRequestV1(request)),
      );
    } catch {
      return unavailable("Workspace is unavailable");
    }
  }

  async connection(connectionId: unknown): Promise<IsolateConnectionOutcomeV1> {
    if (
      typeof connectionId !== "string" ||
      connectionId.length === 0 ||
      connectionId.length > 256
    ) {
      return unavailable("the Connection is unavailable");
    }
    const admitted = this.ctx.props.connections.find(
      (connection) => connection.connectionId === connectionId,
    );
    try {
      const outcome = await this.rpc.isolateConnection(
        this.scope(connectionId),
      );
      if (!matchesAdmittedConnectionV1(admitted, outcome)) {
        return unavailable("the Connection is unavailable");
      }
      return outcome;
    } catch {
      return unavailable("the Connection is unavailable");
    }
  }

  async notify(request: unknown): Promise<IsolateNotificationOutcomeV1> {
    try {
      return await this.rpc.isolateNotify(
        this.scope(decodeIsolateNotificationRequestV1(request)),
      );
    } catch {
      return unavailable("notifications are unavailable");
    }
  }

  /**
   * The Applet capability (ADR 0022). Account-wide, so it carries no narrower
   * grant than the rest of `env`: an Applet is the User's, and every Bot of
   * that User sees the same directory.
   */
  async applets(request: unknown): Promise<IsolateAppletsOutcomeV1> {
    try {
      return await this.rpc.isolateApplets(
        this.scope(decodeIsolateAppletsRequestV1(request)),
      );
    } catch {
      return unavailable("Applets are unavailable");
    }
  }

  async schedule(request: unknown): Promise<IsolateScheduleOutcomeV1> {
    try {
      return await this.rpc.isolateSchedule(
        this.scope(decodeIsolateScheduleRequestV1(request)),
      );
    } catch {
      return unavailable("durable scheduling is unavailable");
    }
  }
}
