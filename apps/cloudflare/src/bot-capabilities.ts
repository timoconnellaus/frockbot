// The `CAPABILITIES` binding a Bot isolate sees.
//
// The Worker Loader spike settled the shape: an `RpcTarget` placed in a loaded
// Worker's `env` is rejected with `DataCloneError`, so the capability surface
// must be a loopback *service binding*, minted inside the Durable Object with
// `ctx.exports.BotCapabilities({ props })`. Per-Bot and per-generation state
// therefore travels in `ctx.props`, which is structured-clonable.
//
// `list` answers from those props alone — the Assignments the Bot's Durable
// Object resolved — so nothing here can widen authority. `requestAuthority`
// and `invokeModel` go back to the Bot's Durable Object, which is the only
// authority for the Bot's durable state and the only place a credential lease
// is taken.
import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  IsolateCapabilityDescriptorV1,
  IsolateModelInvocationV1,
  IsolatePendingDecisionV1,
  NormalizedModelRequest,
} from "@frockbot/kernel-contracts";
import {
  decodeIsolateAuthorityRequestV1,
  decodeIsolateCapabilityListV1,
  decodeIsolateModelInvocationV1,
  decodeIsolatePendingDecisionV1,
} from "@frockbot/kernel-contracts";
import type { BotCapabilitiesPropsV1 } from "@frockbot/plugin-shell/backend-isolate";
import type { BotState } from "./bot-state.js";

export type { BotCapabilitiesPropsV1 };

export interface BotCapabilitiesEnv {
  BOT_STATES: DurableObjectNamespace<BotState>;
}

interface BotIsolateRpc {
  isolateRequestAuthority(input: unknown): Promise<unknown>;
  isolateInvokeModel(input: unknown): Promise<unknown>;
}

export class BotCapabilities extends WorkerEntrypoint<
  BotCapabilitiesEnv,
  BotCapabilitiesPropsV1
> {
  private get rpc(): BotIsolateRpc {
    const props = this.ctx.props;
    const id = this.env.BOT_STATES.idFromName(`${props.userId}:${props.botId}`);
    // SAFETY: Wrangler binds BOT_STATES to BotState; workers-types cannot infer
    // its generated RPC surface.
    return this.env.BOT_STATES.get(id) as unknown as BotIsolateRpc;
  }

  /**
   * Assignment-derived only: the enabled Assignments the Bot's Durable Object
   * resolved, projected onto their manifest-declared capability kind. Nothing
   * is read here, so nothing here can widen what the Bot holds.
   */
  list(): Promise<IsolateCapabilityDescriptorV1[]> {
    return Promise.resolve(
      decodeIsolateCapabilityListV1(
        this.ctx.props.assignments.map((assignment) => ({
          capabilityId: assignment.capabilityId,
          kind: assignment.kind,
        })),
      ),
    );
  }

  /** Never a grant. A durable pending decision, recorded in the Bot's authority. */
  async requestAuthority(request: unknown): Promise<IsolatePendingDecisionV1> {
    const props = this.ctx.props;
    return decodeIsolatePendingDecisionV1(
      await this.rpc.isolateRequestAuthority({
        schemaVersion: 1,
        userId: props.userId,
        botId: props.botId,
        packageId: props.packageId,
        generationId: props.generationId,
        request: decodeIsolateAuthorityRequestV1(request),
      }),
    );
  }

  /**
   * D6. The Bot Durable Object checks the model Assignment, records the
   * normalized request and takes the credential lease through the existing
   * provider path before a byte is forwarded; the events come back as an
   * NDJSON byte stream, the only stream shape workerd RPC will carry.
   */
  async invokeModel(request: unknown): Promise<IsolateModelInvocationV1> {
    const props = this.ctx.props;
    return decodeIsolateModelInvocationV1(
      await this.rpc.isolateInvokeModel({
        schemaVersion: 1,
        userId: props.userId,
        botId: props.botId,
        packageId: props.packageId,
        generationId: props.generationId,
        request: request as NormalizedModelRequest,
      }),
    );
  }
}
