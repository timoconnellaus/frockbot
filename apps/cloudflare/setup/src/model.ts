/**
 * What Setup reads, and what it makes of it. Pure: every page draws from
 * these, and the tests read them without a browser.
 *
 * The shapes are the account routes' own (`/api/settings?view=2`,
 * `/api/settings/connections`, `/api/billing`, `/api/billing/spending`),
 * narrowed to the fields Setup reads.
 */

export interface ModelBinding {
  connectionId: string;
  providerModelId: string;
}

export interface ConnectionModel {
  providerModelId: string;
  displayName: string;
  capabilities?: { tools?: boolean; vision?: boolean; reasoning?: boolean };
}

export interface Connection {
  connectionId: string;
  packageId: string;
  connectionTypeId: string;
  displayName: string;
  state:
    | "authorizing"
    | "ready"
    | "disabled"
    | "revoking"
    | "revoked"
    | "reconciliation-required"
    | "failed";
  authorization?: { kind: string };
  modelCatalog?: {
    state: "fresh" | "stale" | "refreshing" | "failed";
    models: ConnectionModel[];
    failure?: string;
  };
  settings?: Record<string, unknown>;
  failure?: string;
  pendingAuthorization?: unknown;
}

export interface PackageInstallation {
  packageId: string;
  version?: string;
  state: string;
  values?: Record<string, unknown>;
}

export interface Settings {
  revision: number;
  profile: { name: string; email?: string };
  packages: PackageInstallation[];
  connections: Connection[];
  platformModel?: ModelBinding;
  accountModel?: ModelBinding;
  appearance?: { look: "ink" | "paper" | "system" };
}

export interface SettingField {
  id: string;
  label: string;
  kind: "text" | "boolean" | "number" | "select" | "secret";
  value?: unknown;
  required?: boolean;
  hint?: string;
  choices?: { label: string; value: unknown }[];
}

export interface CatalogRow {
  packageId: string;
  connectionTypeId: string;
  displayName: string;
  kind: "model" | "connector";
  authorization: string;
  connected: number;
  mayConnect: boolean;
  installed: boolean;
  settings?: SettingField[];
  description?: string;
  icon?: string;
}

export interface CatalogAccount {
  id: string;
  label: string;
  state: Connection["state"];
  packageId: string;
  connectionTypeId: string;
  kind: "model" | "connector";
  authorization: string;
  detail: string;
  failure?: string;
}

export interface ConnectionsFrame {
  revision: number;
  accounts: CatalogAccount[];
  providers: CatalogRow[];
  nextCursor?: number;
}

export interface PaymentsAction {
  purpose: "subscribe" | "change-plan" | "top-up" | "manage" | string;
  plan?: string;
  label: string;
  target:
    | { kind: "url"; url: string }
    | { kind: "command"; path: string; body?: Record<string, string> };
  opens: "browser" | "in-app";
  hosts: string[];
}

export interface Billing {
  includedMicros: number;
  purchasedMicros: number;
  complimentaryMicros?: number;
  canSpend: boolean;
  subscribed: boolean;
  includedGrantedMicros: number;
  plan: {
    /** Cheapest first. A plan with no included credit is BYO. */
    subscriptions: {
      id: string;
      name: string;
      monthlyCents: number;
      includedMicros: number;
      /** `false` when the plan starts without the deployment's trial. */
      trial?: false;
      /** The Jev a paid month covers before credit is drawn. */
      jevFairUseMicros?: number;
    }[];
    trial: { days: number; creditMicros: number } | null;
    topUpCents: number[];
  };
  trial: { endsAt: number; creditMicros: number } | null;
  subscription: {
    planId: string;
    status: string;
    periodEnd: number;
    cancelAtPeriodEnd?: boolean;
  } | null;
  metered: boolean;
  paymentsAvailable: boolean;
  actions: PaymentsAction[];
  computerRate?: { activeUsdPerHour: number };
}

export interface SpendingGroup {
  key: string;
  label: string;
  chargeMicros: number;
  operations: number;
}

