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

export type StripeCommandKindV1 =
  "checkout-subscription" | "checkout-credit" | "portal";

export interface StripeCommandPreparationV1 {
  status: "pending" | "complete";
  customerId?: string;
  resultUrl?: string;
}

function recordV1(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function boundedTextV1(value: unknown, label: string, maximum = 512): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function safeIntegerV1(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} is invalid`);
  return value as number;
}

export function decodeStripeEventV1(value: unknown): StripeEventV1 {
  const source = recordV1(value, "Stripe event");
  const data = recordV1(source.data, "Stripe event data");
  return {
    id: boundedTextV1(source.id, "Stripe event id"),
    type: boundedTextV1(source.type, "Stripe event type"),
    created: safeIntegerV1(source.created, "Stripe event created"),
    data: { object: recordV1(data.object, "Stripe event object") },
  };
}

export function decodeBillingViewV1(value: unknown): BillingViewV1 {
  const source = recordV1(value, "Billing view");
  if (
    source.schemaVersion !== 1 ||
    (source.plan !== "none" && source.plan !== "basic") ||
    typeof source.canStartTurn !== "boolean" ||
    !Array.isArray(source.history) ||
    source.history.length > BILLING_HISTORY_MAX_ROWS_V1
  ) {
    throw new Error("Billing view is invalid");
  }
  const timestamp = (candidate: unknown, label: string): string | undefined => {
    if (candidate === undefined) return undefined;
    const result = boundedTextV1(candidate, label, 64);
    if (!Number.isFinite(Date.parse(result)))
      throw new Error(`${label} is invalid`);
    return result;
  };
  const currentPeriodStart = timestamp(
    source.currentPeriodStart,
    "Billing period start",
  );
  const currentPeriodEnd = timestamp(
    source.currentPeriodEnd,
    "Billing period end",
  );
  return {
    schemaVersion: 1,
    plan: source.plan,
    subscriptionStatus: boundedTextV1(
      source.subscriptionStatus,
      "Billing subscription status",
      64,
    ),
    ...(currentPeriodStart ? { currentPeriodStart } : {}),
    ...(currentPeriodEnd ? { currentPeriodEnd } : {}),
    allowanceMicros: safeIntegerV1(source.allowanceMicros, "Billing allowance"),
    allowanceUsedMicros: safeIntegerV1(
      source.allowanceUsedMicros,
      "Billing allowance used",
    ),
    allowanceRemainingMicros: safeIntegerV1(
      source.allowanceRemainingMicros,
      "Billing allowance remaining",
    ),
    creditBalanceMicros: safeIntegerV1(
      source.creditBalanceMicros,
      "Billing credit balance",
    ),
    availableMicros: safeIntegerV1(source.availableMicros, "Billing available"),
    canStartTurn: source.canStartTurn,
    history: source.history.map((candidate) => {
      const entry = recordV1(candidate, "Billing history entry");
      const occurredAt = boundedTextV1(
        entry.occurredAt,
        "Billing history timestamp",
        64,
      );
      if (!Number.isFinite(Date.parse(occurredAt))) {
        throw new Error("Billing history timestamp is invalid");
      }
      return {
        eventId: boundedTextV1(entry.eventId, "Billing history event id"),
        type: boundedTextV1(entry.type, "Billing history type"),
        occurredAt,
        amountMicros: safeIntegerV1(
          entry.amountMicros,
          "Billing history amount",
        ),
        description: boundedTextV1(
          entry.description,
          "Billing history description",
        ),
      };
    }),
  };
}

export function decodeStripeCommandPreparationV1(
  value: unknown,
): StripeCommandPreparationV1 {
  const source = recordV1(value, "Stripe command preparation");
  if (source.status !== "pending" && source.status !== "complete") {
    throw new Error("Stripe command preparation is invalid");
  }
  const customerId =
    source.customerId === undefined
      ? undefined
      : boundedTextV1(source.customerId, "Stripe Customer id");
  const resultUrl =
    source.resultUrl === undefined
      ? undefined
      : boundedTextV1(source.resultUrl, "Stripe result URL", 2_048);
  return {
    status: source.status,
    ...(customerId ? { customerId } : {}),
    ...(resultUrl ? { resultUrl } : {}),
  };
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
