import { useMemo } from "preact/hooks";
import { useSetup } from "../state.ts";
import {
  chatOf,
  FROCK_AI_PACKAGE_ID,
  listWords,
  MCP_PACKAGE_ID,
  APPS_PACKAGE_ID,
  microsToDollars,
  needsYouOf,
  providerName,
  providersOf,
  stripOf,
  type SetupPage,
} from "../model.ts";
import { Icon, Notice, PageHead, Pill, type Tone } from "../ui.tsx";
import { nameOfSearch } from "./search.tsx";

function Summary(props: {
  page: SetupPage;
  icon: string;
  title: string;
  state: { tone: Tone; text: string };
  headline: string;
  detail: string;
}) {
  const { go } = useSetup();
  return (
    <a
      class="card summary"
      href={`/setup/${props.page}`}
      onClick={(event) => {
        event.preventDefault();
        go(props.page);
      }}
    >
      <div class="between">
        <span class="summary-title">
          <Icon name={props.icon} />
          {props.title}
        </span>
        <Pill tone={props.state.tone}>{props.state.text}</Pill>
      </div>
      <span class="summary-headline">{props.headline}</span>
      <span class="small">{props.detail}</span>
    </a>
  );
}

export function OverviewPage() {
  const { data, go } = useSetup();
  const providers = useMemo(
    () => providersOf(data.settings, data.modelCatalog),
    [data],
  );
  const chat = chatOf(data.settings, providers);
  const needs = needsYouOf(data.settings, providers, chat, data.billing);
  const ownSearch =
    data.webSearch && data.webSearch.provider !== "frockbot"
      ? data.webSearch.provider
      : undefined;
  const strip = stripOf(
    chat,
    providers,
    data.settings,
    ownSearch !== undefined,
  );
  const billing = data.billing;
  const plan = billing?.subscription
    ? billing.plan.subscriptions.find(
        (p) => p.id === billing.subscription?.planId,
      )
    : undefined;
  const live = data.settings.connections.filter(
    (c) => c.state !== "revoked" && c.state !== "revoking",
  );
  const apps = live.filter((c) => c.packageId === APPS_PACKAGE_ID);
  const servers = live.filter((c) => c.packageId === MCP_PACKAGE_ID);
  const keyed = live.filter(
    (c) =>
      c.packageId.startsWith("provider-") &&
      c.packageId !== FROCK_AI_PACKAGE_ID,
  );
  const broken = live.filter((c) => c.state === "failed");
  const searches = data.spending?.groups.find((g) => g.key === "search");
  const computer = data.spending?.groups.find((g) => g.key === "computer");
  const accountNames = [
    ...new Set(keyed.map((c) => providerName(providers, c))),
  ];

  return (
    <>
      <PageHead
        title="Your setup"
        lede="Everything your bots use, and who runs each part."
      />
      {needs.length ? (
        <Notice
          tone="bad"
          title={
            needs.length === 1
              ? needs[0]!.title
              : `${needs.length} things need you`
          }
          action={
            <button
              type="button"
              class="btn outline"
              onClick={() => go(needs[0]!.page)}
            >
              {needs[0]!.action}
            </button>
          }
        >
          {needs.length === 1
            ? needs[0]!.detail
            : listWords(needs.map((item) => item.title))}
        </Notice>
      ) : null}
      <div class="strip" role="list" aria-label="Who runs what">
        {strip.map((cell) => (
          <div
            class={`strip-cell${cell.yours ? " yours" : ""}`}
            role="listitem"
            key={cell.name}
          >
            <span class="strip-name">{cell.name}</span>
            <span class="strip-detail">{cell.detail}</span>
            <span class="strip-owner">
              {cell.yours ? "Yours" : "FrockBot’s"}
            </span>
          </div>
        ))}
      </div>
      <div class="grid-3">
        <Summary
          page="plan"
          icon="plan"
          title="Plan and credit"
          state={
            !billing?.metered
              ? { tone: "neutral", text: "No billing" }
              : billing.canSpend
                ? { tone: "ok", text: "Active" }
                : { tone: "bad", text: "Needs you" }
          }
          headline={
            plan
              ? `${plan.name} · US$${plan.monthlyCents / 100} a month`
              : billing?.metered
                ? "No plan yet"
                : "Free on this install"
          }
          detail={
            billing?.metered
              ? `${microsToDollars(billing.includedMicros + billing.purchasedMicros)} of credit left.`
              : "Nothing here is charged."
          }
        />
        <Summary
          page="computer"
          icon="computer"
          title="Computer"
          state={{ tone: "ok", text: "Ready" }}
          headline="FrockBot’s computer"
          detail={
            computer && computer.chargeMicros > 0
              ? `${microsToDollars(computer.chargeMicros)} of credit ${billing?.subscribed ? "this month" : "in the last 30 days"}.`
              : "Starts when a bot needs it."
          }
        />
        <Summary
          page="ai"
          icon="ai"
          title="AI"
          state={
            chat.failure
              ? { tone: "bad", text: "Needs you" }
              : { tone: "ok", text: "Ready" }
          }
          headline={chat.mode === "custom" ? "Custom" : "Frock AI"}
          detail={
            chat.mode === "custom"
              ? `${providerName(providers, chat.connection)} for chat, Frock AI for summaries and Jev.`
              : "Frock AI does every job. No keys needed."
          }
        />
        <Summary
          page="search"
          icon="search"
          title="Web search"
          state={{ tone: "ok", text: "Ready" }}
          headline={
            ownSearch ? `Your ${nameOfSearch(ownSearch)}` : "FrockBot’s search"
          }
          detail={
            ownSearch
              ? "Never billed by FrockBot."
              : searches && searches.operations > 0
                ? `${searches.operations} search${searches.operations === 1 ? "" : "es"} ${billing?.subscribed ? "this month" : "in the last 30 days"}.`
                : "Every bot can search the web."
          }
        />
        <Summary
          page="apps"
          icon="apps"
          title="Connected apps"
          state={{ tone: "ok", text: "Ready" }}
          headline="FrockBot’s connected apps"
          detail={
            apps.length || servers.length
              ? [
                  apps.length
                    ? `${apps.length} app${apps.length === 1 ? "" : "s"}`
                    : "",
                  servers.length
                    ? `${servers.length} MCP server${servers.length === 1 ? "" : "s"}`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" and ") + " connected."
              : "Nothing connected yet."
          }
        />
        <Summary
          page="accounts"
          icon="accounts"
          title="Your accounts"
          state={
            broken.length
              ? { tone: "bad", text: "Needs you" }
              : { tone: "ok", text: keyed.length ? "Ready" : "None yet" }
          }
          headline={
            keyed.length
              ? `${accountNames.length} provider${accountNames.length === 1 ? "" : "s"}`
              : "No keys of your own"
          }
          detail={
            keyed.length
              ? `${listWords(accountNames)}.`
              : "Frock AI needs none. Add your own on the AI page."
          }
        />
      </div>
    </>
  );
}