export interface Spending {
  totalMicros: number;
  groups: SpendingGroup[];
}

/** The platform's own model, which needs no key (`providers/frock-ai`). */
export const FROCK_AI_PACKAGE_ID = "provider-flock-ai";
export const MCP_PACKAGE_ID = "mcp";
export const APPS_PACKAGE_ID = "connect";
export const IMAGE_PACKAGE_ID = "image";
/** A model server on the person's Mac, reached through the app (`providers/local-model`). */
export const LOCAL_MODEL_PACKAGE_ID = "provider-local";

/**
 * The model servers people run on a Mac, at the port each listens on by
 * default. The backend refuses anything off the Mac's loopback whatever the
 * page sends.
 */
export const LOCAL_MODEL_SERVERS = [
  { id: "ollama", name: "Ollama", port: 11434 },
  { id: "lm-studio", name: "LM Studio", port: 1234 },
  { id: "mesh-llm", name: "mesh-llm", port: 9337 },
] as const;

/** The endpoint a server on `port` of the Mac answers at. */
export function localModelEndpoint(port: number): string {
  return `http://localhost:${port}/v1`;
}

/** A port as a person typed it, or undefined when it is not one. */
export function localModelPort(typed: string): number | undefined {
  const port = Number(typed.trim());
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
}

/** A paired Mac, as a local model is set up on one. */
export interface Mac {
  machineId: string;
  label: string;
  connected: boolean;
}

/** The account's paired Macs from `GET /api/machines`, connected ones first. */
export function macsOf(view: unknown): Mac[] {
  const machines = (view as { machines?: unknown } | null)?.machines;
  if (!Array.isArray(machines)) return [];
  const macs: Mac[] = [];
  for (const entry of machines as Record<string, unknown>[]) {
    if (
      entry?.platform !== "macos" ||
      entry.revokedAt !== undefined ||
      typeof entry.machineId !== "string" ||
      typeof entry.label !== "string"
    )
      continue;
    macs.push({
      machineId: entry.machineId,
      label: entry.label,
      connected: entry.connected === true,
    });
  }
  return macs.sort((a, b) => Number(b.connected) - Number(a.connected));
}

/** The providers most people reach for, in the order the picker lists them. */
export const POPULAR_PROVIDERS = [
  "provider-openai",
  "provider-anthropic",
  "provider-google",
  "provider-openrouter",
  "provider-deepseek",
  "provider-xai",
] as const;

export type ProviderGroup = "frockbot" | "popular" | "all";

export type ProviderState =
  "built-in" | "connected" | "refused" | "connecting" | "not-connected";

export interface Provider {
  packageId: string;
  name: string;
  description?: string;
  group: ProviderGroup;
  installed: boolean;
  /** The Connection Type a key connects, when it takes one. */
  keyType?: CatalogRow;
  /** Every way in: a key, a sign-in. */
  types: CatalogRow[];
  connections: Connection[];
  state: ProviderState;
}

function isLive(connection: Connection): boolean {
  return connection.state !== "revoked" && connection.state !== "revoking";
}

function providerState(connections: Connection[]): ProviderState {
  if (connections.some((c) => c.state === "ready")) return "connected";
  if (connections.some((c) => c.state === "failed")) return "refused";
  if (connections.length) return "connecting";
  return "not-connected";
}

/**
 * Every model provider the product supports, grouped as the picker draws
 * them: FrockBot's own first, then the popular ones, then the rest by name.
 */
