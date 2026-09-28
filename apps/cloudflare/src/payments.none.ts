/**
 * A deployment that does not bill: no payments Package at all.
 *
 * The twin of `payments.ts`, which is the tracked default. A profile whose
 * `payments` is `none` makes the generator alias `#payments` here, so the
 * bundle carries no payment provider. `tsconfig.payments-none.json`
 * type-checks the whole Worker against this file.
 */
import type { PaymentsPackageBuildV1 } from "@frockbot/core/contracts";
import { NO_PAYMENTS_PACKAGE_V1 } from "@frockbot/app/payments/none";
import type { NoPaymentsEnvironmentV1 } from "@frockbot/app/payments/none";

/** What a Worker must hand the Package this build deploys. */
export type PaymentsPackageEnvironmentV1 = NoPaymentsEnvironmentV1;

/** The payments Package this build deploys. */
export const PAYMENTS_PACKAGE_V1: PaymentsPackageBuildV1<PaymentsPackageEnvironmentV1> =
  NO_PAYMENTS_PACKAGE_V1;
