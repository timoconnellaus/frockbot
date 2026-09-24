import { LlmRegistry } from "@frockbot/core/models";
import {
  ModelProviderFailureError,
  type LlmProvider,
  type LlmStreamEvent,
  type LlmUsageV1,
  type LoopHookListV1,
  type ModelAttachmentResolverV1,
  type NormalizedModelRequest,
} from "@frockbot/core/contracts";
import { FROCK_AI_PROVIDER_TYPE } from "@frockbot/providers/frock-ai/catalog";
import {
  frockAiServedModelV1,
  type FrockAiServedModelV1,
} from "@frockbot/providers/frock-ai/runtime";
import {
  BILLING_PLAN,
  type UsageReservation,
  type UsageSettlement,
} from "./ledger.js";
import {
  modelCost,
  modelRatesPricingVersionV1,
  routeRateV1,
  servedRateV1,
  type HostedModelRatesV1,
  type ModelRate,
  type ServedModelRateV1,
} from "./rates.js";

export interface AccountUsage {
  reserve(
    reservation: UsageReservation,
  ): Promise<{ status: "reserved" | "settled" | "released"; created: boolean }>;
  settle(settlement: UsageSettlement): Promise<void>;
}
export interface ModelBilling {
  account: AccountUsage;
  /** The deployment's current hosted model rate table. */
  rates(): Promise<HostedModelRatesV1>;
  /**
   * Told when a hosted call settled at its route's ceiling because the model
   * that answered has no rate, so the administrator can price it. Never
   * awaited: a missing price is already recorded on the settlement.
   */
  reportUnpriced?(report: {
    servedModel: string | null;
    route: string;
    version: number;
  }): void;
  /** Told each settlement as it lands, for a caller that shows the charge. */
  settled?(settlement: UsageSettlement): void;
  botId: string;
  sessionId: string;
  /**
   * Who inside the Bot made the call, when it was not the Bot's own loop —
   * a Plugin, named on the operation's description (ADR 0026).
   */
  attribution?: string;
}

/** What the account pays for a call that cost the deployment `costMicros`. */
export function modelCharge(costMicros: number) {
  return costMicros * 2;
}

function customerRates(rate: ServedModelRateV1): Record<string, number> {
  return {
    inputMicrosPerToken: rate.inputMicrosPerToken * 2,
    cachedInputMicrosPerToken: rate.cachedInputMicrosPerToken * 2,
    outputMicrosPerToken: rate.outputMicrosPerToken * 2,
  };
}

/**
 * Price one hosted call: at the model that answered, never above the ceiling
 * its requested model reserved against.
 *
 * A Gateway cache hit ran no provider and costs nothing. A model the table
 * does not price — or an answer that did not say which model it was — is
 * charged at the ceiling and marked `unpriced` so it is seen and priced.
 */
export function priceHostedUsageV1(
  usage: LlmUsageV1,
  ceiling: ModelRate,
  table: HostedModelRatesV1,
  served: FrockAiServedModelV1 | undefined,
): Pick<
  UsageSettlement,
  "costMicros" | "chargeMicros" | "pricing" | "servedModel" | "unitRates"
> {
  const servedModel = served?.model ? { servedModel: served.model } : {};
  if (served?.cached)
    return {
      costMicros: 0,
      chargeMicros: 0,
      pricing: "cached",
      ...servedModel,
    };
  const ceilingCost = modelCost(usage, ceiling);
  const rate = served?.model ? servedRateV1(table, served.model) : undefined;
  if (!rate)
    return {
      costMicros: ceilingCost,
      chargeMicros: modelCharge(ceilingCost),
      pricing: "unpriced",
      ...servedModel,
      unitRates: customerRates(ceiling),
    };
  const cost = modelCost(usage, rate);
  // A served model priced above its route is a table to fix, not a charge
  // above what the account was quoted and reserved against.
  return cost > ceilingCost
    ? {
        costMicros: cost,
        chargeMicros: modelCharge(ceilingCost),
        pricing: "capped",
        ...servedModel,
        unitRates: customerRates(ceiling),
      }
    : {
        costMicros: cost,
        chargeMicros: modelCharge(cost),
        pricing: "served",
        ...servedModel,
        unitRates: customerRates(rate),
      };
}

