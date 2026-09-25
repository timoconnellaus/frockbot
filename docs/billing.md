# Billing

FrockBot's account plan is US$20 per month, including US$15 of usage credit per paid billing period. The monthly allowance expires at period end and is consumed before purchased credit. Top-ups are US$10, US$25 or US$50, carry forward, and require a paid subscription to spend. Billing is ordinary app code, not a runtime Plugin.

## Implementation status

**The switch is `STRIPE_SECRET_KEY`.** A deployment without it ships the billing code switched off: nothing is metered, no subscription is required, the billing page reports that payments are not available, and `scripts/check-billing-release.ts` skips its launch check. Setting the key on a hosted origin turns metering and the subscription requirement on together; a local origin never bills. The four billing values are therefore optional deploy secrets until launch.

The Stripe adapter, account-owned credit ledger, model and Computer usage accounting, web and native billing screens, and marketing pricing section are implemented locally. Targeted verification runs use Sol, as requested; the final full test/merge/release sequence is reserved for the coordinator’s release slot. **This change is not ready to deploy or accept real payments until Stripe test-mode qualification is complete.** `scripts/check-billing-release.ts` refuses launch without the required Stripe values.

The initial Computer tariff is fixed rather than a claim about measured Fly resource consumption: **US$2.75 per active hour**. That is the current 8-vCPU, 16 GB RAM and 100 GB hot-storage ceiling at Fly's published rates, doubled and rounded up. Viewer time prepays in 30-second blocks: one when the viewer opens and one on each visible-client heartbeat. A viewer call the host refuses — no running desktop, an update in flight, a provider failure — settles its elapsed duration to the second instead of a viewing block, so a refused probe never bills a successful viewer window. Other Computer operations reserve their maximum duration and settle their elapsed duration to the second. A refused viewer renewal revokes the token and stops that Bot's viewer service so its open connection cannot keep the Sprite billable. Cancellation, viewer revocation and control release remain available without credit.

If the Computer host binding fails before returning a response, whether the external effect ran is unknown. Its reservation remains pending for evidence-based reconciliation; the system does not manufacture a charge or refund from a transport error.

Up to 100 GB of existing Sprite storage while idle is included in the subscription. At the current cold-storage rate, the full allowance costs about US$1.97 per month. The subscription margin covers that retained state; it is not deducted continuously from credit.

Cloudflare Containers was investigated as a possible metered Computer host and deferred on 10 September 2026. The findings, recovered ZeroBSAI implementation details, Kubernetes comparison and cited evidence remain in [`research/computer-host-options.md`](research/computer-host-options.md) and [`research/computer-host-options.html`](research/computer-host-options.html). They are reference material rather than current billing scope.

Hosted image generation has no configured unit-price contract yet and refuses without charging. This is a visible unavailable feature, not a blocker for subscriptions, text models, BYO models or Computer usage. It must receive its own bounded reservation and durable operation key before being offered to billed accounts. Memory embeddings and ordinary application storage/hosting are product overhead covered by the subscription; they are not silently added to a customer's model bill.

Web search is platform-paid at a fixed **US$0.01 per search**: Brave Search's flat US$0.005 per request, doubled (`app/billing/search.ts`). Before a Bot's `web_search` asks Brave, it reserves that price as a `search` operation keyed `search:<effect id>`, the search's own durable effect identity, recording the tariff's own `pricing_version` (`search-2026-09-24`) rather than the plan's or a model table's. An answered request settles the charge, a request Brave refuses releases it, and one that got no answer at all — a network failure or a cancelled Turn — stays reserved for reconciliation, because whether Brave counted it is unknown. The tool is idempotent, so recovery after an eviction re-runs a search rather than reading one back; the re-run finds the reservation under the same key and is never billed a second time. An account that cannot spend gets the refusal as the tool's error and Brave is never asked.

## Local verification

Sol verified the current implementation: 125 targeted billing and Computer-host tests passed (387 assertions across six files), all 13 packages passed type checking, and both native billing widget tests passed. The Cloudflare and marketing production builds also passed. Coverage includes duplicate payments, concurrent subscription checkout, reordered invoices, expired credit, reconciliation, provider-hook tampering, fixed-rate Computer reservations, viewer cutoff, stream settlement and uncertain host failures. Desktop and mobile marketing inspection found no document overflow. The changed files pass the whitespace check.

