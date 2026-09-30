import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { adoptReader, hasReader } from "./api.ts";
import { adoptFrame, framedByApp, tellHost } from "./bridge.ts";
import type { SetupPage } from "./model.ts";
import { AccountsPage } from "./pages/accounts.tsx";
import { AiPage } from "./pages/ai.tsx";
import { AppsPage } from "./pages/apps.tsx";
import { ComputerPage } from "./pages/computer.tsx";
import { OverviewPage } from "./pages/overview.tsx";
import { PlanPage } from "./pages/plan.tsx";
import { SearchPage } from "./pages/search.tsx";
import { SetupContext, useSetupLoader, type Loaded } from "./state.ts";
import { Icon } from "./ui.tsx";

const PAGES: { id: SetupPage; label: string; title: string }[] = [
  { id: "overview", label: "Overview", title: "Your setup" },
  { id: "plan", label: "Plan and credit", title: "Plan and credit" },
  { id: "computer", label: "Computer", title: "Computer" },
  { id: "ai", label: "AI", title: "AI" },
  { id: "search", label: "Web search", title: "Web search" },
  { id: "apps", label: "Connected apps", title: "Connected apps" },
  { id: "accounts", label: "Your accounts", title: "Your accounts" },
];

function pageOf(pathname: string): SetupPage {
  const id = pathname.replace(/^\/setup\/?/, "");
  return PAGES.some((page) => page.id === id) ? (id as SetupPage) : "overview";
}

function pathOf(page: SetupPage): string {
  return page === "overview" ? "/setup" : `/setup/${page}`;
}

/** Ink unless the account asks for Paper, or for its device's light look. */
function useLook(loaded: Loaded) {
  useEffect(() => {
    const look =
      loaded.state === "ready"
        ? loaded.data.settings.appearance?.look
        : undefined;
    const apply = () => {
      const light =
        look === "paper" ||
        (look === "system" &&
          matchMedia("(prefers-color-scheme: light)").matches);
      document.documentElement.dataset.theme = light ? "paper" : "ink";
    };
    apply();
    const query = matchMedia("(prefers-color-scheme: light)");
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [loaded]);
}

function leave() {
  if (framedByApp()) tellHost({ type: "close" });
  else location.assign("/");
}

function Brand() {
  return (
    <span class="brand">
      <img src="/favicon.ico" alt="" width={34} height={34} />
      <span class="stack-2">
        <span class="wordmark">
          Frock<span class="accent-text">Bot</span>
        </span>
        <span class="small">Setup</span>
      </span>
    </span>
  );
}

function Nav(props: { page: SetupPage; go: (page: SetupPage) => void }) {
  return (
    <nav class="nav" aria-label="Setup">
      {PAGES.map((page) => (
        <a
          key={page.id}
          href={pathOf(page.id)}
          class={page.id === props.page ? "on" : ""}
          aria-current={page.id === props.page ? "page" : undefined}
          onClick={(event) => {
            event.preventDefault();
            props.go(page.id);
          }}
        >
          <Icon name={page.id} />
          {page.label}
        </a>
      ))}
    </nav>
  );
}

function Shell() {
  const { loaded, reload } = useSetupLoader();
  const [page, setPage] = useState<SetupPage>(() => pageOf(location.pathname));
  const [menu, setMenu] = useState(false);
  const main = useRef<HTMLElement>(null);
  useLook(loaded);

  useEffect(() => {
    const back = () => setPage(pageOf(location.pathname));
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);

  useEffect(() => {
    document.title = `${PAGES.find((p) => p.id === page)!.title} · FrockBot setup`;
  }, [page]);

  const go = (next: string) => {
    const target = PAGES.find((p) => p.id === next)?.id ?? "overview";
    setMenu(false);
    if (target !== page) {
      // `pushState` is not a navigation, so the app's web view keeps its
      // one admitted address.
      history.pushState(null, "", pathOf(target));
      setPage(target);
      window.scrollTo(0, 0);
      main.current?.focus({ preventScroll: true });
    }
  };

  const title = PAGES.find((p) => p.id === page)!.title;
  const email =
    loaded.state === "ready"
      ? (loaded.data.settings.profile.email ??
        loaded.data.settings.profile.name)
      : undefined;

  let body;
  if (loaded.state === "loading")
    body = (
      <p class="body muted" role="status">
        Loading your setup…
      </p>
    );
  else if (loaded.state === "signed-out")
    body = (
      <section class="card pad-20 stack-12">
        <h1 class="h1">Sign in to see your setup</h1>
        <p class="body muted">
          {hasReader()
            ? "This page was open too long. Close it and open Setup again from the app."
            : "Setup shows your own account, so it needs you signed in."}
        </p>
        {!hasReader() ? (
          <a class="btn primary self-start" href="/">
            Sign in
          </a>
        ) : null}
      </section>
    );
  else if (loaded.state === "failed")
    body = (
      <section class="card pad-20 stack-12">
        <h1 class="h1">Setup couldn’t load</h1>
        <p class="body muted">{loaded.message}</p>
        <button
          type="button"
          class="btn outline self-start"
          onClick={() => void reload()}
        >
          Try again
        </button>
      </section>
    );
  else
    body = (
      <SetupContext.Provider value={{ data: loaded.data, reload, go }}>
        {page === "overview" ? <OverviewPage /> : null}
        {page === "plan" ? <PlanPage /> : null}
        {page === "computer" ? <ComputerPage /> : null}
        {page === "ai" ? <AiPage /> : null}
        {page === "search" ? <SearchPage /> : null}
        {page === "apps" ? <AppsPage /> : null}
        {page === "accounts" ? <AccountsPage /> : null}
      </SetupContext.Provider>
    );

  return (
    <div class="shell">
      <aside class="side">
        <Brand />
        <Nav page={page} go={go} />
        <div class="side-foot stack-8">
          <button type="button" class="btn outline start" onClick={leave}>
            <Icon name="back" />
            Back to your bots
          </button>
          {email ? <span class="small pad-x">{email}</span> : null}
        </div>
      </aside>
      <header class="topbar">
        <button
          type="button"
          class="btn icon-only"
          aria-label="Setup pages"
          aria-expanded={menu}
          onClick={() => setMenu(!menu)}
        >
          <Icon name="menu" />
        </button>
        <span class="topbar-title">{title}</span>
        <button type="button" class="btn text" onClick={leave}>
          Done
        </button>
      </header>
      {menu ? (
        <div class="sheet">
          <Nav page={page} go={go} />
        </div>
      ) : null}
      <main class="main" ref={main} tabIndex={-1}>
        {body}
      </main>
    </div>
  );
}

adoptFrame(new URLSearchParams(location.hash.slice(1)).has("reader"));
adoptReader();
render(<Shell />, document.getElementById("setup")!);
tellHost({ type: "ready" });
