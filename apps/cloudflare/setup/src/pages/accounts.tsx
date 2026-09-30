import { useMemo, useState } from "preact/hooks";
import { removeAccount } from "../actions.ts";
import { useSetup } from "../state.ts";
import {
  APPS_PACKAGE_ID,
  chatOf,
  FROCK_AI_PACKAGE_ID,
  listWords,
  MCP_PACKAGE_ID,
  providerName,
  providersOf,
  usesOf,
  type Connection,
} from "../model.ts";
import {
  Dialog,
  Icon,
  PageHead,
  Pill,
  Problem,
  Soon,
  useAction,
} from "../ui.tsx";
import { ReplaceKey } from "./ai.tsx";

export function connectionState(connection: Connection): {
  tone: "ok" | "bad" | "warn" | "neutral";
  text: string;
} {
  switch (connection.state) {
    case "ready":
      return { tone: "ok", text: "Connected" };
    case "failed":
      return {
        tone: "bad",
        text:
          connection.authorization?.kind === "api-key"
            ? "Key refused"
            : "Not working",
      };
    case "disabled":
      return { tone: "neutral", text: "Turned off" };
    case "authorizing":
      return { tone: "warn", text: "Finish signing in" };
    case "reconciliation-required":
      return { tone: "warn", text: "Sign in again" };
    default:
      return { tone: "neutral", text: "Connecting" };
  }
}

