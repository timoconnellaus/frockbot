/**
 * No payments: a deployment that does not bill.
 *
 * `apps/cloudflare/src/payments.none.ts` names it. Nothing is metered, no
 * subscription is sold and the Billing page offers no purchase; complimentary
 * credit an administrator grants is still the account's to see.
 */
import type { PaymentsPackageBuildV1 } from "@frockbot/core/contracts";

/** This Package reads nothing off `env`. */
export type NoPaymentsEnvironmentV1 = Record<never, never>;

export const NO_PAYMENTS_PACKAGE_V1: PaymentsPackageBuildV1<NoPaymentsEnvironmentV1> =
  {
    id: "none",
    required: [],
    plan: {
      subscriptions: [],
      trial: null,
      topUpCents: [],
      purchasedCreditNeedsSubscription: false,
    },
    live: () => false,
    create: () => ({
      available: false,
      providerName: null,
      actions: () => [],
    }),
  };
