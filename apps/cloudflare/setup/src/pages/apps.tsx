import { useEffect, useState } from "preact/hooks";
import { addMcpServer, connectApp, signInToServer } from "../actions.ts";
import { api } from "../api.ts";
import { useSetup } from "../state.ts";
import {
  APPS_PACKAGE_ID,
  MCP_PACKAGE_ID,
  type CatalogRow,
  type Connection,
  type ConnectionsFrame,
} from "../model.ts";
import {
  Dialog,
  Field,
  Monogram,
  Notice,
  PageHead,
  Pill,
  Problem,
  Segmented,
  Soon,
  useAction,
} from "../ui.tsx";
import { connectionState, RemoveAccount } from "./accounts.tsx";

function AppRow(props: {
  row: CatalogRow;
  account?: Connection | undefined;
  onRemove: (connection: Connection) => void;
}) {
  const { reload } = useSetup();
  const action = useAction();
  const state = props.account ? connectionState(props.account) : undefined;
  const connect = () =>
    action.run(async () => {
      await connectApp(props.row);
      await reload();
    });
  return (
    <div class="row">
      <Monogram name={props.row.displayName} />
      <span class="grow stack-2">
        <span class="row-title">{props.row.displayName}</span>
        {props.row.description ? (
          <span class="small clamp">{props.row.description}</span>
        ) : null}
        <Problem message={action.problem} />
      </span>
      {state ? <Pill tone={state.tone}>{state.text}</Pill> : null}
      {props.account?.state === "ready" ? (
        <button
          type="button"
          class="rowpill"
          onClick={() => props.onRemove(props.account!)}
        >
          Remove
        </button>
      ) : (
        <button
          type="button"
          class="rowpill primary"
          disabled={action.busy}
          onClick={() => void connect()}
        >
          {action.busy ? "Opening…" : props.account ? "Reconnect" : "Connect"}
        </button>
      )}
    </div>
  );
}

function AddServer(props: { connectionTypeId: string; onClose: () => void }) {
  const { reload } = useSetup();
  const action = useAction();
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const add = () =>
    void action.run(async () => {
      let url: URL;
      try {
        url = new URL(address.trim());
      } catch {
        throw new Error(
          "Enter the server’s full https address, like https://mcp.example.com/mcp.",
        );
      }
      if (url.protocol !== "https:" || url.username)
        throw new Error(
          "Enter the server’s full https address, like https://mcp.example.com/mcp.",
        );
      await addMcpServer({
        connectionTypeId: props.connectionTypeId,
        address: url.toString(),
        name,
        token: token.trim(),
      });
      await reload();
      props.onClose();
    });
  return (
    <Dialog title="Add an MCP server" onClose={props.onClose}>
      <form
        class="stack-16"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <Field
          label="Server address"
          type="url"
          value={address}
          onInput={setAddress}
          placeholder="https://mcp.example.com/mcp"
          autoFocus
          required
        />
        <Field label="Name (optional)" value={name} onInput={setName} />
        <Field
          label="Token (optional)"
          type="password"
          value={token}
          onInput={setToken}
          mono
          hint="Only if the server asks for one. It is encrypted and never shown again."
        />
        <Problem message={action.problem} />
        <div class="row-actions">
          <button type="button" class="btn outline" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            class="btn primary"
            disabled={action.busy}
            onClick={add}
          >
            {action.busy ? "Adding…" : "Add server"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ServerRow(props: {
  connection: Connection;
  onRemove: (connection: Connection) => void;
}) {
  const { reload } = useSetup();
  const action = useAction();
  const state = connectionState(props.connection);
  const address = props.connection.settings?.url;
  const needsSignIn =
    props.connection.state === "authorizing" ||
    props.connection.state === "reconciliation-required" ||
    Boolean(props.connection.pendingAuthorization);
  return (
    <div class="row">
      <Monogram name={props.connection.displayName} />
      <span class="grow stack-2">
        <span class="row-title">{props.connection.displayName}</span>
        {typeof address === "string" ? (
          <span class="small clamp">{address}</span>
        ) : null}
        <Problem message={action.problem} />
      </span>
      <Pill tone={state.tone}>{state.text}</Pill>
      {needsSignIn ? (
        <button
          type="button"
          class="rowpill primary"
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              await signInToServer(props.connection.connectionId);
              await reload();
            })
          }
        >
          Sign in
        </button>
      ) : null}
      <button
        type="button"
        class="rowpill"
        onClick={() => props.onRemove(props.connection)}
      >
        Remove
      </button>
    </div>
  );
}

