# Billing

FrockBot's account plan is US$29 per month, including US$15 of usage credit per paid billing period. The monthly allowance expires at period end and is consumed before purchased credit. Top-ups are US$10, US$25 or US$50, carry forward, and require a paid subscription to spend. Billing is ordinary app code, not a runtime Plugin.

## Implementation status

The Stripe adapter, account-owned credit ledger, model and Computer usage accounting, web and native billing screens, and marketing pricing section are implemented locally. Targeted verification runs use Sol, as requested; the final full test/merge/release sequence is reserved for the coordinator’s release slot. **This change is not ready to deploy or accept real payments until Stripe test-mode qualification is complete.** `scripts/check-billing-release.ts` refuses launch without the required Stripe values and hosted-model rate table.

The initial Computer tariff is fixed rather than a claim about measured Fly resource consumption: **US$2.75 per active hour**. That is the current 8-vCPU, 16 GB RAM and 100 GB hot-storage ceiling at Fly's published rates, doubled and rounded up. Viewer time prepays in 30-second blocks: one when the viewer opens and one on each visible-client heartbeat. Other Computer operations reserve their maximum duration and settle their elapsed duration to the second. A refused viewer renewal revokes the token and stops that Bot's viewer service so its open connection cannot keep the Sprite billable. Cancellation, viewer revocation and control release remain available without credit.

If the Computer host binding fails before returning a response, whether the external effect ran is unknown. Its reservation remains pending for evidence-based reconciliation; the system does not manufacture a charge or refund from a transport error.

Up to 100 GB of existing Sprite storage while idle is included in the subscription. At the current cold-storage rate, the full allowance costs about US$1.97 per month. The subscription margin covers that retained state; it is not deducted continuously from credit.

Cloudflare Containers was investigated as a possible metered Computer host and deferred on 10 September 2026. The findings, recovered ZeroBSAI implementation details, Kubernetes comparison and cited evidence remain in [`research/computer-host-options.md`](research/computer-host-options.md) and [`research/computer-host-options.html`](research/computer-host-options.html). They are reference material rather than current billing scope.

Hosted image generation has no configured unit-price contract yet and refuses without charging. This is a visible unavailable feature, not a blocker for subscriptions, text models, BYO models or Computer usage. It must receive its own bounded reservation and durable operation key before being offered to billed accounts. Memory embeddings and ordinary application storage/hosting are product overhead covered by the subscription; they are not silently added to a customer's model bill.

## Local verification

Sol verified the current implementation: 125 targeted billing and Computer-host tests passed (387 assertions across six files), all 13 packages passed type checking, and both native billing widget tests passed. The Cloudflare and marketing production builds also passed. Coverage includes duplicate payments, concurrent subscription checkout, reordered invoices, expired credit, reconciliation, provider-hook tampering, fixed-rate Computer reservations, viewer cutoff, stream settlement and uncertain host failures. Desktop and mobile marketing inspection found no document overflow. The changed files pass the whitespace check.

These checks do not replace Stripe test-mode end-to-end qualification or the release-slot full suite. No new APK was published or installed, and no deployment was performed.

## Prices and money

All balances use integer micro-US-dollars: US$1 = 1,000,000 units. Stripe prices and payment amounts use integer cents. Provider resource costs and customer charges are separate. Hosted model and proposed computer prices apply a 2× multiplier to the configured standard provider rates. These rates do not include an allocation of shared plan discounts or free provider allowances.

`BILLING_MODEL_RATES` is a JSON object keyed by the exact Frock AI model identifier. Each entry contains `inputMicrosPerToken`, `cachedInputMicrosPerToken`, `outputMicrosPerToken`, `maximumInputTokens`, and `maximumOutputTokens`. One micro-dollar per token equals US$1 per million tokens. The public billing response exposes customer prices at twice those rates. A reservation retains the unit prices, pricing version, Bot and conversation so a later configuration change cannot rewrite the explanation for a charge.

