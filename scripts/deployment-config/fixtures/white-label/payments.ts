// A white-label's own payments Package chooser, as its profile names it by
// path, for the generator's tests. It takes no payment: what is under test is
// how the generator aliases it and holds it to its profile.
import type { PaymentsPackageBuildV1 } from "../../../../core/contracts/payments-package.ts";

export interface PaymentsPackageEnvironmentV1 {
  STUB_PAYMENTS_ACCOUNT?: string;
  STUB_PAYMENTS_SECRET?: string;
}

export const PAYMENTS_PACKAGE_V1: PaymentsPackageBuildV1<PaymentsPackageEnvironmentV1> =
  {
    id: "stub-payments",
    required: [
      { name: "STUB_PAYMENTS_ACCOUNT", why: "Names the merchant account." },
      { name: "STUB_PAYMENTS_SECRET", why: "Verifies payment events." },
    ],
    plan: {
      subscription: null,
      topUpCents: [500],
      purchasedCreditNeedsSubscription: false,
    },
    live: (environment) => !!environment.STUB_PAYMENTS_SECRET,
    create: () => ({ available: false, providerName: null, actions: () => [] }),
  };
