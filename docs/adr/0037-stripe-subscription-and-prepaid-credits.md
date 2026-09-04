---
status: accepted
---

# Stripe Funds One User-Owned Usage Balance

## Context

ADR 0036 made the User Durable Object the authority for a priced usage ledger.
It deliberately stopped before funding and entitlement. FrockBot now needs a
paid default plan and prepaid credits without letting Stripe, a gateway
process, a client, or a Bot become the authority for whether a Turn may start.

This is beyond-parity product billing. It is informed by GrokBot's visible
Usage and Billing surface, but it does not implement parity-register row 57h's
Bot-requested virtual payment card.

## Decision

The platform offers one **Basic** subscription for $20 USD per month. Each paid
billing cycle includes $20 of usage credit. The allowance resets when Stripe
reports the next paid subscription period; unused allowance expires. Purchased
credits are dollar-for-dollar usage credit, never expire, and are consumed only
after the current Basic allowance. Usage remains priced by ADR 0036's immutable
price table and platform multiplier, so model calls and voice minutes settle
against the same balance. Computer time will do the same once the Computer
interface supplies the reconciled duration receipt ADR 0036 requires.

The User Durable Object owns the Stripe Customer id, subscription id and
status, current period, allowance used, purchased-credit balance, billing
history, and Stripe command journal. The gateway owns no billing state. A
Checkout or Portal command is written as `pending` before Stripe is called,
uses a stable Stripe idempotency key, and stores the resulting hosted URL as
`complete`. A retry with the same command id and payload returns that URL; reuse
with a different payload is refused. A crash between the Stripe call and the
completion write safely repeats the call with the same Stripe idempotency key.

The Billing Package creates hosted Stripe Checkout Sessions. Subscription
Checkout resolves `frockbot_basic_monthly` at runtime. Fixed credit packs
resolve `frockbot_credit_25`, `frockbot_credit_50`, `frockbot_credit_100`, and
`frockbot_credit_500`. A custom purchase uses an ad-hoc Checkout Price and is
bounded by the gateway to $5–$1,000 inclusive. The setup catalog also creates
the `frockbot_credit_custom` Price with Stripe `custom_unit_amount` bounds so
operators and future hosted flows share the same catalog contract. No Price or
Product id is a deployment variable.

Stripe calls use `STRIPE_SECRET_KEY`. The public webhook at
`/api/billing/stripe/webhook` verifies the exact request body with
`STRIPE_WEBHOOK_SECRET` and a five-minute timestamp tolerance before decoding
or routing it. Both names are optional Worker secrets at the deployment seam:
without them billing routes fail closed, and both are carried in the complete
`--secrets-file` lists in `release.yml` and `ci.yml` so a deploy cannot delete
an existing value. There are no Stripe Worker vars.

The registered webhook events are `checkout.session.completed`,
`invoice.paid`, `customer.subscription.updated`,
`customer.subscription.deleted`, and `charge.refunded`. Each verified event is
forwarded to the User Durable Object named in server-written Stripe metadata.
The history row is keyed by Stripe event id and the state change and history
insert share one synchronous SQL transaction, so redelivery applies nothing.
Credit purchases additionally reconcile by PaymentIntent. Refund events carry
Stripe's cumulative `amount_refunded`; the stored credited, refunded, and
already-applied amounts make duplicate and out-of-order delivery converge on
one net purchased-credit value. Only a `charge.refunded` event carrying the
server-written `frockbot_kind=credit` metadata changes prepaid credit;
subscription and unrelated charge refunds remain history-only.

Every newly inserted usage-ledger entry debits billing in that entry's existing
User Durable Object transaction. The current allowance is consumed first and
any remainder debits purchased credit. Admission checks only whether the
resulting available amount is positive. Therefore the Turn that crosses zero
settles completely and may leave a small negative purchased-credit balance;
the next Turn is refused. A User with no subscription and no credit can still
sign in, read Sessions, and manage Bots.

The admission check lives in the hosted application's client Turn route before
the existing Bot admission RPC, not in Durable Object authority internals. It
returns the versioned `billing-required` refusal with the sentence “You need an
active plan or credit balance to send a message. Open Billing to continue.”
Billing is a registered Settings anchor, and the Billing Package contributes
the linked low/exhausted notice above the composer.

Billing is the one control surface. It shows the current plan, allowance used,
purchased-credit balance, Checkout actions, Portal action, and the newest 200
billing-history events. Plugins still owns enablement only. Closing the client
does not cancel Checkout or a Turn; Durable Object eviction leaves all billing
state and command recovery in SQL; Computer hibernation is irrelevant.

## Failure and recovery

- Missing Stripe secrets or lookup keys produce a visible failure and no
  durable entitlement change.
- An invalid signature, stale timestamp, oversized body, missing User metadata,
  or invalid event shape is refused before User state is reached.
- Webhook retries are idempotent on event id, while credit/refund convergence is
  additionally idempotent on PaymentIntent and cumulative refund amount.
- Stripe cancellation or a non-current subscription period removes the monthly
  allowance but preserves purchased credits and history.
- Usage delivery remains at least once and idempotent on usage entry id; a
  duplicate entry cannot debit billing twice.
- A client disconnect observes neither authority nor cancellation. The hosted
  Checkout and Portal remain Stripe-owned UI, and only verified webhooks alter
  local money state.

## Consequences

- Operators configure two secrets and six lookup keys, but no opaque Stripe id
  is copied into application configuration.
- The User Durable Object can answer entitlement without contacting Stripe, so
  admission works through Stripe outages and after eviction.
- Purchased credit may be negative after an overspending Turn or a refund. That
  value is shown rather than hidden and blocks the next Turn until funded.
- Refunds alter credit; Stripe remains the source of payment truth while the
  User Durable Object remains the source of product entitlement.