export function providersOf(
  settings: Settings,
  catalog: CatalogRow[],
): Provider[] {
  const byPackage = new Map<string, CatalogRow[]>();
  for (const row of catalog) {
    if (row.kind !== "model") continue;
    byPackage.set(row.packageId, [
      ...(byPackage.get(row.packageId) ?? []),
      row,
    ]);
  }
  const frock: Provider = {
    packageId: FROCK_AI_PACKAGE_ID,
    name: "Frock AI",
    description: "Built in. No key needed.",
    group: "frockbot",
    installed: true,
    types: [],
    connections: settings.connections.filter(
      (c) => c.packageId === FROCK_AI_PACKAGE_ID && isLive(c),
    ),
    state: "built-in",
  };
  const rest: Provider[] = [];
  for (const [packageId, types] of byPackage) {
    if (packageId === FROCK_AI_PACKAGE_ID) continue;
    const connections = settings.connections.filter(
      (c) => c.packageId === packageId && isLive(c),
    );
    const keyType = types.find((row) => row.authorization === "api-key");
    rest.push({
      packageId,
      name: types[0]!.displayName,
      ...(types[0]!.description ? { description: types[0]!.description } : {}),
      group: (POPULAR_PROVIDERS as readonly string[]).includes(packageId)
        ? "popular"
        : "all",
      installed: types.some((row) => row.installed),
      ...(keyType ? { keyType } : {}),
      types,
      connections,
      state: providerState(connections),
    });
  }
  rest.sort((a, b) => {
    if (a.group !== b.group) return a.group === "popular" ? -1 : 1;
    if (a.group === "popular")
      return (
        POPULAR_PROVIDERS.indexOf(a.packageId as never) -
        POPULAR_PROVIDERS.indexOf(b.packageId as never)
      );
    return a.name.localeCompare(b.name);
  });
  return [frock, ...rest];
}

/** A search over names and descriptions, as a person types it. */
export function matchProviders(
  providers: Provider[],
  query: string,
): Provider[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return providers;
  return providers.filter((provider) =>
    [provider.name, provider.description ?? "", provider.packageId]
      .join(" ")
      .toLocaleLowerCase()
      .includes(needle),
  );
}

/** The models a Connection can be chosen with: those that can use tools. */
export function chatModels(connection: Connection): ConnectionModel[] {
  return (connection.modelCatalog?.models ?? []).filter(
    (model) => model.capabilities?.tools !== false,
  );
}

export interface Chat {
  /** Frock AI when no model of the person's own is chosen. */
  mode: "frock" | "custom";
  provider: Provider | undefined;
  connection: Connection | undefined;
  model: ConnectionModel | undefined;
  binding: ModelBinding | undefined;
  /** Why the chosen provider cannot answer now. */
  failure?: string;
}

/** What chat runs on for every Bot without its own choice. */
export function chatOf(settings: Settings, providers: Provider[]): Chat {
  const binding = settings.accountModel;
  const connection = binding
    ? settings.connections.find((c) => c.connectionId === binding.connectionId)
    : settings.connections.find(
        (c) => c.connectionId === settings.platformModel?.connectionId,
      );
  const provider = providers.find(
    (candidate) =>
      candidate.packageId === (connection?.packageId ?? FROCK_AI_PACKAGE_ID),
  );
  const chosenId =
    binding?.providerModelId ?? settings.platformModel?.providerModelId;
  const model = connection?.modelCatalog?.models.find(
    (candidate) => candidate.providerModelId === chosenId,
  );
  const custom =
    binding !== undefined && connection?.packageId !== FROCK_AI_PACKAGE_ID;
  let failure: string | undefined;
  if (custom) {
    if (!connection || !isLive(connection))
      failure = "The account chat used was removed.";
    else if (connection.state === "failed")
      failure = connection.failure ?? "The provider refused the key.";
    else if (connection.state === "disabled")
      failure = "The account chat uses is turned off.";
    else if (connection.state !== "ready")
      failure = "The account chat uses needs you to finish signing in.";
    else if (connection.modelCatalog && !model)
      failure = "The chosen model is no longer offered by the provider.";
  }
  return {
    mode: custom ? "custom" : "frock",
    provider,
    connection,
    model,
    binding: custom ? binding : undefined,
    ...(failure ? { failure } : {}),
  };
}

/** A provider's name as a person says it, for a Connection. */
export function providerName(
  providers: Provider[],
  connection: Connection | undefined,
): string {
  if (!connection) return "Unknown";
  return (
    providers.find((p) => p.packageId === connection.packageId)?.name ??
    connection.displayName
  );
}

