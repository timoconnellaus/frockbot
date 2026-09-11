import { LlmRegistry } from "@frockbot/core/models";
import {
  ModelProviderFailureError,
  type LlmProvider,
  type LlmStreamEvent,
  type LlmUsageV1,
  type LoopHookListV1,
  type NormalizedModelRequest,
} from "@frockbot/core/contracts";
import { FROCK_AI_PROVIDER_TYPE } from "@frockbot/providers/frock-ai/catalog";
import {
  BillingError,
  BILLING_PLAN,
  type UsageReservation,
  type UsageSettlement,
} from "./ledger.js";

export interface ModelRate {
  inputMicrosPerToken: number;
  cachedInputMicrosPerToken: number;
  outputMicrosPerToken: number;
  maximumInputTokens: number;
  maximumOutputTokens: number;
}
export interface AccountUsage {
  reserve(
    reservation: UsageReservation,
  ): Promise<{ status: "reserved" | "settled" | "released"; created: boolean }>;
  settle(settlement: UsageSettlement): Promise<void>;
}
export interface ModelBilling {
  account: AccountUsage;
  rates: Record<string, ModelRate>;
  botId: string;
  sessionId: string;
}
export function decodeModelRates(
  raw: string | undefined,
): Record<string, ModelRate> {
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new BillingError("Invalid hosted model prices", 503);
  for (const rate of Object.values(parsed)) {
    if (!rate || typeof rate !== "object" || Array.isArray(rate))
      throw new BillingError("Invalid hosted model price", 503);
    for (const key of [
      "inputMicrosPerToken",
      "cachedInputMicrosPerToken",
      "outputMicrosPerToken",
      "maximumInputTokens",
      "maximumOutputTokens",
    ]) {
      const n = (rate as Record<string, unknown>)[key];
      if (
        typeof n !== "number" ||
        !Number.isFinite(n) ||
        n < 0 ||
        n > 1_000_000
      )
        throw new BillingError("Invalid hosted model price", 503);
    }
    const typed = rate as ModelRate;
    if (
      !Number.isSafeInteger(typed.maximumInputTokens) ||
      !Number.isSafeInteger(typed.maximumOutputTokens) ||
      typed.maximumInputTokens < 1 ||
      typed.maximumOutputTokens < 1 ||
      typed.cachedInputMicrosPerToken > typed.inputMicrosPerToken
    )
      throw new BillingError("Invalid hosted model limits", 503);
    if (
      modelCost(
        {
          inputTokens: typed.maximumInputTokens,
          outputTokens: typed.maximumOutputTokens,
        },
        typed,
      ) > 500_000_000_000
    )
      throw new BillingError("Invalid hosted model limits", 503);
  }
  return parsed as Record<string, ModelRate>;
}
export function modelCost(usage: LlmUsageV1, rate: ModelRate) {
  for (const n of [
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedInputTokens ?? 0,
    usage.reasoningTokens ?? 0,
  ])
    if (!Number.isSafeInteger(n) || n < 0)
      throw new BillingError("Invalid reported model usage", 502);
  const cached = usage.cachedInputTokens ?? 0;
  if (
    cached > usage.inputTokens ||
    (usage.reasoningTokens ?? 0) > usage.outputTokens
  )
    throw new BillingError("Invalid reported model usage", 502);
  return Math.ceil(
    (usage.inputTokens - cached) * rate.inputMicrosPerToken +
      cached * rate.cachedInputMicrosPerToken +
      usage.outputTokens * rate.outputMicrosPerToken,
  );
}

/** Meter the actual provider so plugin hooks cannot replace its reported usage. */
export class BilledLlmRegistry extends LlmRegistry {
  constructor(
    hooks: LoopHookListV1,
    private readonly billing: ModelBilling,
  ) {
    super(hooks);
  }
  override register(provider: LlmProvider): () => void {
    const billed = this;
    const wrapped = new Proxy(provider, {
      get(target, property, receiver) {
        if (property === "stream")
          return (request: NormalizedModelRequest, signal: AbortSignal) =>
            billed.billedStream(target.id, request, signal, () =>
              target.stream(request, signal),
            );
        return Reflect.get(target, property, receiver);
      },
    });
    return super.register(wrapped);
  }
  private async *billedStream(
    providerId: string,
    request: NormalizedModelRequest,
    signal: AbortSignal,
    next: () => AsyncIterable<LlmStreamEvent>,
  ): AsyncIterable<LlmStreamEvent> {
    const hosted = providerId === FROCK_AI_PROVIDER_TYPE;
    const rate = hosted ? this.billing.rates[request.model] : undefined;
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
        maximumMicros: maximumCost * 2,
        botId: this.billing.botId,
        sessionId: this.billing.sessionId,
        description: `${request.model}${hosted ? "" : " · own model account"}`,
        pricingVersion: BILLING_PLAN.pricingVersion,
        ...(rate
          ? {
              unitRates: {
                inputMicrosPerToken: rate.inputMicrosPerToken * 2,
                cachedInputMicrosPerToken: rate.cachedInputMicrosPerToken * 2,
                outputMicrosPerToken: rate.outputMicrosPerToken * 2,
              },
            }
          : {}),
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
        if (
          event.type === "text-delta" ||
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
        await this.billing.account.settle({
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
        const cost = rate && usage ? modelCost(usage, rate) : 0;
        await this.billing.account.settle({
          id,
          costMicros: cost,
          chargeMicros: cost * 2,
          quantities: {
            inputTokens: usage?.inputTokens ?? 0,
            outputTokens: usage?.outputTokens ?? 0,
            cachedInputTokens: usage?.cachedInputTokens ?? 0,
            reasoningTokens: usage?.reasoningTokens ?? 0,
          },
        });
      }
    }
  }
}