/** Meter the actual provider so plugin hooks cannot replace its reported usage. */
export class BilledLlmRegistry extends LlmRegistry {
  constructor(
    hooks: LoopHookListV1,
    private readonly billing: ModelBilling,
    attachments?: ModelAttachmentResolverV1,
  ) {
    super(hooks, attachments);
  }
  override register(provider: LlmProvider): () => void {
    const billed = this;
    const wrapped = new Proxy(provider, {
      get(target, property, receiver) {
        if (property === "stream")
          return (request: NormalizedModelRequest, signal: AbortSignal) =>
            billed.billedStream(
              target.id,
              request,
              () => target.stream(request, signal),
              () => frockAiServedModelV1(target, request),
            );
        return Reflect.get(target, property, receiver);
      },
    });
    return super.register(wrapped);
  }
  private async hostedRates(): Promise<HostedModelRatesV1> {
    try {
      return await this.billing.rates();
    } catch {
      throw new ModelProviderFailureError({
        classification: "transient",
        reason:
          "Hosted model prices could not be read just now. No credit was used; try again in a moment.",
      });
    }
  }
  private async *billedStream(
    providerId: string,
    request: NormalizedModelRequest,
    next: () => AsyncIterable<LlmStreamEvent>,
    served: () => FrockAiServedModelV1 | undefined,
  ): AsyncIterable<LlmStreamEvent> {
    const hosted = providerId === FROCK_AI_PROVIDER_TYPE;
    // Read once: the reservation and its settlement are priced from the same
    // version, and that version is what the operation records.
    const table = hosted ? await this.hostedRates() : undefined;
    const rate = table ? routeRateV1(table, request.model) : undefined;
    if (hosted && !rate)
      throw new ModelProviderFailureError({
        classification: "permanent",
        reason:
          "This hosted model does not have a published usage rate yet. Choose a connected model or try again later.",
      });
    const id = `model:${request.requestId}`;
    const maximumCost = rate
      ? modelCost(
          {
            inputTokens: rate.maximumInputTokens,
            outputTokens: rate.maximumOutputTokens,
          },
          rate,
        )
      : 0;
    let reservation;
    try {
      reservation = await this.billing.account.reserve({
        id,
        kind: "model",
        maximumMicros: modelCharge(maximumCost),
        botId: this.billing.botId,
        sessionId: this.billing.sessionId,
        description: `${request.model}${hosted ? "" : " · own model account"}${
          this.billing.attribution ? ` · ${this.billing.attribution}` : ""
        }`,
        pricingVersion: table
          ? modelRatesPricingVersionV1(table.version)
          : BILLING_PLAN.pricingVersion,
        ...(rate ? { unitRates: customerRates(rate) } : {}),
      });
    } catch (error) {
      throw new ModelProviderFailureError({
        classification: "permanent",
        reason:
          error instanceof Error
            ? error.message
            : "Billing could not authorize this model call",
      });
    }
    if (!reservation.created)
      throw new ModelProviderFailureError({
        classification: "permanent",
        reason:
          "This model call was already dispatched. Its payment outcome is retained; start a new turn to continue.",
      });
    let usage: LlmUsageV1 | undefined;
    let complete = false;
    let partialData = false;
    try {
      for await (const event of next()) {
        // A tool call's arguments streaming is the model writing, as much as
        // text is: a stream that fails part-way through one was billable.
        if (
          event.type === "text-delta" ||
          event.type === "tool-input-delta" ||
          event.type === "tool-call" ||
          event.type === "usage"
        )
          partialData = true;
        if (event.type === "usage") usage = structuredClone(event.usage);
        yield event;
      }
      complete = true;
    } catch (error) {
      if (error instanceof ModelProviderFailureError && !partialData)
        await this.settle({
          id,
          costMicros: 0,
          chargeMicros: 0,
          quantities: {},
        });
      throw error;
    } finally {
      // Missing/partial provider usage is not a customer bill. Keep its reservation
      // for reconciliation; a transport failure must not manufacture token counts.
      if (complete && (usage || !hosted)) {
        const price =
          table && rate && usage
            ? priceHostedUsageV1(usage, rate, table, served())
            : { costMicros: 0, chargeMicros: 0 };
        await this.settle({
          id,
          ...price,
          quantities: {
            inputTokens: usage?.inputTokens ?? 0,
            outputTokens: usage?.outputTokens ?? 0,
            cachedInputTokens: usage?.cachedInputTokens ?? 0,
            reasoningTokens: usage?.reasoningTokens ?? 0,
          },
        });
        if (table && "pricing" in price && price.pricing === "unpriced")
          try {
            this.billing.reportUnpriced?.({
              servedModel: price.servedModel ?? null,
              route: request.model,
              version: table.version,
            });
          } catch {
            // The settlement already carries the flag; the report is a courtesy.
          }
      }
    }
  }
  private async settle(settlement: UsageSettlement) {
    await this.billing.account.settle(settlement);
    this.billing.settled?.(settlement);
  }
}
