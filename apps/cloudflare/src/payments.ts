/**
 * How the hosted deployment takes payment: Stripe.
 *
 * `PaymentsPackageV1` is the interface the gateway and the ledger speak to a
 * payment provider (`core/contracts/payments-package.ts`); this file and
 * `payments.none.ts` are the two builds of it, and each is exactly one value
 * import.
 *
 * This is the one the tracked source resolves: `wrangler dev`, every suite and
 * the hosted deploy all reach it through `#payments`, which
 * `apps/cloudflare/package.json` maps here. A profile whose `payments` is
 * `none`, or a path to a white-label's own chooser, gets a generated wrangler
 * config aliasing `#payments` to that file instead, and this one is not in its
 * bundle at all.
 *
 * `scripts/check-payments-package-imports.ts` keeps the Stripe implementation
 * inside `app/payments/stripe/**` and this file.
 */
import type { PaymentsPackageBuildV1 } from "@frockbot/core/contracts";
import { STRIPE_PAYMENTS_PACKAGE_V1 } from "@frockbot/app/payments/stripe";
import type { StripeEnvironmentV1 } from "@frockbot/app/payments/stripe";

/** What a Worker must hand the Package this build deploys. */
export type PaymentsPackageEnvironmentV1 = StripeEnvironmentV1;

/** The payments Package this build deploys. */
export const PAYMENTS_PACKAGE_V1: PaymentsPackageBuildV1<PaymentsPackageEnvironmentV1> =
  STRIPE_PAYMENTS_PACKAGE_V1;
