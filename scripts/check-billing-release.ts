import { BILLING_LAUNCH_BLOCKERS } from "../apps/cloudflare/src/billing-readiness.js";
import { decodeModelRates } from "../app/billing/model.js";

const issues = [...BILLING_LAUNCH_BLOCKERS];
for (const name of [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_MONTHLY_PRICE_ID",
  "BILLING_MODEL_RATES",
]) {
  if (!process.env[name]?.trim()) issues.push(`${name} is required.`);
}
try {
  if (
    Object.keys(decodeModelRates(process.env.BILLING_MODEL_RATES)).length === 0
  )
    issues.push("At least one verified hosted model rate is required.");
} catch {
  issues.push("The hosted model price table is invalid.");
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
