// What a Jev decision costs the account, and how it is charged.
//
// Jev on Workers AI is priced on input tokens alone; its output is free. The account pays
// twice the provider's rate, as it pays for every other platform-paid
// resource. The tokens are only known once Jev answers, so each request
// reserves a ceiling from its size first — a token is never shorter than a
// byte — and settles on the input tokens Jev reports.
//
// ONE CHARGE PER REQUEST. Each request is keyed by its own effect id, so a
// re-run after an eviction finds the reservation it already made instead of
// reserving again.
//
// Jev the Computer asks for is always the account's. Turn supervision is the
// product's own overhead, charged only on a plan with a Jev fair-use
// allowance, and there first from that allowance. The other platform judges
// are overhead on every plan.
import type { Fetch } from "@typesafe-ai/sdk";
import { BillingError } from "./errors.js";
import type { AccountUsage } from "./model.js";

export const JEV_TARIFF = {
  /** US$0.042 per million input tokens, in micro-dollars per token. */
  providerMicrosPerInputToken: 0.042,
  microsPerInputToken: 0.084,
} as const;

/** A new tariff is a new version, so a past charge keeps its explanation. */
export const JEV_PRICING_VERSION = "jev-2026-09-27";

export const JEV_RATE_DESCRIPTION =
  "Jev decisions · US$0.084 per million input tokens";

// Micro-dollars per thousand input tokens, so the arithmetic stays whole:
// 0.042 × 1,500 in floating point rounds up to 64.
const PROVIDER_MICROS_PER_THOUSAND_TOKENS = 42;
const MICROS_PER_THOUSAND_TOKENS = 84;

/** Whole micro-dollars, rounded up: a balance holds no fractions. */
export function jevChargeMicrosV1(inputTokens: number): number {
  return Math.ceil((inputTokens * MICROS_PER_THOUSAND_TOKENS) / 1_000);
}

/** One request's reserved charge, settled once Jev has answered. */
export interface JevChargeV1 {
  /** Jev answered; it counted these input tokens. */
  charge(inputTokens: number): Promise<void>;
  /** Jev refused the request, so nothing was spent. */
  release(): Promise<void>;
}

export interface JevMeterV1 {
  /**
   * Hold the most a request of `maximumInputTokens` could cost before Jev is
   * asked. Throws the account's own refusal when it cannot spend, so no
   * request runs unpaid.
   */
  reserve(request: {
    effectId: string;
    botId: string;
    sessionId: string;
    maximumInputTokens: number;
  }): Promise<JevChargeV1>;
}

const NOTHING_TO_SETTLE: JevChargeV1 = {
  charge: () => Promise.resolve(),
  release: () => Promise.resolve(),
};

export function createJevMeterV1(account: AccountUsage): JevMeterV1 {
  return {
    async reserve(request) {
      const id = `jev:${request.effectId}`;
      const maximumMicros = jevChargeMicrosV1(request.maximumInputTokens);
      const reservation = await account.reserve({
        id,
        kind: "jev",
        maximumMicros,
        botId: request.botId,
        sessionId: request.sessionId,
        description: JEV_RATE_DESCRIPTION,
        pricingVersion: JEV_PRICING_VERSION,
        unitRates: { microsPerInputToken: JEV_TARIFF.microsPerInputToken },
      });
      // An earlier run under this id already charged or released it. This
      // re-run is the same request, so it is not billed again either way.
      if (reservation.status !== "reserved") return NOTHING_TO_SETTLE;
      return {
        charge: (inputTokens) =>
          account.settle({
            id,
            costMicros: Math.ceil(
              (inputTokens * PROVIDER_MICROS_PER_THOUSAND_TOKENS) / 1_000,
            ),
            // Never above the hold: Jev counting past the request's own
            // bytes would be Jev's error, not a charge to pass on.
            chargeMicros: Math.min(
              maximumMicros,
              jevChargeMicrosV1(inputTokens),
            ),
            quantities: { inputTokens },
          }),
        release: () =>
          account.settle({
            id,
            costMicros: 0,
            chargeMicros: 0,
            quantities: { inputTokens: 0 },
          }),
      };
    },
  };
}

/**
 * Jev's own framing of a request costs tokens its body does not show, so a
 * hold covers it on top of the body's bytes.
 */
const JEV_FRAMING_TOKENS_V1 = 1_000;

/**
 * A `fetch` for the Jev the product asks for itself — Turn supervision — that
 * meters each request where the account's plan has a Jev fair-use allowance.
 * Every other plan covers it in full, and the ledger answers `covered`
 * without recording anything.
 *
 * Each request is its own charge under a fresh key: a retry, or a re-run
 * after an eviction, is another request Jev answers and counts. The hold is
 * taken before Jev is asked; an account that cannot pay gets a 402 carrying
 * the ledger's sentence, which the Turn's failure shows as written. Jev's
 * refusal releases the hold, and an answer that never arrived leaves it for
 * reconciliation, as the terminal's Jev does.
 */
export function createPlatformJevFetchV1(config: {
  account: AccountUsage;
  botId: string;
  sessionId: string;
  fetch?: Fetch;
  /** A fresh request id; tests name their own. */
  requestId?: () => string;
}): Fetch {
  const send = config.fetch ?? ((input, init) => fetch(input, init));
  const requestId = config.requestId ?? (() => crypto.randomUUID());
  return async (input, init) => {
    const body = init?.body;
    const bytes =
      typeof body === "string"
        ? new TextEncoder().encode(body).byteLength
        : ArrayBuffer.isView(body) || body instanceof ArrayBuffer
          ? body.byteLength
          : undefined;
    // The SDK sends JSON text. A body this cannot measure has no ceiling to
    // hold, so it is not sent unpaid.
    if (bytes === undefined) throw new Error("Unmeasurable Jev request body");
    const id = `jev:turn:${requestId()}`;
    const maximumMicros = jevChargeMicrosV1(bytes + JEV_FRAMING_TOKENS_V1);
    let reservation;
    try {
      reservation = await config.account.reserve({
        id,
        kind: "jev",
        platform: true,
        maximumMicros,
        botId: config.botId,
        sessionId: config.sessionId,
        description: JEV_RATE_DESCRIPTION,
        pricingVersion: JEV_PRICING_VERSION,
        unitRates: { microsPerInputToken: JEV_TARIFF.microsPerInputToken },
      });
    } catch (error) {
      if (!(error instanceof BillingError)) throw error;
      return Response.json({ message: error.message }, { status: 402 });
    }
    if (reservation.status !== "reserved") return send(input, init);
    const response = await send(input, init);
    if (!response.ok) {
      if (response.status < 500)
        await config.account.settle({
          id,
          costMicros: 0,
          chargeMicros: 0,
          quantities: { inputTokens: 0 },
        });
      return response;
    }
    const answered = (await response
      .clone()
      .json()
      .catch(() => undefined)) as
      { usage?: { input_tokens?: unknown } } | undefined;
    const inputTokens = answered?.usage?.input_tokens;
    // An answer that does not say what it counted is not billed on a guess.
    if (!Number.isSafeInteger(inputTokens) || (inputTokens as number) < 0)
      return response;
    await config.account.settle({
      id,
      costMicros: Math.ceil(
        ((inputTokens as number) * PROVIDER_MICROS_PER_THOUSAND_TOKENS) / 1_000,
      ),
      chargeMicros: Math.min(
        maximumMicros,
        jevChargeMicrosV1(inputTokens as number),
      ),
      quantities: { inputTokens: inputTokens as number },
    });
    return response;
  };
}
