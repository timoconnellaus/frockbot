/** Remove each blocker only with its implemented and verified replacement. */
export const BILLING_LAUNCH_BLOCKERS: readonly string[] = [];

export interface BillingSwitchEnv {
  STRIPE_SECRET_KEY?: string;
  BETTER_AUTH_URL?: string;
}

/**
 * Billing is switched off until Stripe is configured. Without
 * `STRIPE_SECRET_KEY` a deployment meters nothing and requires no
 * subscription, so a release can ship the billing code while the account has
 * no customers. A local origin stays off even with a key, so a copied
 * `.dev.vars.example` cannot bill a developer.
 */
export function hostedBillingEnabledV1(env: BillingSwitchEnv): boolean {
  if (!env.STRIPE_SECRET_KEY?.trim() || !env.BETTER_AUTH_URL) return false;
  return !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(
    new URL(env.BETTER_AUTH_URL).hostname,
  );
}
