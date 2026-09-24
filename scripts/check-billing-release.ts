import { BILLING_LAUNCH_BLOCKERS } from "../apps/cloudflare/src/billing-readiness.js";

if (!process.env.STRIPE_SECRET_KEY?.trim()) {
  console.log(
    "Billing is switched off: STRIPE_SECRET_KEY is absent, so this deploy meters nothing and no launch check applies.",
  );
  process.exit(0);
}
const issues = [...BILLING_LAUNCH_BLOCKERS];
// Hosted model prices are not a deploy secret: they live in the deployment's
// rate table, which the admin portal edits and a fresh deployment seeds.
for (const name of [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_MONTHLY_PRICE_ID",
]) {
  if (!process.env[name]?.trim()) issues.push(`${name} is required.`);
}
if (issues.length) {
  console.error(
    "Billing is not ready for release:\n" +
      issues.map((issue) => `- ${issue}`).join("\n"),
  );
  process.exitCode = 1;
} else
  console.log(
    "Billing release configuration is complete. Complete Stripe test-mode end-to-end qualification before deploying.",
  );
