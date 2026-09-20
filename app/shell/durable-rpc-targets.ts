import type { ConfigurationCommandV1 } from "@frockbot/core/configuration";
import type { AppletToolDeclarationV1 } from "@frockbot/core/contracts";
import type { AppletProvenanceV1 } from "@frockbot/core/contracts";
import type { MachineCommandV1 } from "@frockbot/core/machine-protocol";
import type { TemplateCommandV1 } from "@frockbot/app/bot-template/shared";
import type {
  BotLookV1,
  CreateBotCommandV1,
  ThemeDocumentV1,
  UpdateVoiceCommandV1,
} from "@frockbot/app/flock/shared";
import type { SubagentDurableObjectRpcTargetV1 } from "@frockbot/app/subagents/durable-binding";
import type { SubagentSlotRequestV1 } from "@frockbot/app/subagents/quota";

type RpcEnvelopeV1<T extends object> = T & { schemaVersion: 1 };
type UserRpcEnvelopeV1<T extends object = object> = RpcEnvelopeV1<
  T & { userId: string }
>;
type BotRpcEnvelopeV1<T extends object = object> = UserRpcEnvelopeV1<
  T & { botId: string }
>;

/**
 * The User Durable Object methods a Bot Durable Object may call.
 *
 * Keeping this on the app side makes the namespace itself prove the RPC
 * surface. Call sites no longer assert a hand-written method bag after
 * `get()`, and the Cloudflare Durable Object class must remain structurally
 * compatible when it is supplied as a {@link BotStateEnv}.
 */
export interface BotUserConfigurationRpcTargetV1
  extends Rpc.DurableObjectBranded {
  readFeatures(input: UserRpcEnvelopeV1): Promise<object>;
  readConfiguration(input: UserRpcEnvelopeV1<{ view: 2 }>): Promise<object>;
  executeConfiguration(
    input: UserRpcEnvelopeV1<{
      command: Extract<ConfigurationCommandV1, { type: `user/${string}` }>;
    }>,
  ): Promise<object>;
  leaseModelCredential(
    input: UserRpcEnvelopeV1<{
      connectionId: string;
      providerModelId: string;
      effectId: string;
      connectionGeneration: string;
    }>,
  ): Promise<unknown>;
  settleModelCredential(
    input: UserRpcEnvelopeV1<{
      connectionId: string;
      packageId: string;
      effectId: string;
    }>,
  ): Promise<void>;
  leaseToolCredential(
    input: UserRpcEnvelopeV1<{
      connectionId: string;
      effectId: string;
      connectionGeneration: string;
    }>,
  ): Promise<unknown>;
  settleToolCredential(
    input: UserRpcEnvelopeV1<{ connectionId: string; effectId: string }>,
  ): Promise<void>;
  listBots(input: UserRpcEnvelopeV1): Promise<object>;
  createBot(
    input: UserRpcEnvelopeV1<{ command: CreateBotCommandV1 }>,
  ): Promise<object>;
  readBotVoice(input: BotRpcEnvelopeV1): Promise<object>;
  updateBotVoice(
    input: BotRpcEnvelopeV1<{ command: UpdateVoiceCommandV1 }>,
  ): Promise<object>;
  mirrorBotLook(
    input: BotRpcEnvelopeV1<{
      look: BotLookV1;
      document?: ThemeDocumentV1;
    }>,
  ): Promise<object>;
  executeTemplateCommand(
    input: UserRpcEnvelopeV1<{ command: TemplateCommandV1 }>,
  ): Promise<object>;
  listMachines(input: UserRpcEnvelopeV1): Promise<object>;
  describeMachineTarget(
    input: UserRpcEnvelopeV1<{ machineId: string }>,
  ): Promise<object>;
  dispatchMachineCommand(
    input: UserRpcEnvelopeV1<{ command: MachineCommandV1 }>,
  ): Promise<object>;
  readMachineResult(
    input: UserRpcEnvelopeV1<{ commandId: string }>,
  ): Promise<object | undefined>;
  reserveSubagentSlot(input: SubagentSlotRequestV1): Promise<object>;
  releaseSubagentSlot(
    input: Omit<SubagentSlotRequestV1, "reservedAt">,
  ): Promise<{ schemaVersion: 1; status: "released"; held: number }>;
  reserveAgentTurnSlot(
    input: UserRpcEnvelopeV1<{
      requesterId: string;
      runId: string;
      reservedAt: string;
    }>,
  ): Promise<object>;
  releaseAgentTurnSlot(
    input: UserRpcEnvelopeV1<{ requesterId: string; runId: string }>,
  ): Promise<{ schemaVersion: 1; status: "released"; held: number }>;
  listApplets(input: BotRpcEnvelopeV1): Promise<object>;
  readApplet(
    input: BotRpcEnvelopeV1<{ appletId: string; owner?: boolean }>,
  ): Promise<object>;
  readAppletCompositionInput(input: UserRpcEnvelopeV1): Promise<object>;
  readAppletToolNameClashes(
    input: UserRpcEnvelopeV1<{ appletId: string; names: string[] }>,
  ): Promise<string[]>;
  createApplet(
    input: BotRpcEnvelopeV1<{
      displayName: string;
      provenance: AppletProvenanceV1;
    }>,
  ): Promise<object>;
  recordAppletGeneration(
    input: BotRpcEnvelopeV1<{
      appletId: string;
      generationId: string;
      tools: AppletToolDeclarationV1[];
    }>,
  ): Promise<object>;
  deleteApplet(input: BotRpcEnvelopeV1<{ appletId: string }>): Promise<object>;
  shareApplet(
    input: BotRpcEnvelopeV1<{ appletId: string; targetBotId: string }>,
  ): Promise<object>;
  unshareApplet(
    input: BotRpcEnvelopeV1<{ appletId: string; targetBotId: string }>,
  ): Promise<object>;
  transferApplet(
    input: BotRpcEnvelopeV1<{ appletId: string; targetBotId: string }>,
  ): Promise<object>;
  listConnectTriggers(input: UserRpcEnvelopeV1): Promise<object>;
  upsertConnectTrigger(
    input: UserRpcEnvelopeV1<{
      commandId: string;
      botId: string;
      routineId: string;
      connectionId: string;
      triggerType: string;
      config?: Record<string, string | number | boolean>;
    }>,
  ): Promise<{ instanceId: string; routineId: string }>;
  deleteConnectTrigger(
    input: UserRpcEnvelopeV1<{
      commandId: string;
      botId: string;
      routineId: string;
    }>,
  ): Promise<void>;
}

export interface BotStateRpcTargetV1 extends SubagentDurableObjectRpcTargetV1 {
  runAgent(input: {
    schemaVersion: 1;
    userId: string;
    botId: string;
    command: {
      runId: string;
      sessionId: string;
      acceptedAt: string;
      text: string;
      source: {
        kind: "bot";
        fromBotId: string;
        fromBotName: string;
        messageId: string;
      };
    };
  }): Promise<object>;
}

export type BotUserConfigurationNamespaceV1 =
  DurableObjectNamespace<BotUserConfigurationRpcTargetV1>;
export type BotStateNamespaceV1 = DurableObjectNamespace<BotStateRpcTargetV1>;

/** Keeps the Durable Object class and the app-owned RPC contract in lockstep. */
export type AssertRpcTargetV1<
  Target extends Rpc.DurableObjectBranded,
  Implementation extends Target,
> = Implementation;
