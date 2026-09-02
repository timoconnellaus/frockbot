// The `CAPABILITIES` binding a Bot isolate sees.
//
// The Worker Loader spike settled the shape: an `RpcTarget` placed in a loaded
// Worker's `env` is rejected with `DataCloneError`, so the capability surface
// must be a loopback *service binding*, minted inside the Durable Object with
// `ctx.exports.BotCapabilities({ props })`. Per-Bot and per-generation state
// therefore travels in `ctx.props`, which is structured-clonable.
//
// `list` answers from those props alone — the User enablement the Bot's Durable
// Object resolved — so nothing here can widen authority. `requestAuthority`
// and `invokeModel` go back to the Bot's Durable Object, which is the only
// authority for the Bot's durable state and the only place a credential lease
// is taken.
import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  IsolateAuthorityOutcomeV1,
  IsolateCapabilityListOutcomeV1,
  IsolateModelOutcomeV1,
  NormalizedModelRequest,
} from "@frockbot/kernel-contracts";
import {
  decodeIsolateAuthorityRequestV1,
  decodeIsolateCapabilityFailureV1,
  decodeIsolateCapabilityListV1,
  decodeIsolateModelInvocationV1,
  decodeIsolatePendingDecisionV1,
} from "@frockbot/kernel-contracts";
import type { BotCapabilitiesPropsV1 } from "@frockbot/plugin-shell/backend-isolate";
import type { BotState } from "./bot-state.js";

/**
 * A refusal Bot code has a contract for. Every failure on this binding — an
 * invalid request, an unavailable authority, an RPC that did not complete —
 * becomes this one normalized variant rather than an exception carrying host
 * text into the isolate.
 */
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
   * User-enabled only: the account-wide set the Bot's Durable Object resolved,
   * projected onto each manifest-declared capability kind. Nothing is read
   * here, so nothing here can widen what the User granted.
   */
  list(): Promise<IsolateCapabilityListOutcomeV1> {
    try {
      return Promise.resolve(
        decodeIsolateCapabilityListV1(
          this.ctx.props.capabilities.map((capability) => ({
            capabilityId: capability.capabilityId,
            kind: capability.kind,
          })),
        ),
      );
    } catch {
      return Promise.resolve(unavailable("capabilities are unavailable"));
    }
  }

  /** Never a grant. A durable pending decision, recorded in the Bot's authority. */
  async requestAuthority(request: unknown): Promise<IsolateAuthorityOutcomeV1> {
    const props = this.ctx.props;
    try {
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
    } catch {
      return unavailable("the authority request could not be recorded");
    }
  }

  /**
   * D6. The Bot Durable Object checks the enabled model Capability, records the
   * normalized request and takes the credential lease through the existing
   * provider path before a byte is forwarded; the events come back as an
   * NDJSON byte stream, the only stream shape workerd RPC will carry.
   */
  async invokeModel(request: unknown): Promise<IsolateModelOutcomeV1> {
    const props = this.ctx.props;
    try {
      const outcome = await this.rpc.isolateInvokeModel({
        schemaVersion: 1,
        userId: props.userId,
        botId: props.botId,
        packageId: props.packageId,
        generationId: props.generationId,
        request: request as NormalizedModelRequest,
      });
      return typeof outcome === "object" &&
        outcome !== null &&
        "status" in outcome &&
        outcome.status === "unavailable"
        ? decodeIsolateCapabilityFailureV1(outcome)
        : decodeIsolateModelInvocationV1(outcome);
    } catch {
      return unavailable("the model request could not be served");
    }
  }
}
