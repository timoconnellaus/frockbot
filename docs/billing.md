# Billing operations

FrockBot uses Stripe-hosted Checkout and the Billing Portal. The Worker stores
no card details and resolves Prices by lookup key at runtime.

## Create the Stripe catalog

Use the Stripe secret key for the target test or live account. The command is a
dry run unless `--confirm` is present:

```sh
STRIPE_SECRET_KEY=sk_test_… bun scripts/stripe-setup.ts
STRIPE_SECRET_KEY=sk_test_… bun scripts/stripe-setup.ts --confirm
```

The script first finds existing active Prices by lookup key, so it is safe to
run again. It creates one `FrockBot Billing` Product when needed and these
Prices:

- `frockbot_basic_monthly` — $20 recurring monthly
- `frockbot_credit_25`
- `frockbot_credit_50`
- `frockbot_credit_100`
- `frockbot_credit_500`
- `frockbot_credit_custom` — $5–$1,000 custom amount

The application needs no Product or Price id variable.

## Configure the Worker and Stripe

Add these repository/environment secrets for the Worker deployment:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`

In Stripe, enable and configure the Customer Portal for subscription
management. Register this webhook endpoint:

`https://bot.frockbot.com/api/billing/stripe/webhook`

Subscribe it to:

- `checkout.session.completed`
- `invoice.paid`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `charge.refunded`

Copy that endpoint's signing secret into `STRIPE_WEBHOOK_SECRET`. Test-mode and
live-mode catalogs and webhook endpoints are separate, so repeat setup with the
matching secret keys before moving from test to live.

Merging does not deploy FrockBot. After the secrets and Stripe objects exist,
ship the application with the normal version-tag release and watch the release
to its terminal deploy result.
