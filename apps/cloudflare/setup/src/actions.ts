/**
 * Every change Setup makes, each through the account route that already owns
 * it. A key goes up once, in the command that stores it, and is never read
 * back.
 */

import { api, newCommandId } from "./api.ts";
import { askHost, framedByApp } from "./bridge.ts";
import {
  APPS_PACKAGE_ID,
  IMAGE_PACKAGE_ID,
  MCP_PACKAGE_ID,
  type CatalogRow,
  type ModelBinding,
  type PaymentsAction,
} from "./model.ts";

interface Receipt {
  status: "pending" | "applied" | "rejected";
  failure?: string;
}

async function userCommand(
  revision: number,
  command: Record<string, unknown>,
): Promise<void> {
  const receipt = await api<Receipt>("/api/settings", {
    body: {
      schemaVersion: 1,
      commandId: newCommandId(),
      expectedRevision: revision,
      ...command,
    },
  });
  if (receipt?.status === "rejected")
    throw new Error(receipt.failure ?? "That change was refused.");
}

/** What every Bot without its own choice chats with; null is Frock AI. */
export function setChatModel(
  revision: number,
  model: ModelBinding | null,
): Promise<void> {
  return userCommand(revision, { type: "user/set-account-model", model });
}

/** Adds a provider to the account, so a key can be connected to it. */
export function addProvider(
  revision: number,
  packageId: string,
): Promise<void> {
  return userCommand(revision, {
    type: "user/choose-model-provider",
    packageId,
  });
}

export function setImageModel(revision: number, model: string): Promise<void> {
  return userCommand(revision, {
    type: "user/set-package-settings",
    packageId: IMAGE_PACKAGE_ID,
    values: { model },
  });
}

interface ConnectionReceipt {
  connectionId: string;
  status: "applied" | "failed" | "reconciliation-required";
}

function connectionCommand(body: Record<string, unknown>) {
  return api<ConnectionReceipt>("/api/connections", {
    body: { schemaVersion: 1, commandId: newCommandId(), ...body },
  });
}

export async function connectKey(
  type: CatalogRow,
  label: string,
  apiKey: string,
  settings: Record<string, string>,
): Promise<string> {
  const receipt = await connectionCommand({
    type: "connection/create-api-key",
    packageId: type.packageId,
    connectionTypeId: type.connectionTypeId,
    label: label.trim().slice(0, 120),
    apiKey,
    ...(Object.keys(settings).length ? { settings } : {}),
  });
  if (receipt.status === "failed")
    throw new Error("That key didn’t connect. Check it and try again.");
  return receipt.connectionId;
}

/**
 * Adds a model server on one of the account's Macs. Connecting is the test:
 * the server is asked for its models through the Mac, and the Connection
 * comes back ready with them, or failed with the reason.
 */
export async function connectLocalModel(input: {
  type: CatalogRow;
  label: string;
  machineId: string;
  endpoint: string;
}): Promise<string> {
  const receipt = await connectionCommand({
    type: "connection/create",
    packageId: input.type.packageId,
    connectionTypeId: input.type.connectionTypeId,
    label: input.label.slice(0, 120),
    settings: { "machine-id": input.machineId, endpoint: input.endpoint },
  });
  return receipt.connectionId;
}

export async function replaceKey(
  connectionId: string,
  apiKey: string,
): Promise<void> {
  const receipt = await connectionCommand({
    type: "connection/rotate-api-key",
    connectionId,
    apiKey,
  });
  if (receipt.status === "failed")
    throw new Error("That key didn’t work. Check it and try again.");
}

/**
 * Removes an account. A connected app and an MCP server are revoked through
 * their own Package; a provider's key is disconnected here, and revoking it
 * at the provider stays the provider's own surface.
 */
export async function removeAccount(
  packageId: string,
  connectionId: string,
): Promise<void> {
  if (packageId === APPS_PACKAGE_ID || packageId === MCP_PACKAGE_ID) {
    await api(
      `/api/plugins/${encodeURIComponent(packageId)}/connections/${encodeURIComponent(connectionId)}/revoke`,
      { body: { schemaVersion: 1, type: "connection/revoke" } },
    );
    return;
  }
  await connectionCommand({
    type: "connection/disconnect",
    connectionId,
    revokeUpstream: false,
  });
}

export async function addMcpServer(input: {
  connectionTypeId: string;
  address: string;
  name: string;
  token: string;
}): Promise<void> {
  const url = new URL(input.address);
  const label = (input.name.trim() || url.host).slice(0, 120);
  await connectionCommand({
    type: input.token ? "connection/create-api-key" : "connection/create",
    packageId: MCP_PACKAGE_ID,
    connectionTypeId: input.connectionTypeId,
    label,
    ...(input.token ? { apiKey: input.token } : {}),
    settings: { url: url.toString() },
  });
}

