import { useMemo, useState } from "preact/hooks";
import { changePlan, runPayment } from "../actions.ts";
import { useSetup } from "../state.ts";
import {
  chatOf,
  dollars,
  microsToDollars,
  providersOf,
  suggestPlan,
  usageRowsOf,
  type Billing,
  type PaymentsAction,
} from "../model.ts";
import { Dialog, PageHead, Pill, Problem, Soon, useAction } from "../ui.tsx";

function renewal(billing: Billing): string | undefined {
  const end = billing.subscription?.periodEnd;
  return end
    ? new Date(end).toLocaleDateString(undefined, {
        day: "numeric",
        month: "long",
      })
    : undefined;
}

function ConfirmPlan(props: {
  action: PaymentsAction;
  billing: Billing;
  onClose: () => void;
}) {
  const { reload } = useSetup();
  const act = useAction();
  const to = props.billing.plan.subscriptions.find(
    (p) => p.id === props.action.plan,
  );
  const from = props.billing.plan.subscriptions.find(
    (p) => p.id === props.billing.subscription?.planId,
  );
  if (!to) return null;
  const up = !from || to.includedMicros > from.includedMicros;
  const terms =
    props.billing.subscription?.status === "trialing"
      ? `This ends your trial and charges ${to.name}’s first month, ${dollars(to.monthlyCents)}, now. A new billing month begins today.`
      : up
        ? `${to.name} is ${dollars(to.monthlyCents)} a month with ${microsToDollars(to.includedMicros)} of credit. It starts now: you are charged today and a new billing month begins. Credit you bought stays yours.`
        : `${to.name} is ${dollars(to.monthlyCents)} a month with ${microsToDollars(to.includedMicros)} of credit. You stay on ${from?.name ?? "your plan"} until it renews${renewal(props.billing) ? ` on ${renewal(props.billing)}` : ""}.`;
  return (
    <Dialog title={`${props.action.label}?`} onClose={props.onClose}>
      <div class="stack-16">
        <p class="body">{terms}</p>
        <Problem message={act.problem} />
        <div class="row-actions">
          <button type="button" class="btn outline" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            class="btn primary"
            disabled={act.busy}
            onClick={() =>
              void act.run(async () => {
                await changePlan(props.action);
                await reload();
                props.onClose();
              })
            }
          >
            {props.action.label}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export function PlanPage() {
  const { data } = useSetup();
  const providers = useMemo(
    () => providersOf(data.settings, data.modelCatalog),
    [data],
  );
  const chat = chatOf(data.settings, providers);
  const pay = useAction();
  const [confirming, setConfirming] = useState<PaymentsAction>();
  const billing = data.billing;

  if (!billing || !billing.metered)
    return (
      <>
        <PageHead
          title="Plan and credit"
          lede="Your plan, your credit, and what used it this month."
        />
        <section class="card pad-20 stack-8">
          <h2 class="h2">Nothing to pay for here</h2>
          <p class="body muted">
            {billing
              ? "This install doesn’t charge for usage, so there’s no plan to choose and no credit to watch."
              : "Billing couldn’t be read just now. Your bots keep working; try again in a moment."}
          </p>
        </section>
      </>
    );

  const current = billing.subscription?.planId;
  const suggestion = suggestPlan(chat, billing, data.spentLast30DaysMicros);
  const actionFor = (plan: string) =>
    billing.actions.find(
      (action) =>
        (action.purpose === "subscribe" || action.purpose === "change-plan") &&
        action.plan === plan,
    );
  const topUp = billing.actions.find((action) => action.purpose === "top-up");
  const manage = billing.actions.find((action) => action.purpose === "manage");
  const grantedIncluded = billing.includedGrantedMicros;
  const leftShare = grantedIncluded
    ? Math.max(
        0,
        Math.min(
          100,
          Math.round((billing.includedMicros / grantedIncluded) * 100),
        ),
      )
    : 0;
  const usage = usageRowsOf(data.spending, data.settings, providers);
  const press = (action: PaymentsAction, cents?: number) => {
    if (action.purpose === "change-plan") setConfirming(action);
    else void pay.run(() => runPayment(action, cents));
  };

  return (
    <>
      <PageHead
        title="Plan and credit"
        lede="Your plan, your credit, and what used it this month."
      />
      <div class="grid-3">
        <article class="card plan stack-12" aria-labelledby="plan-byo">
          <div class="plan-head">
            <span class="plan-name" id="plan-byo">
              BYO
            </span>
            {suggestion.planId === "byo" ? (
              <Pill tone="ready">Suits your setup</Pill>
            ) : null}
            <Soon />
          </div>
          <span class="plan-price">US$5 a month</span>
          <ul class="body plan-list">
            <li>Hosting, Jev and connected apps</li>
            <li>Bring your own models and computer</li>
            <li>No included credit; top up for anything else of ours</li>
          </ul>
        </article>
        {billing.plan.subscriptions.map((plan) => {
          const action = actionFor(plan.id);
          const mine = plan.id === current;
          return (
            <article
              key={plan.id}
              class={`card plan stack-12${mine ? " on" : ""}`}
              aria-labelledby={`plan-${plan.id}`}
            >
              <div class="plan-head">
                <span class="plan-name" id={`plan-${plan.id}`}>
                  {plan.name}
                </span>
                {mine ? (
                  <Pill tone="ok">
                    {billing.subscription?.status === "trialing"
                      ? "Your trial"
                      : "Your plan"}
                  </Pill>
                ) : null}
                {suggestion.planId === plan.id ? (
                  <Pill tone="ready">Suits your setup</Pill>
                ) : null}
              </div>
              <span class="plan-price">
                {dollars(plan.monthlyCents)} a month
              </span>
              <ul class="body plan-list">
                <li>
                  {microsToDollars(plan.includedMicros)} of credit every month
                </li>
                <li>For FrockBot’s computer, Frock AI, voice and search</li>
                {billing.plan.trial && !current ? (
                  <li>{billing.plan.trial.days}-day trial</li>
                ) : null}
              </ul>
              {action ? (
                <button
                  type="button"
                  class={`btn ${suggestion.planId === plan.id && !current ? "primary" : "outline"}`}
                  disabled={pay.busy}
                  onClick={() => press(action)}
                >
                  {action.label}
                </button>
              ) : null}
            </article>
          );
        })}
      </div>
      <p class="body muted">{suggestion.why}</p>
      <Problem message={pay.problem} />
      <div class="grid-2">
        <section class="card pad-20 stack-12">
          <h2 class="h2">Credit</h2>
          <div class="between">
            <span class="body">This month’s included credit</span>
            <span class="figure">
              {microsToDollars(billing.includedMicros)} of{" "}
              {microsToDollars(grantedIncluded)}
            </span>
          </div>
          <div
            class="bar"
            role="img"
            aria-label={`${leftShare}% of included credit left`}
          >
            {/* A CSSOM write, which the page's style-src allows. */}
            <span class="fill" style={{ width: `${leftShare}%` }} />
          </div>
          <div class="between">
            <span class="body">Credit you bought</span>
            <span class="figure">
              {microsToDollars(billing.purchasedMicros)}
            </span>
          </div>
          {topUp ? (
            <div class="wrap-8">
              {billing.plan.topUpCents.map((cents) => (
                <button
                  type="button"
                  key={cents}
                  class="btn outline"
                  disabled={pay.busy}
                  onClick={() => press(topUp, cents)}
                >
                  Add {dollars(cents)}
                </button>
              ))}
            </div>
          ) : (
            <span class="small">Top-ups open once you have a plan.</span>
          )}
          <span class="small">
            Included credit is used first
            {renewal(billing) ? ` and resets on ${renewal(billing)}` : ""}.
            Credit you buy carries over.
          </span>
          {manage ? (
            <button
              type="button"
              class="btn text self-start"
              disabled={pay.busy}
              onClick={() => press(manage)}
            >
              {manage.label}
            </button>
          ) : null}
        </section>
        <section class="card rows">
          <div class="rows-head">
            <h2 class="h2">
              {billing.subscribed
                ? "Used this month"
                : "Used in the last 30 days"}
            </h2>
          </div>
          {usage.map((row) => (
            <div class="row between" key={row.label}>
              <span class="body">{row.label}</span>
              <span class="figure">{row.amount}</span>
            </div>
          ))}
        </section>
      </div>
      {confirming ? (
        <ConfirmPlan
          action={confirming}
          billing={billing}
          onClose={() => setConfirming(undefined)}
        />
      ) : null}
    </>
  );
}