Do not guess a price for the gateway's automatic route. Pin its concrete model, verify its provider prices, and configure the matching Frock AI model entry before launch. The gateway enforces the smallest configured input/output bound. Hosted image-containing chat requests are refused until their token bounds can be quoted safely; BYO models continue to support them through their provider.

Computer customer rate: **US$2.75 per active hour**, drawn from the shared prepaid balance. It is a fixed tariff based on the maximum Sprite resource envelope, not measured CPU/RAM/storage consumption. The US$15 monthly allowance buys about 5 hours 27 minutes if spent entirely on Computer time. No fixed number of hours is promised because hosted model charges use the same balance.

## Durable account ledger

The existing User Durable Object owns SQLite tables for grants, operations, Stripe receipts and account state. It validates its User identity before every billing RPC. A balance mutation and its receipt share one synchronous transaction. Distinct Bots reserve against this one authority.

Each model dispatch reserves its bounded maximum before the provider is called. A duplicate operation key cannot redispatch the provider, including after eviction. The provider's reported usage settles the charge and returns unused funds to the original grants; an expired monthly grant never becomes fresh monthly credit. BYO model calls require a paid account but have zero FrockBot model cost, and their token usage is still recorded.

Metering wraps the registered provider stream inside the Plugin hook chain. A Plugin cannot reduce a bill by replacing the outward usage event. A hook that returns without invoking the provider incurs no provider charge. Missing or uncertain usage remains reserved for reconciliation; byte/token estimates are never billed as provider-reported consumption. A definitive no-effect provider failure releases the reservation.

The user can see available monthly/purchased credit, pending reservations, usage by Bot/conversation, recent credit grants and account totals grouped by day/Bot over the past 31 days. Usage pagination uses SQLite insertion sequence, so equal timestamps do not skip rows.

## Stripe

The adapter pins Stripe API version `2025-02-24.acacia`. Configure the webhook destination to the same version. Secrets remain in the Worker environment and never enter the client, Bot context, Workspace or Sprite.

- One Stripe customer per User, with `metadata.frockbot_user_id`.
- One monthly recurring USD price of 2900 cents; interval `month`, quantity one.
- Checkout creates subscriptions or one-off card top-ups using server-owned amounts.
- Checkout/customer intents are stored before Stripe writes. Requests use stable idempotency keys. An unresolved write is not retried past Stripe's safe deduplication window; it requires reconciliation.
- Webhook signatures use HMAC-SHA256 over the unmodified raw body, a five-minute timestamp tolerance, constant-time cryptographic verification, and a 1 MiB body limit.
- The gateway resolves customer ownership through Stripe's customer metadata, then the User object checks that the customer matches its stored customer.
- Webhooks retrieve canonical Stripe objects; receipt/state/grant writes are atomic. A changed account revision during an external read forces an event retry rather than a stale overwrite.
- Only a paid recurring invoice grants the monthly allowance and advances paid access. Subscription `active` or a checkout redirect alone does not authorize spending.
- Top-up credit is granted once per paid Checkout Session, with currency/amount/customer/intent validation.
- Failed renewal payment cannot grant credit. Cancellation preserves the already paid window and stops the next renewal. Refund/dispute events suspend further paid work pending review.
- A repeat purchase command with different values conflicts rather than silently changing the amount.

Register `/api/billing/stripe/webhook` for:

- `invoice.paid`
- `invoice.payment_failed`
- `customer.subscription.created`, `.updated`, `.deleted`
- `checkout.session.completed`, `.async_payment_succeeded`
- `charge.refunded`
- `charge.dispute.created`

Configure Stripe Customer Portal for payment-method updates, invoices and cancellation at period end. Do not enable plan changes, quantities, prorations, trials or coupons until their ledger behavior is implemented and qualified. Auto-top-up is not implemented; purchases are explicit.

## Reconciliation

