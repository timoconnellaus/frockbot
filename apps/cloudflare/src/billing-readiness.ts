import {
  PAYMENTS_PACKAGE_V1,
  type PaymentsPackageEnvironmentV1,
} from "#payments";

/** Remove each blocker only with its implemented and verified replacement. */
export const BILLING_LAUNCH_BLOCKERS: readonly string[] = [];

export interface BillingSwitchEnv extends PaymentsPackageEnvironmentV1 {
  BETTER_AUTH_URL?: string;
}

/**
 * Billing is switched off until the payments Package says payments are live
 * — Stripe's switch is `STRIPE_SECRET_KEY`. Off, a deployment meters nothing
 * and requires no subscription, so a release can ship the billing code while
 * the account has no customers. A local origin stays off even when live, so a
 * copied `.dev.vars.example` cannot bill a developer.
 */
export function hostedBillingEnabledV1(env: BillingSwitchEnv): boolean {
  if (!PAYMENTS_PACKAGE_V1.live(env) || !env.BETTER_AUTH_URL) return false;
  return !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(
    new URL(env.BETTER_AUTH_URL).hostname,
  );
}