These checks do not replace Stripe test-mode end-to-end qualification or the release-slot full suite. No new APK was published or installed, and no deployment was performed.

## Prices and money

All balances use integer micro-US-dollars: US$1 = 1,000,000 units. Stripe prices and payment amounts use integer cents. Provider resource costs and customer charges are separate. Hosted model and proposed computer prices apply a 2× multiplier to the configured standard provider rates. These rates do not include an allocation of shared plan discounts or free provider allowances.

### Hosted model rates

Hosted model prices are one versioned table held by the `DeploymentPolicy` authority (`app/billing/rates.ts`, `apps/cloudflare/src/model-rates.ts`) and edited on the [admin portal](adr/0028-open-deployment.md)'s **Hosted model rates** section. Prices are in micro-dollars per token, which is US dollars per million tokens; fractions such as `0.006` are ordinary. A table has two parts:

- **`routes`** — the model ids a call asks for (`@frock/auto`, `@frock/deepseek-ai/deepseek-v4-flash-0731`, and `@frock/structured`, the `frock-structured` Gateway route every Bot's conversation summaries run on whatever its own model; a pre-rename `@flock/…` id is priced by its own entry, else by its `@frock/` one). Each entry carries `inputMicrosPerToken`, `cachedInputMicrosPerToken`, `outputMicrosPerToken`, `maximumInputTokens` and `maximumOutputTokens`, and is a **ceiling**.
- **`served`** — the models the Gateway actually runs, keyed `<cf-aig-provider>/<cf-aig-model>` exactly as its answer headers name them (today `custom-together/deepseek-ai/DeepSeek-V4.1-Flash`), each with the three per-token prices.

A hosted call reserves its requested route's rate at that route's token bounds before anything is sent, and settles at the rate of the model that answered, as the Gateway's `cf-aig-provider` and `cf-aig-model` headers name it. Auto is a dashboard route that can be retargeted without a release, so the served model is the only honest price. The settlement records `servedModel`, the customer `unitRates` it charged, and `pricing`: `served`; `capped` when the served model is priced above its route, so the ceiling was charged and the deployment absorbed the rest; `unpriced` when the table has no rate for the served model, or the answer named none, so the ceiling was charged; or `cached` for a Gateway cache hit, which ran no provider and settles at zero. Every request sends `cf-aig-skip-cache: true`, so a cache hit should not occur. An `unpriced` settlement is also reported to the authority, at most once a minute per model per Bot object, and listed on the admin portal until a version prices that model.

Every save is a new version and no version is ever rewritten. The version becomes each model reservation's `pricing_version` (`model-rates-<n>`), and the reservation keeps the ceiling's unit prices, so a later version cannot rewrite the explanation for a charge. A save names the version it was edited from, and one made over a version someone else saved is refused as a conflict. A table must price `@frock/auto`, since every Bot starts on it, and `@frock/structured`, since every Bot's summaries run on it; a route whose bounds would reserve more than US$500,000 is refused. A deployment with no table is seeded version 1 from the prices production ran on before the table existed; the seed gives `@frock/structured` Auto's ceiling, is receipted as `maintenance:model-rates-seed:2026-09-24` and never overwrites a saved version.

Each Bot object reads the table at most once a minute and prices from that copy; a failed read keeps the copy it holds, and a Bot that has never read one refuses the hosted call without reserving anything. The Gateway holds each hosted request to its own route's `maximumInputTokens`/`maximumOutputTokens`, from the same copy — a request whose Gateway model no route names, such as a structured Auto request pinned to its own model, to the smallest. The public billing response lists each route's customer price, twice its rate, as the most a call to it can cost. Hosted image-containing chat requests are refused until their token bounds can be quoted safely; BYO models continue to support them through their provider.

Computer customer rate: **US$2.75 per active hour**, drawn from the shared prepaid balance. It is a fixed tariff based on the maximum Sprite resource envelope, not measured CPU/RAM/storage consumption. The US$15 monthly allowance buys about 5 hours 27 minutes if spent entirely on Computer time. No fixed number of hours is promised because hosted model charges use the same balance.

## Durable account ledger

The existing User Durable Object owns SQLite tables for grants, operations, Stripe receipts and account state. It validates its User identity before every billing RPC. A balance mutation and its receipt share one synchronous transaction. Distinct Bots reserve against this one authority.

An administrator can grant an account **complimentary credit** by hand from the [admin portal](adr/0028-open-deployment.md). It is a third grant kind beside the monthly allowance and purchased top-ups: it never expires, it is spent after monthly credit and before purchased credit, and it is the one kind spendable **without** a paid subscription. Each grant carries the admin's own idempotency id, the admin's identity and a reason, so a repeated request grants once and a changed amount under the same id conflicts. A single grant is capped at US$1,000. Purchased top-ups still require a subscription to spend.

The account's spend rule, in order: a suspended account is refused; without a subscription, only complimentary credit counts, and none left is refused as "subscription required"; with less spendable credit than the reservation needs, the call is refused as "no usage credit left". Both refusals are written for the person and reach the conversation verbatim (see `app/shell/run-failure-copy.ts`), with an Open Billing action beside them; the Profile page shows the remaining credit at the top, the chat pane banners an account that cannot spend, and the failed-Turn notification carries the same sentence.

Each model dispatch reserves its bounded maximum before the provider is called. A duplicate operation key cannot redispatch the provider, including after eviction. The provider's reported usage, priced at the model that answered (see [Hosted model rates](#hosted-model-rates)), settles the charge and returns unused funds to the original grants; an expired monthly grant never becomes fresh monthly credit. BYO model calls require a spendable account — a paid subscription or remaining complimentary credit — but have zero FrockBot model cost, and their token usage is still recorded.

Metering wraps the registered provider stream inside the Plugin hook chain. A Plugin cannot reduce a bill by replacing the outward usage event. A hook that returns without invoking the provider incurs no provider charge. Missing or uncertain usage remains reserved for reconciliation; byte/token estimates are never billed as provider-reported consumption. A definitive no-effect provider failure releases the reservation.

The user can see available monthly/purchased credit, pending reservations, recent usage, recent credit grants and what the account spent in the last 30 days. Usage pagination uses SQLite insertion sequence, so equal timestamps do not skip rows. Where that spending went is the Spending page's, below.

## Spending

The Flutter app's **Spending** page answers where an account's credit went. It opens from Billing, from search, from a Bot's settings (narrowed to that Bot) and from a Routine's run log (narrowed to that Routine). One page: a period, the total, a bar per day, and the charges grouped by one dimension. Tapping a row narrows to it and groups by the next dimension; each narrowing is a chip that widens again. Under the groups are the ten most expensive Turns, each opening its Bot's conversation.

The dimensions are the Bot that spent it; **what started it** — a chat with a Bot, a Routine, a Group Chat, voice, the person using a Computer directly, or a Plugin's own page; the trigger (the person, a schedule, a webhook, a connected app, run by hand); the conversation; what it bought (model replies, conversation summaries, web search, Computer time); the model; and the Plugin that made the call.

**What started it is the start of the chain, recorded when the charge is made.** A hand-off, a subagent task or a question to another Bot is charged to whatever started the Turn that asked, so a Routine is charged for the work it sets going in other Bots too. Within one Bot the chain is read back from the run that asked (`app/billing/run-cause.ts`); where it crosses into another Bot or a subagent object, the asking side writes its cause onto the origin (`StoredRunCauseV1`), because the run that asked is not readable from there. A Computer charge is the running Turn's, read from the Bot object the billing proxy sits in; viewer and control time is always the person's.

Attribution is descriptive. It sits in `billing_attribution` beside the operation, it is not part of the reservation's fingerprint — a retry that names a renamed Routine is still the same charge — and a malformed one is recorded as unattributed rather than refusing the call. A Routine's and a Group Chat's name are kept as last charged, so a rename reads by its new name.

Every settlement adds itself, in its own transaction, to an hourly rollup (`billing_spend_hourly`) and to its Turn's running total (`billing_spend_runs`); `GET /api/billing/spending` reads only those, never the operation log. Hours rather than days, because the person's days are in their Profile timezone: the rollup is summed into them when it is read. A Turn has one Bot, cause, trigger and conversation, so a grouping by those counts Turns; categories, models and Plugins split a Turn, so a view narrowed by them lists no Turns and counts none.

## Stripe

The adapter pins Stripe API version `2025-02-24.acacia`. Configure the webhook destination to the same version. Secrets remain in the Worker environment and never enter the client, Bot context, Workspace or Sprite.

- One Stripe customer per User, with `metadata.frockbot_user_id`.
- One monthly recurring USD price of 2000 cents; interval `month`, quantity one.
- Checkout creates subscriptions or one-off card top-ups using server-owned amounts.
- Checkout/customer intents are stored before Stripe writes. Requests use stable idempotency keys. An unresolved write is not retried past Stripe's safe deduplication window; it requires reconciliation.
- Webhook signatures use HMAC-SHA256 over the unmodified raw body, a five-minute timestamp tolerance, constant-time cryptographic verification, and a 1 MiB body limit.
- The gateway resolves customer ownership through Stripe's customer metadata, then the User object checks that the customer matches its stored customer.
- Webhooks retrieve canonical Stripe objects; receipt/state/grant writes are atomic. A changed account revision during an external read forces an event retry rather than a stale overwrite.
- Only a paid recurring invoice grants the monthly allowance and advances paid access. Subscription `active` or a checkout redirect alone does not authorize spending.
- Top-up credit is granted once per paid Checkout Session, with currency/amount/customer/intent validation.
- Failed renewal payment cannot grant credit. Cancellation preserves the already paid window and stops the next renewal. Refund/dispute events suspend further paid work pending review.
- A repeat purchase command with different values conflicts rather than silently changing the amount.
- Deleting the account deletes its Stripe customer: the one the ledger recorded, and any a search by `metadata['frockbot_user_id']` finds, since a creation whose answer was lost leaves one the ledger never saw. Stripe cancels a deleted customer's subscription at once, without proration, so what is left of the paid period and any credit is forfeited — the confirmation says so. A `DELETE` is idempotent at Stripe and takes no idempotency key, and an answer of `404` is a deletion. With payments unconfigured but a customer recorded, the step is refused and retried rather than skipped, because finishing around it could leave a subscription charging an account that no longer exists. Stripe keeps its own record of payments already made. The webhook answers `received` for an event about a deleted customer, or one that reaches an account already deleted, so Stripe does not retry it for days.

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

1. To point a hosted route at a different model, add the rate, then switch the route: save a table version whose `served` prices the new model, retarget the Gateway route, and check that the admin portal lists nothing unpriced. Keep hosted image generation visibly unavailable.
2. Configure Stripe test-mode product, monthly price, webhook and portal. Supply `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `STRIPE_MONTHLY_PRICE_ID` to the local test deployment without committing values.
3. Run Stripe test-mode end-to-end purchases, successful/failed renewals, cancellation, duplicate and reordered webhooks, refund/dispute suspension, concurrent spending, exhausted balance, Computer viewer cutoff, and eviction/reconciliation cases. No real payment was made during implementation.
4. Obtain the release coordinator's slot, then run the required final tests with **Sol**, integrate and run CI. Do not tag or deploy from this task without that slot.
5. Configure live Stripe values and run `bun scripts/check-billing-release.ts`. Deploy through the normal tagged release process, including marketing and the Computer host. Never remove a readiness check just because the keys are present.
6. Android release classification: **PATCH** for billing. Its Android changes are Dart/Flutter UI and widget tests (`lib/settings/billing.dart`, `lib/shell/app_shell.dart`, `test/billing_test.dart`), with no billing-owned Android native code, manifest, resources, plugins or binary configuration changes. Use the established Shorebird patch path against a compatible installed baseline; validate on staging/a disposable emulator where supported, promote stable, and confirm the installed app receives and runs the patch. Report the baseline and patch number/version in release handoff. Do not replace the phone's APK for this UI change. If the combined release includes unrelated APK-level changes, the coordinator must classify that combined release separately with evidence; only a required new APK triggers wireless ADB installation and APK fallback. No patch promotion or deployment is authorized in this task before the morning release slot.

Billing adds new namespaced tables and does not change existing conversation data shapes. No production data cleanup was executed or required for these additive tables.