/** An https page on a host the answer allowed, and never anything else. */
function checkedDestination(link: string, hosts: readonly string[]): string {
  const url = new URL(link, location.origin);
  if (
    url.origin !== location.origin &&
    (url.protocol !== "https:" || url.username || !hosts.includes(url.host))
  )
    throw new Error("That link isn’t one FrockBot opens.");
  return url.toString();
}

function openOutside(url: string): void {
  if (framedByApp()) {
    // A framed page cannot open a window of its own; the app opens the
    // person's browser.
    void askHost({ type: "open", url }, "opened", 5_000).catch(() => undefined);
    return;
  }
  window.open(url, "_blank", "noopener");
}

interface DoorAnswer {
  status?: string;
  redirectUrl?: string;
}

async function openDoor(path: string, body: Record<string, unknown>) {
  const answer = await api<DoorAnswer>(path, { body });
  if (answer?.status === "ready") return false;
  if (typeof answer?.redirectUrl !== "string")
    throw new Error("The sign-in page isn’t available right now.");
  const url = new URL(answer.redirectUrl);
  if (url.protocol !== "https:" || url.username)
    throw new Error("That sign-in page isn’t one FrockBot opens.");
  window.open(url.toString(), "_blank", "noopener");
  return true;
}

/**
 * An app's sign-in. Framed, the app opens it, so a phone comes back to itself
 * when the sign-in closes; in a tab it opens beside this one.
 */
export async function connectApp(row: CatalogRow): Promise<void> {
  const commandId = newCommandId();
  if (framedByApp()) {
    const answer = await askHost(
      {
        type: "connect",
        packageId: row.packageId,
        connectionTypeId: row.connectionTypeId,
        commandId,
      },
      "door",
      120_000,
    );
    if (answer.ok !== true)
      throw new Error(
        typeof answer.message === "string"
          ? answer.message
          : "The sign-in didn’t open.",
      );
    return;
  }
  await openDoor(
    `/api/plugins/${encodeURIComponent(row.packageId)}/connections`,
    {
      schemaVersion: 1,
      type: "connection/start",
      commandId,
      connectionTypeId: row.connectionTypeId,
    },
  );
}

export async function signInToServer(connectionId: string): Promise<void> {
  const commandId = newCommandId();
  if (framedByApp()) {
    const answer = await askHost(
      { type: "mcp-sign-in", connectionId, commandId },
      "door",
      120_000,
    );
    if (answer.ok !== true)
      throw new Error(
        typeof answer.message === "string"
          ? answer.message
          : "The sign-in didn’t open.",
      );
    return;
  }
  await openDoor(
    `/api/plugins/${MCP_PACKAGE_ID}/connections/${encodeURIComponent(connectionId)}/authorize`,
    {
      schemaVersion: 1,
      type: "connection/start",
      commandId,
      connectionTypeId: "mcp-server",
    },
  );
}

/**
 * A payment step the payments Package offered: a checkout, the plan portal,
 * a top-up. Each opens the provider's page in the person's browser.
 */
export async function runPayment(
  action: PaymentsAction,
  cents?: number,
): Promise<void> {
  let link: unknown;
  if (action.target.kind === "url") link = action.target.url;
  else {
    const answer = await api<{ url?: string }>(action.target.path, {
      body: {
        id: newCommandId(),
        ...(action.target.body ?? {}),
        ...(cents === undefined ? {} : { cents }),
      },
    });
    link = answer?.url;
  }
  if (typeof link !== "string")
    throw new Error("The payment page isn’t available right now.");
  openOutside(checkedDestination(link, action.hosts));
}

/** The account's web search: FrockBot's, or a service of the person's own. */
export async function setWebSearch(
  choice:
    | { provider: "frockbot" }
    | { provider: "brave" | "exa" | "tavily"; apiKey: string }
    | { provider: "searxng"; url: string },
): Promise<void> {
  await api("/api/web-search", { method: "PUT", body: choice });
}

/** A move between plans, which the provider settles without a page. */
export async function changePlan(action: PaymentsAction): Promise<string> {
  if (action.target.kind !== "command")
    throw new Error("That plan change isn’t available here.");
  const answer = await api<{ plan?: string }>(action.target.path, {
    body: { id: newCommandId(), ...(action.target.body ?? {}) },
  });
  if (typeof answer?.plan !== "string")
    throw new Error("Your plan didn’t change. Try again.");
  return answer.plan;
}
