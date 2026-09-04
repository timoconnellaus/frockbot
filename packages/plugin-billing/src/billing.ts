export const BASIC_ALLOWANCE_MICROS_V1 = 20_000_000;
export const CREDIT_CUSTOM_MIN_CENTS_V1 = 500;
export const CREDIT_CUSTOM_MAX_CENTS_V1 = 100_000;
export const BILLING_HISTORY_MAX_ROWS_V1 = 200;

export type BillingPlanV1 = "none" | "basic";

export interface BillingHistoryEntryV1 {
  eventId: string;
  type: string;
  occurredAt: string;
  amountMicros: number;
  description: string;
}

export interface BillingViewV1 {
  schemaVersion: 1;
  plan: BillingPlanV1;
  subscriptionStatus: string;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  allowanceMicros: number;
  allowanceUsedMicros: number;
  allowanceRemainingMicros: number;
  creditBalanceMicros: number;
  availableMicros: number;
  canStartTurn: boolean;
  history: BillingHistoryEntryV1[];
}

export interface StripeEventV1 {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
}

export function customCreditCentsV1(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < CREDIT_CUSTOM_MIN_CENTS_V1 ||
    (value as number) > CREDIT_CUSTOM_MAX_CENTS_V1
  ) {
    throw new Error("Custom credits must be between $5 and $1,000.");
  }
  return value as number;
}