export function AppsPage() {
  const { data, go } = useSetup();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<CatalogRow[]>();
  const [problem, setProblem] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Connection>();
  const [mode, setMode] = useState<"frockbot" | "custom">("frockbot");

  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      api<ConnectionsFrame>(
        `/api/settings/connections?catalog=1&kinds=connector&limit=40&q=${encodeURIComponent(query.trim())}`,
      )
        .then((frame) => {
          if (!current) return;
          setFound(frame.providers);
          setProblem(undefined);
        })
        .catch((error: Error) => current && setProblem(error.message));
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, data]);

  const live = data.settings.connections.filter(
    (c) => c.state !== "revoked" && c.state !== "revoking",
  );
  const servers = live.filter((c) => c.packageId === MCP_PACKAGE_ID);
  const appAccounts = live.filter((c) => c.packageId === APPS_PACKAGE_ID);
  const rows = (found ?? []).filter((row) => row.packageId === APPS_PACKAGE_ID);
  // The apps with an account lead, then whatever the search found.
  const connected = rows.filter((row) =>
    appAccounts.some((c) => c.connectionTypeId === row.connectionTypeId),
  );
  const others = rows.filter((row) => !connected.includes(row));
  const mcpType =
    (found ?? []).find((row) => row.packageId === MCP_PACKAGE_ID)
      ?.connectionTypeId ?? "mcp-server";
  const planName = data.billing?.subscription
    ? data.billing.plan.subscriptions.find(
        (plan) => plan.id === data.billing?.subscription?.planId,
      )?.name
    : undefined;

  return (
    <>
      <PageHead
        title="Connected apps"
        lede="The apps your bots can use for you: mail, calendars, documents and more."
      >
        <Segmented
          label="Who runs connected apps"
          value={mode}
          options={[
            { value: "frockbot", label: "FrockBot’s connected apps" },
            { value: "custom", label: "Your own Composio" },
          ]}
          onChange={setMode}
        />
      </PageHead>
      {mode === "custom" ? (
        <section class="card pad-20 stack-12">
          <div class="row-inline">
            <h2 class="h2">Your own Composio</h2>
            <Soon />
          </div>
          <p class="body muted">
            Connect your own Composio account and your bots use its apps, on
            your Composio plan. Until then, FrockBot’s connected apps keep
            working.
          </p>
        </section>
      ) : (
        <>
          {data.billing?.metered ? (
            <Notice
              tone="info"
              title={
                planName ? `Included in your ${planName} plan` : "Needs a plan"
              }
            >
              FrockBot’s connected apps need at least the BYO plan. Connect an
              app once and every bot can use it.{" "}
              {!planName ? (
                <a
                  href="/setup/plan"
                  onClick={(event) => {
                    event.preventDefault();
                    go("plan");
                  }}
                >
                  Choose a plan
                </a>
              ) : null}
            </Notice>
          ) : null}
          <section class="stack-12">
            <div class="section-head">
              <h2 class="h2">Your apps</h2>
              <label class="field inline">
                <span class="sr-only">Find an app</span>
                <input
                  type="search"
                  value={query}
                  placeholder="Find an app"
                  onInput={(event) => setQuery(event.currentTarget.value)}
                />
              </label>
            </div>
            <Problem message={problem} />
            <div class="card rows">
              {[...connected, ...others].map((row) => (
                <AppRow
                  key={row.connectionTypeId}
                  row={row}
                  account={appAccounts.find(
                    (c) => c.connectionTypeId === row.connectionTypeId,
                  )}
                  onRemove={setRemoving}
                />
              ))}
              {found && !rows.length ? (
                <p class="small pad">
                  {query.trim()
                    ? `No app matches “${query.trim()}”.`
                    : "Connected apps aren’t available on this install."}
                </p>
              ) : null}
              {!found && !problem ? (
                <p class="small pad">Loading apps…</p>
              ) : null}
            </div>
          </section>
        </>
      )}
      <section class="stack-12">
        <div class="section-head">
          <div class="stack-2">
            <h2 class="h2">Your MCP servers</h2>
            <span class="small">
              Add any remote MCP server; its tools work like a connected app’s.
            </span>
          </div>
          <button
            type="button"
            class="btn outline"
            onClick={() => setAdding(true)}
          >
            Add a server
          </button>
        </div>
        <div class="card rows">
          {servers.length ? (
            servers.map((connection) => (
              <ServerRow
                key={connection.connectionId}
                connection={connection}
                onRemove={setRemoving}
              />
            ))
          ) : (
            <p class="small pad">No servers yet.</p>
          )}
        </div>
      </section>
      {adding ? (
        <AddServer
          connectionTypeId={mcpType}
          onClose={() => setAdding(false)}
        />
      ) : null}
      {removing ? (
        <RemoveAccount
          connection={removing}
          name={
            data.accounts.find((a) => a.id === removing.connectionId)?.label ??
            removing.displayName
          }
          uses={["Your bots"]}
          onClose={() => setRemoving(undefined)}
        />
      ) : null}
    </>
  );
}