export interface Job {
  id: string;
  name: string;
  purpose: string;
  provider: string;
  model: string;
  paidBy: string;
  /** Follows chat until someone changes it. */
  follows?: boolean;
  /** Its own choice is not open yet. */
  comingSoon?: boolean;
  failure?: string;
  editable?: "chat" | "images";
}

export const IMAGE_MODELS: readonly { id: string; label: string }[] = [
  { id: "@cf/black-forest-labs/flux-1-schnell", label: "FLUX.1 Schnell" },
  { id: "@cf/black-forest-labs/flux-2-klein-4b", label: "FLUX.2 Klein" },
  {
    id: "@cf/stabilityai/stable-diffusion-xl-base-1.0",
    label: "Stable Diffusion XL",
  },
  {
    id: "@cf/bytedance/stable-diffusion-xl-lightning",
    label: "Stable Diffusion XL Lightning",
  },
];

export function imageModelOf(settings: Settings): string {
  const value = settings.packages.find((p) => p.packageId === IMAGE_PACKAGE_ID)
    ?.values?.model;
  return typeof value === "string" ? value : IMAGE_MODELS[0]!.id;
}

function paidByFor(chat: Chat, providers: Provider[]): string {
  return chat.mode === "frock"
    ? "From FrockBot credit"
    : `Your ${providerName(providers, chat.connection)} account`;
}

/**
 * Every job a model does, and what does it. Chat is the person's to choose;
 * writing, coding, thinking and vision follow it. The rest are FrockBot's
 * until choosing them opens.
 */
export function jobsOf(
  settings: Settings,
  providers: Provider[],
  chat: Chat,
): { chat: Job[]; other: Job[] } {
  const chatProvider =
    chat.mode === "frock"
      ? "Frock AI"
      : providerName(providers, chat.connection);
  const chatModel =
    chat.model?.displayName ??
    (chat.mode === "frock"
      ? "Automatic"
      : (chat.binding?.providerModelId ?? ""));
  const paidBy = paidByFor(chat, providers);
  const follow = (id: string, name: string, purpose: string): Job => ({
    id,
    name,
    purpose,
    provider: `Same as chat (${chatProvider})`,
    model: chatModel,
    paidBy: "Follows chat",
    follows: true,
    comingSoon: true,
  });
  const image = IMAGE_MODELS.find((m) => m.id === imageModelOf(settings));
  const imagesInstalled = settings.packages.some(
    (p) => p.packageId === IMAGE_PACKAGE_ID && p.state === "installed",
  );
  return {
    chat: [
      {
        id: "chat",
        name: "Chat",
        purpose: "Talking with you",
        provider: chatProvider,
        model: chatModel,
        paidBy,
        editable: "chat",
        ...(chat.failure ? { failure: chat.failure } : {}),
      },
      follow("writing", "Writing", "Drafts, emails, long text"),
      follow("coding", "Coding", "Scripts on the computer"),
      follow("thinking", "Thinking", "Hard problems"),
      follow("vision", "Vision", "Reading images"),
      {
        id: "summaries",
        name: "Summaries",
        purpose: "Keeping long chats short",
        provider: "Frock AI",
        model: "Frock structured",
        paidBy: "From FrockBot credit",
        comingSoon: true,
      },
    ],
    other: [
      {
        id: "jev",
        name: "Jev",
        purpose: "Checks every step",
        provider: "Frock AI",
        model: "Jev",
        paidBy: "Included in your plan",
        comingSoon: true,
      },
      {
        id: "voice",
        name: "Voice calls",
        purpose: "Talking live",
        provider: "Google",
        model: "Gemini Live",
        paidBy: "From FrockBot credit",
        comingSoon: true,
      },
      {
        id: "dictation",
        name: "Dictation",
        purpose: "Speaking instead of typing",
        provider: "OpenAI",
        model: "GPT Live Transcribe",
        paidBy: "From FrockBot credit",
        comingSoon: true,
      },
      {
        id: "images",
        name: "Images",
        purpose: "Pictures your bots make",
        provider: "Frock AI",
        model: image?.label ?? "FLUX.1 Schnell",
        paidBy: "From FrockBot credit",
        ...(imagesInstalled
          ? { editable: "images" as const }
          : { comingSoon: true }),
      },
    ],
  };
}

