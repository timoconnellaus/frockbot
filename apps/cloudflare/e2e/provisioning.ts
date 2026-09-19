// The commands an e2e account is made of.
//
// Kept apart from `fixtures.ts` because none of this needs a browser: these
// are the request bodies the client posts, as plain values, so the shapes can
// be checked in the fast tier rather than only by a suite that boots
// `wrangler dev`. `fixtures.ts` owns the transport and the fences — which
// revision each command is sent against, and what is read back — because those
// are answers only the running authority has.
//
// Every body here is one the product's own client sends:
//
// - `user/set-package-enabled` is the Plugins row's switch.
// - `user/choose-model-provider` is the Models page's "Add a provider" save
//   (`modelsSettingsCommand` in `app/settings/settings-frame.ts` maps the
//   section to it). It resolves the Package's version and its dependencies out
//   of the deployment's own catalogue, which is why no version is named here.
// - `connection/create-api-key` is the provider's connect form, answered on
//   its "Advanced — custom server" branch: `api-base-url` is a shipped
//   Connection setting, not a test-only door.
// - `user/set-account-model` is the default-model picker's Save.
// - `bot/create` is the create sheet's Create.

/** The provider Package the e2e account's model comes from. */
export const E2E_PROVIDER_PACKAGE_ID = "provider-ollama-cloud";
/** The Connection type that Package declares for an API key. */
export const E2E_CONNECTION_TYPE_ID = "ollama-cloud-account";
/** The Package behind a per-Bot model override, seeded disabled. */
export const E2E_CUSTOM_MODELS_PACKAGE_ID = "custom-models";
/** The Connection setting the provider declares for a custom endpoint. */
export const E2E_API_BASE_URL_SETTING = "api-base-url";

/**
 * A Bot id from a name, by the client's own rule — `botIdFromNameV1` in
 * `apps/native/lib/flock/create.dart`: a slug of the name, then a suffix, so
 * two Bots called the same thing are two Bots.
 *
 * Mirrored rather than shared because the rule lives in Dart. What matters is
 * that an id this produces is one the authority accepts and the sidebar draws
 * a row for, which is what `sidebar-bot-<botId>` is then found by.
 */
export function botIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const stem = (slug.length === 0 ? "bot" : slug).slice(0, 80);
  return `${stem}-${crypto.randomUUID().replace(/-/gu, "").slice(0, 8)}`;
}

/** A command id of this suite's own, distinct per command as the client's is. */
function commandId(): string {
  return `e2e-${crypto.randomUUID()}`;
}

/** Turn Custom models on. The seed owns the revision this is fenced against. */
export function enableCustomModelsCommandV1(expectedRevision: number) {
  return {
    schemaVersion: 1,
    type: "user/set-package-enabled",
    commandId: commandId(),
    expectedRevision,
    packageId: E2E_CUSTOM_MODELS_PACKAGE_ID,
    enabled: true,
  } as const;
}

/** Choose the Ollama Cloud provider, as the Models page's picker does. */
export function chooseModelProviderCommandV1(expectedRevision: number) {
  return {
    schemaVersion: 1,
    type: "user/choose-model-provider",
    commandId: commandId(),
    expectedRevision,
    packageId: E2E_PROVIDER_PACKAGE_ID,
  } as const;
}

/**
 * Connect an account to the fake provider endpoint this test owns.
 *
 * Unfenced by design: a Connection command carries no `expectedRevision`. It
 * is made at-most-once by its `commandId`, which is what
 * `/api/connection-commands` looks a lost answer up by.
 */
export function connectApiKeyCommandV1(options: {
  label: string;
  apiKey: string;
  apiBaseUrl: string;
}) {
  return {
    schemaVersion: 1,
    type: "connection/create-api-key",
    commandId: commandId(),
    packageId: E2E_PROVIDER_PACKAGE_ID,
    connectionTypeId: E2E_CONNECTION_TYPE_ID,
    label: options.label,
    apiKey: options.apiKey,
    settings: { [E2E_API_BASE_URL_SETTING]: options.apiBaseUrl },
  } as const;
}

/** Bind the account's default model to a Connection's model. */
export function setAccountModelCommandV1(options: {
  expectedRevision: number;
  connectionId: string;
  providerModelId: string;
}) {
  return {
    schemaVersion: 1,
    type: "user/set-account-model",
    commandId: commandId(),
    expectedRevision: options.expectedRevision,
    model: {
      connectionId: options.connectionId,
      providerModelId: options.providerModelId,
    },
  } as const;
}

/**
 * Create the Bot. Fenced on the Flock directory's own revision, which is not
 * the settings revision and is read rather than assumed: an admitted User
 * already owns General.
 */
export function createBotCommandV1(options: {
  expectedRevision: number;
  botId: string;
  name: string;
}) {
  return {
    schemaVersion: 1,
    type: "bot/create",
    commandId: commandId(),
    expectedRevision: options.expectedRevision,
    botId: options.botId,
    name: options.name,
  } as const;
}
