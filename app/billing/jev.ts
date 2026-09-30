// What a Jev decision the Computer asks for costs the account, and how it is
// charged.
//
// Jev on Workers AI is priced on input tokens alone; its output is free. The account pays
// twice the provider's rate, as it pays for every other platform-paid
// resource. The tokens are only known once Jev answers, so each request
// reserves a ceiling from its size first — a token is never shorter than a
// byte — and settles on the input tokens Jev reports.
//
// ONE CHARGE PER REQUEST. Each request is keyed by its own effect id, so a
// re-run after an eviction finds the reservation it already made instead of
// reserving again. Turn supervision and the other platform judges are not
// charged: they are the product's own overhead.
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