/** What a Connection is for, in the words a person would use. */
export function usesOf(connection: Connection, settings: Settings): string[] {
  if (connection.packageId === MCP_PACKAGE_ID) return ["Your bots’ tools"];
  if (connection.packageId === APPS_PACKAGE_ID) return ["Your bots"];
  if (settings.accountModel?.connectionId === connection.connectionId)
    return ["Chat", "Writing", "Coding", "Thinking", "Vision"];
  return [];
}

export function listWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)!}`;
}

export type SetupPage =
  "overview" | "plan" | "computer" | "ai" | "search" | "apps" | "accounts";

export interface NeedsYou {
  id: string;
  title: string;
  detail: string;
  page: SetupPage;
  action: string;
}

/** Everything broken that only the person can fix, most urgent first. */
export function needsYouOf(
  settings: Settings,
  providers: Provider[],
  chat: Chat,
  billing: Billing | undefined,
): NeedsYou[] {
  const items: NeedsYou[] = [];
  if (chat.failure)
    items.push({
      id: "chat",
      title: `${providerName(providers, chat.connection)} can’t answer chat`,
      detail: `${chat.failure} Until it’s fixed, your bots answer with Frock AI from your credit. Fix the account, or choose another provider for chat.`,
      page: "ai",
      action: "Fix in AI",
    });
  for (const connection of settings.connections) {
    if (!isLive(connection)) continue;
    if (
      connection.connectionId === chat.connection?.connectionId &&
      chat.failure
    )
      continue;
    if (connection.state === "failed")
      items.push({
        id: connection.connectionId,
        title: `${connection.displayName} isn’t working`,
        detail:
          connection.failure ??
          "It refused the last request. Replace its key or sign in again.",
        page: "accounts",
        action: "Fix in Your accounts",
      });
    else if (
      connection.state === "reconciliation-required" ||
      connection.pendingAuthorization
    )
      items.push({
        id: connection.connectionId,
        title: `${connection.displayName} needs you to sign in again`,
        detail: "Your bots can’t use it until you do.",
        page: connection.packageId === MCP_PACKAGE_ID ? "apps" : "accounts",
        action: "Sign in",
      });
  }
  if (billing?.metered && !billing.canSpend)
    items.push({
      id: "billing",
      title: "Your bots have run out of credit",
      detail: "Paid work is paused. Top up or choose a plan to keep going.",
      page: "plan",
      action: "Fix in Plan and credit",
    });
  return items;
}

/** A plan's price, as the page writes it. */
export function dollars(cents: number): string {
  return cents % 100 === 0
    ? `US$${cents / 100}`
    : `US$${(cents / 100).toFixed(2)}`;
}

export function microsToDollars(micros: number): string {
  return `US$${(micros / 1_000_000).toFixed(2)}`;
}

export interface WebSearchChoice {
  provider: "frockbot" | "brave" | "exa" | "tavily" | "searxng";
  updatedAt?: string;
}

/**
 * The plan that suits how this account is set up, and why, in one sentence.
 * FrockBot's computer and Frock AI draw on credit, so they suit a plan that
 * includes some; an account that brings its own models needs less of it. The
 * person still picks.
 */
export function suggestPlan(
  chat: Chat,
  billing: Billing,
  spentLast30DaysMicros: number | undefined,
): { planId: string | undefined; why: string } {
  const withCredit = billing.plan.subscriptions.filter(
    (plan) => plan.includedMicros > 0,
  );
  const standard = withCredit[0];
  const bigger = withCredit.find(
    (plan) => standard && plan.includedMicros > standard.includedMicros,
  );
  const byo = billing.plan.subscriptions.find(
    (plan) => plan.includedMicros === 0,
  );
  if (
    bigger &&
    standard &&
    spentLast30DaysMicros !== undefined &&
    spentLast30DaysMicros > standard.includedMicros
  )
    return {
      planId: bigger.id,
      why: `${bigger.name} suits your setup because your bots used ${microsToDollars(spentLast30DaysMicros)} of credit in the last 30 days, more than ${standard.name} includes.`,
    };
  if (!standard)
    return {
      planId: byo?.id,
      why: `${byo?.name ?? "BYO"} is the plan this install sells.`,
    };
  if (chat.mode === "custom")
    return {
      planId: standard.id,
      why: `${standard.name} suits your setup because your bots use FrockBot’s computer, which runs on credit.${byo ? ` With your own computer as well as your own models, ${byo.name} would be enough.` : ""}`,
    };
  return {
    planId: standard.id,
    why: `${standard.name} suits your setup because your bots use FrockBot’s computer and Frock AI, which both run on credit.`,
  };
}

const CATEGORY_LABELS: Record<string, string> = {
  model: "Frock AI, chat and jobs",
  summary: "Frock AI, summaries",
  search: "Web search",
  computer: "Computer",
  jev: "Jev",
};

export interface UsageRow {
  label: string;
  amount: string;
}

/** What used credit this billing month, and what never does. */
export function usageRowsOf(
  spending: Spending | undefined,
  settings: Settings,
  providers: Provider[],
): UsageRow[] {
  const rows: UsageRow[] = [];
  let jev = false;
  for (const group of spending?.groups ?? []) {
    if (group.key === "jev") {
      jev = true;
      rows.push({ label: "Jev", amount: "Included" });
      continue;
    }
    if (group.chargeMicros <= 0) continue;
    rows.push({
      label: CATEGORY_LABELS[group.key] ?? group.label,
      amount: microsToDollars(group.chargeMicros),
    });
  }
  if (!jev) rows.push({ label: "Jev", amount: "Included" });
  const own = [
    ...new Set(
      settings.connections
        .filter(
          (c) =>
            isLive(c) &&
            c.packageId.startsWith("provider-") &&
            c.packageId !== FROCK_AI_PACKAGE_ID,
        )
        .map((c) => providerName(providers, c)),
    ),
  ];
  if (own.length)
    rows.push({ label: `Your own ${listWords(own)}`, amount: "Paid to them" });
  return rows;
}

/** Who runs each part: FrockBot, or the person. */
export interface StripCell {
  name: string;
  detail: string;
  yours: boolean;
}

export function stripOf(
  chat: Chat,
  providers: Provider[],
  settings: Settings,
  ownSearch = false,
): StripCell[] {
  const own = [
    ...new Set(
      settings.connections
        .filter(
          (c) =>
            isLive(c) &&
            c.packageId.startsWith("provider-") &&
            c.packageId !== FROCK_AI_PACKAGE_ID,
        )
        .map((c) => providerName(providers, c)),
    ),
  ];
  const servers = settings.connections.filter(
    (c) => c.packageId === MCP_PACKAGE_ID && isLive(c),
  ).length;
  return [
    { name: "FrockBot", detail: "The app", yours: false },
    { name: "Computer", detail: "FrockBot’s cloud", yours: false },
    {
      name: "Chat and jobs",
      detail:
        chat.mode === "custom"
          ? listWords([providerName(providers, chat.connection), "Frock AI"])
          : "Frock AI",
      yours: chat.mode === "custom",
    },
    { name: "Jev", detail: "Frock AI", yours: false },
    { name: "Voice and dictation", detail: "FrockBot’s", yours: false },
    {
      name: "Search and apps",
      detail: [
        ownSearch ? "Your search" : "FrockBot’s search",
        servers
          ? `${servers} server${servers === 1 ? "" : "s"} of yours`
          : "FrockBot’s apps",
      ].join(" · "),
      yours: ownSearch,
    },
  ].map((cell) =>
    cell.name === "Chat and jobs" && own.length && chat.mode === "frock"
      ? { ...cell, detail: `Frock AI (${listWords(own)} added)` }
      : cell,
  );
}