/** Asks before removing, and says what stops. */
export function RemoveAccount(props: {
  connection: Connection;
  name: string;
  uses: string[];
  onClose: () => void;
}) {
  const { reload } = useSetup();
  const action = useAction();
  const stops = props.uses.length
    ? `${listWords(props.uses)} ${props.uses.length === 1 ? "stops" : "stop"} using it.`
    : "Nothing uses it right now.";
  return (
    <Dialog title={`Remove ${props.name}?`} onClose={props.onClose}>
      <div class="stack-16">
        <p class="body">
          {stops}{" "}
          {props.uses.includes("Chat")
            ? "Your bots go back to Frock AI for chat until you choose another provider."
            : ""}
        </p>
        <p class="small">
          {props.connection.authorization?.kind === "api-key"
            ? `The key is deleted from FrockBot. It stays valid at ${props.name} until you revoke it there.`
            : "You can connect it again at any time."}
        </p>
        <Problem message={action.problem} />
        <div class="row-actions">
          <button type="button" class="btn outline" onClick={props.onClose}>
            Keep it
          </button>
          <button
            type="button"
            class="btn danger"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await removeAccount(
                  props.connection.packageId,
                  props.connection.connectionId,
                );
                await reload();
                props.onClose();
              })
            }
          >
            {action.busy ? "Removing…" : "Remove"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function AccountRow(props: {
  connection: Connection;
  name: string;
  uses: string[];
  onReplace?: () => void;
  onRemove: () => void;
}) {
  const state = connectionState(props.connection);
  const key = props.connection.authorization?.kind === "api-key";
  return (
    <div class="row account">
      <span class="grow stack-2">
        <span class="row-title">{props.name}</span>
        <span class="small">
          {props.connection.displayName !== props.name
            ? `${props.connection.displayName} · `
            : ""}
          {key
            ? "API key"
            : props.connection.authorization?.kind === "grant"
              ? "Signed in"
              : typeof props.connection.settings?.url === "string"
                ? props.connection.settings.url
                : "Added"}
        </span>
      </span>
      <span class="small uses">
        {props.uses.length ? listWords(props.uses) : "Not used yet"}
      </span>
      <Pill tone={state.tone}>{state.text}</Pill>
      <span class="row-buttons">
        {key && props.onReplace ? (
          <button type="button" class="rowpill" onClick={props.onReplace}>
            Replace key
          </button>
        ) : null}
        <button type="button" class="rowpill" onClick={props.onRemove}>
          Remove
        </button>
      </span>
    </div>
  );
}

function ComingRow(props: { name: string; detail: string; uses: string }) {
  return (
    <div class="row account">
      <span class="grow stack-2">
        <span class="row-title">{props.name}</span>
        <span class="small">{props.detail}</span>
      </span>
      <span class="small uses">{props.uses}</span>
      <Soon />
    </div>
  );
}

export function AccountsPage() {
  const { data } = useSetup();
  const providers = useMemo(
    () => providersOf(data.settings, data.modelCatalog),
    [data],
  );
  const chat = chatOf(data.settings, providers);
  const [replacing, setReplacing] = useState<Connection>();
  const [removing, setRemoving] = useState<Connection>();
  const live = data.settings.connections.filter(
    (c) => c.state !== "revoked" && c.state !== "revoking",
  );
  const models = live.filter(
    (c) =>
      c.packageId.startsWith("provider-") &&
      c.packageId !== FROCK_AI_PACKAGE_ID,
  );
  const apps = live.filter((c) => c.packageId === APPS_PACKAGE_ID);
  const servers = live.filter((c) => c.packageId === MCP_PACKAGE_ID);
  const nameOf = (connection: Connection) =>
    connection.packageId === APPS_PACKAGE_ID
      ? (data.accounts.find((a) => a.id === connection.connectionId)?.label ??
        connection.displayName)
      : connection.packageId === MCP_PACKAGE_ID
        ? connection.displayName
        : providerName(providers, connection);
  const group = (title: string, connections: Connection[], empty: string) => (
    <section class="stack-8">
      <h2 class="h2">{title}</h2>
      <div class="card rows">
        {connections.length ? (
          connections.map((connection) => (
            <AccountRow
              key={connection.connectionId}
              connection={connection}
              name={nameOf(connection)}
              uses={usesOf(connection, data.settings)}
              onReplace={() => setReplacing(connection)}
              onRemove={() => setRemoving(connection)}
            />
          ))
        ) : (
          <p class="small pad">{empty}</p>
        )}
      </div>
    </section>
  );
  return (
    <>
      <PageHead
        title="Your accounts"
        lede="Every account and key your setup uses, in one place."
      />
      <div class="card notice info">
        <Icon name="lock" size={20} />
        <span class="body muted">
          Keys are encrypted on the server and never shown again. FrockBot
          attaches each one only to the request that needs it; your bots and
          their computer never see them.
        </span>
      </div>
      {group(
        "AI providers",
        models,
        "No provider accounts yet. Add one on the AI page.",
      )}
      {group("Connected apps", apps, "No apps connected yet.")}
      {group("MCP servers", servers, "No servers added yet.")}
      <section class="stack-8">
        <h2 class="h2">Computer, search and apps</h2>
        <div class="card rows">
          <ComingRow
            name="Fly.io"
            detail="For a computer on your own Fly.io account"
            uses="Not used: your computer is FrockBot’s"
          />
          <ComingRow
            name="Brave, Exa, Tavily or SearXNG"
            detail="For your own web search"
            uses="Not used: you use FrockBot’s search"
          />
          <ComingRow
            name="Composio"
            detail="For your own connected apps"
            uses="Not used: you use FrockBot’s connected apps"
          />
          <ComingRow
            name="Cloudflare"
            detail="Bills Jev, Workers AI and AI Gateway to your Cloudflare credits"
            uses="Nothing yet"
          />
        </div>
      </section>
      <div class="card notice bad-soft">
        <Icon name="warning" size={20} />
        <div class="stack-4">
          <span class="notice-title">
            Removing an account stops what uses it
          </span>
          <span class="body muted">
            {chat.mode === "custom" && chat.connection
              ? `Remove ${providerName(providers, chat.connection)} and chat, writing, coding, thinking and vision go back to Frock AI until you choose another provider.`
              : "Anything using a removed account stops until you choose another one."}
          </span>
        </div>
      </div>
      {replacing ? (
        <ReplaceKey
          connection={replacing}
          name={nameOf(replacing)}
          onClose={() => setReplacing(undefined)}
        />
      ) : null}
      {removing ? (
        <RemoveAccount
          connection={removing}
          name={nameOf(removing)}
          uses={usesOf(removing, data.settings)}
          onClose={() => setRemoving(undefined)}
        />
      ) : null}
    </>
  );
}
