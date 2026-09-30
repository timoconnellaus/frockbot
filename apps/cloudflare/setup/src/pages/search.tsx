import { useState } from "preact/hooks";
import { setWebSearch } from "../actions.ts";
import { useSetup } from "../state.ts";
import {
  Field,
  Notice,
  PageHead,
  Pill,
  Problem,
  Segmented,
  Soon,
  useAction,
} from "../ui.tsx";

type Service = "brave" | "exa" | "tavily" | "searxng";

const SERVICES: { id: Service; name: string; detail: string }[] = [
  { id: "brave", name: "Brave", detail: "Brave Search on your own key." },
  { id: "exa", name: "Exa", detail: "Search built for AI, on your key." },
  {
    id: "tavily",
    name: "Tavily",
    detail: "Search and page extraction, on your key.",
  },
  {
    id: "searxng",
    name: "SearXNG",
    detail: "Your own metasearch server. Free.",
  },
];

export function nameOfSearch(provider: string | undefined): string {
  return SERVICES.find((each) => each.id === provider)?.name ?? "FrockBot’s";
}

export function SearchPage() {
  const { data, reload } = useSetup();
  const saved = data.webSearch?.provider;
  const [mode, setMode] = useState<"frockbot" | "custom">(
    saved && saved !== "frockbot" ? "custom" : "frockbot",
  );
  const [service, setService] = useState<Service>(
    saved && saved !== "frockbot" ? saved : "brave",
  );
  const [secret, setSecret] = useState("");
  const action = useAction();
  const searches = data.spending?.groups.find(
    (group) => group.key === "search",
  );
  const chosen = SERVICES.find((each) => each.id === service)!;
  const save = () =>
    void action.run(async () => {
      const value = secret.trim();
      if (!value)
        throw new Error(
          service === "searxng"
            ? "Enter your SearXNG address."
            : `Paste your ${chosen.name} API key.`,
        );
      await setWebSearch(
        service === "searxng"
          ? { provider: "searxng", url: value }
          : { provider: service, apiKey: value },
      );
      setSecret("");
      await reload();
    });

  if (!data.webSearch)
    return (
      <>
        <PageHead
          title="Web search"
          lede="How your bots search the web for answers."
        />
        <Notice tone="info">
          Web search settings couldn’t be read just now. Your bots keep
          searching with what was set; try again in a moment.
        </Notice>
      </>
    );

  return (
    <>
      <PageHead
        title="Web search"
        lede="How your bots search the web for answers."
      >
        <Segmented
          label="Who runs web search"
          value={mode}
          options={[
            { value: "frockbot", label: "FrockBot’s search" },
            { value: "custom", label: "Custom" },
          ]}
          onChange={(next) => {
            setMode(next);
            if (next === "frockbot" && saved !== "frockbot")
              void action.run(async () => {
                await setWebSearch({ provider: "frockbot" });
                await reload();
              });
          }}
        />
      </PageHead>
      <Problem message={mode === "frockbot" ? action.problem : undefined} />
      {mode === "frockbot" ? (
        <section class="card pad-20 stack-8">
          <h2 class="h2">FrockBot’s search</h2>
          <p class="body muted">
            Every bot can search the web with nothing to set up, paid from your
            FrockBot credit.
            {searches && searches.operations > 0
              ? ` ${searches.operations} search${searches.operations === 1 ? "" : "es"} ${data.billing?.subscribed ? "this month" : "in the last 30 days"}.`
              : ""}
          </p>
        </section>
      ) : (
        <>
          <section class="stack-12">
            <h2 class="h2">Your search service</h2>
            <div class="grid-4">
              {SERVICES.map((each) => (
                <button
                  type="button"
                  key={each.id}
                  class={`opt${service === each.id ? " on" : ""}`}
                  aria-pressed={service === each.id}
                  onClick={() => {
                    setService(each.id);
                    setSecret("");
                  }}
                >
                  <span class="radio" />
                  <span class="stack-4">
                    <span class="wrap-8">
                      <span class="row-title">{each.name}</span>
                      {saved === each.id ? <Pill tone="ok">In use</Pill> : null}
                    </span>
                    <span class="small">{each.detail}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
          <section class="card pad-20 split">
            <div class="stack-12">
              {service === "searxng" ? (
                <Field
                  label="Your SearXNG address"
                  type="url"
                  value={secret}
                  onInput={setSecret}
                  placeholder="https://search.example.net"
                  hint="The server needs its JSON format turned on. FrockBot calls it from the cloud, so it must be reachable from the internet."
                />
              ) : (
                <Field
                  label={`${chosen.name} API key`}
                  type="password"
                  value={secret}
                  onInput={setSecret}
                  mono
                  hint={
                    saved === service
                      ? "A key is saved. Paste a new one to replace it; neither is ever shown."
                      : "Keys are encrypted on the server and never shown again."
                  }
                />
              )}
              <div class="wrap-8">
                <button type="button" class="btn outline" disabled>
                  Test a search
                </button>
                <Soon />
                <button
                  type="button"
                  class="btn primary"
                  disabled={action.busy}
                  onClick={save}
                >
                  {action.busy
                    ? "Saving…"
                    : saved === service
                      ? "Replace"
                      : `Use ${chosen.name}`}
                </button>
              </div>
              <Problem message={action.problem} />
              {saved && saved !== "frockbot" ? (
                <p class="small" role="status">
                  Your bots search with {nameOfSearch(saved)}.
                </p>
              ) : (
                <p class="small">
                  Until you save one, your bots use FrockBot’s search.
                </p>
              )}
            </div>
            <div class="aside stack-12">
              <h3 class="h3">Good to know</h3>
              <ul class="body plan-list">
                <li>
                  Searches on your own service are never billed by FrockBot.
                </li>
                <li>
                  If it fails, your bot tells you. It never switches to
                  FrockBot’s search.
                </li>
                <li>FrockBot’s search is paid from your credit.</li>
              </ul>
            </div>
          </section>
        </>
      )}
    </>
  );
}
