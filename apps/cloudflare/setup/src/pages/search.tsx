import { useState } from "preact/hooks";
import { useSetup } from "../state.ts";
import { PageHead, Segmented, Soon } from "../ui.tsx";

const SERVICES = [
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
] as const;

export function SearchPage() {
  const { data } = useSetup();
  const [mode, setMode] = useState<"frockbot" | "custom">("frockbot");
  const [service, setService] = useState<string>();
  const searches = data.spending?.groups.find(
    (group) => group.key === "search",
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
          onChange={setMode}
        />
      </PageHead>
      {mode === "frockbot" ? (
        <section class="card pad-20 stack-8">
          <h2 class="h2">FrockBot’s search</h2>
          <p class="body muted">
            Every bot can search the web with nothing to set up.
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
                  onClick={() => setService(each.id)}
                >
                  <span class="radio" />
                  <span class="stack-4">
                    <span class="wrap-8">
                      <span class="row-title">{each.name}</span>
                      <Soon />
                    </span>
                    <span class="small">{each.detail}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
          <section class="card pad-20 split">
            <div class="stack-12">
              <p class="body muted">
                {service
                  ? `Using ${SERVICES.find((s) => s.id === service)!.name} for your bots’ searches is coming soon. Until then they use FrockBot’s search.`
                  : "Choose a service to see what it needs."}
              </p>
              <div class="wrap-8">
                <button type="button" class="btn outline" disabled>
                  Test a search
                </button>
                <button type="button" class="btn primary" disabled>
                  Save
                </button>
              </div>
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
              </ul>
            </div>
          </section>
        </>
      )}
    </>
  );
}