An authenticated deployment admin may POST `/api/billing/reconcile` with a target `userId` and a `command` containing a unique `id`, an evidence-bearing `reason` (10–1000 characters), and a `settlement` for a previously reserved operation, a `revokeGrantId` for refunded credit, or an explicit `suspended` boolean. The gateway records the authenticated admin as `actorId`. Revoke refunded credit before lifting suspension; a revoked grant remains expired even when a later operation releases an old hold. The operation's recorded reservation is the maximum customer charge; reconciliation cannot create a new unreserved debit. Commands retain their reason in a durable receipt and reject conflicting retries. This route is not offered to Bots or ordinary Users.

An uncertain Stripe checkout/customer creation is investigated in Stripe by its recorded idempotency key/metadata. Do not issue a fresh creation blindly. A failed response is not proof that Stripe did nothing.

## Sprites metering investigation

Verified on 9 September 2026:

- [Fly's current Sprite prices](https://fly.io/sprites/) charge measured CPU and RAM, not just VM uptime.
- [The Sprite design article](https://fly.io/blog/design-and-implementation/) describes underlying Fly Machines, but does not promise customer access to their Machines API app/ID pair.
- [The machine-events billing advice](https://community.fly.io/t/machine-metrics-query-and-app-usage-report/7094) is from September 2022, before Sprites, and concerns ordinary Fly Machines.
- [Fly's Sprite metrics discussion](https://community.fly.io/t/support-for-multi-tenant-account-billing-sprites-api/27207) says Sprite metrics were not exposed. The [later per-Sprite usage request](https://community.fly.io/t/programmatic-usage-tracking-for-sprites-api-or-webhook-for-billing-data/27523) has no published solution.
- A read-only request to our actual `GET /v1/sprites?max_results=1` returned Sprite ID, organization, status, lifecycle timestamps and URL fields; no `machine_id` or app identifier. The SDK exposes a machine ID on its _restart_ result, but restarting customer computers to discover a hidden backend is neither a stable mapping nor a verified source of billable resource measurements.

Start/stop times alone cannot give cumulative CPU time, integrated RAM use or storage bytes. FrockBot therefore does not describe the launch tariff as measured resource billing. The approved fallback is a published fixed active-time tariff priced from the full Sprite ceiling. Computer-host replacement research, including Cloudflare Containers and GKE Agent Sandbox, is preserved in [`docs/research/computer-host-options.md`](research/computer-host-options.md) and deferred.

## Morning launch sequence

1. Pin hosted model routes and verify their rate table and output bounds. Keep hosted image generation visibly unavailable.
2. Configure Stripe test-mode product, monthly price, webhook and portal. Supply `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_MONTHLY_PRICE_ID`, and `BILLING_MODEL_RATES` to the local test deployment without committing values.
3. Run Stripe test-mode end-to-end purchases, successful/failed renewals, cancellation, duplicate and reordered webhooks, refund/dispute suspension, concurrent spending, exhausted balance, Computer viewer cutoff, and eviction/reconciliation cases. No real payment was made during implementation.
4. Obtain the release coordinator's slot, then run the required final tests with **Sol**, integrate and run CI. Do not tag or deploy from this task without that slot.
5. Configure live Stripe values and run `bun scripts/check-billing-release.ts`. Deploy through the normal tagged release process, including marketing and the Computer host. Never remove a readiness check just because the keys are present.
6. Android release classification: **PATCH** for billing. Its Android changes are Dart/Flutter UI and widget tests (`lib/settings/billing.dart`, `lib/shell/app_shell.dart`, `test/billing_test.dart`), with no billing-owned Android native code, manifest, resources, plugins or binary configuration changes. Use the established Shorebird patch path against a compatible installed baseline; validate on staging/a disposable emulator where supported, promote stable, and confirm the installed app receives and runs the patch. Report the baseline and patch number/version in release handoff. Do not replace the phone's APK for this UI change. If the combined release includes unrelated APK-level changes, the coordinator must classify that combined release separately with evidence; only a required new APK triggers wireless ADB installation and APK fallback. No patch promotion or deployment is authorized in this task before the morning release slot.

Billing adds new namespaced tables and does not change existing conversation data shapes. No production data cleanup was executed or required for these additive tables.
