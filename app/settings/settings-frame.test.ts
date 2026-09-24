import { expect, test } from "bun:test";
import type { UserSettingsViewV1 } from "@frockbot/core/configuration";
import { isProtocolValue } from "@frockbot/core/protocol-schemas";
import {
  applicationSettingsFrame,
  applicationSettingsCommand,
  connectionsCatalogQueryV1,
  connectionsFrame,
  modelSettingsOptions,
  modelsSettingsFrame,
  modelsSettingsCommand,
} from "./settings-frame.js";
import type {
  AvailableUserPackage,
  UserSettingsStorage,
  UserSettingsTransaction,
} from "./user.js";

const provider: AvailableUserPackage = {
  packageId: "provider",
  version: "1.0.0",
  displayName: "Example AI",
  capabilities: [{ id: "models", kind: "model", connectionTypes: ["account"] }],
  connectionTypes: [
    {
      id: "account",
      displayName: "Account",
      allowMultiple: true,
      authorization: { kind: "api-key" },
      capabilities: ["models"],
    },
  ],
};
function settings(count = 151): UserSettingsViewV1 {
  return {
    schemaVersion: 1,
    revision: 8,
    profile: { name: "Tim" },
    packages: [{ packageId: "provider", version: "1.0.0", state: "installed" }],
    connections: [
      {
        connectionId: "work",
        packageId: "provider",
        connectionTypeId: "account",
        displayName: "Work",
        state: "ready",
        providerType: "example",
        safeMetadata: {},
        modelCatalog: {
          schemaVersion: 1,
          generation: "catalog-1",
          state: "fresh",
          models: Array.from({ length: count }, (_, i) => ({
            providerModelId: `model-${i}`,
            displayName: `Model ${i}`,
            capabilities: { tools: true, vision: false, reasoning: false },
            source: "discovered",
          })),
        },
      },
    ],
    platformModel: { connectionId: "work", providerModelId: "auto" },
  };
}
const query = {
  schemaVersion: 1,
  source: "account-models",
  revision: 8,
  query: "",
};
/** A Marketplace read, as the route decodes it from `?catalog=1&…`. */
const catalogQuery = (search = "") =>
  connectionsCatalogQueryV1(new URLSearchParams(`catalog=1&${search}`))!;
const everything = catalogQuery("limit=2000");

test("large catalogs page completely, search beyond the first page, and fence revision changes", () => {
  const user = settings();
  const values: unknown[] = [];
  let cursor: number | undefined;
  do {
    const page = modelSettingsOptions("tim", user, [provider], {
      ...query,
      ...(cursor === undefined ? {} : { cursor }),
    });
    expect(page.items.length).toBeLessThanOrEqual(50);
    values.push(...page.items.map((choice) => choice.value));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  expect(values).toHaveLength(152);
  expect(new Set(values.map((value) => JSON.stringify(value))).size).toBe(152);
  expect(
    modelSettingsOptions("tim", user, [provider], {
      ...query,
      query: "model 150",
    }).items,
  ).toEqual([
    {
      label: "Model 150 · Work",
      value: { connectionId: "work", providerModelId: "model-150" },
    },
  ]);
  expect(() =>
    modelSettingsOptions("tim", { ...user, revision: 9 }, [provider], query),
  ).toThrow("revision");
});

test("disabled, revoked and wrong-version providers disappear while saved choices remain inspectable", () => {
  const user = settings();
  user.accountModel = { connectionId: "work", providerModelId: "model-150" };
  for (const mutate of [
    (u: UserSettingsViewV1) => {
      u.packages[0]!.state = "disabled";
    },
    (u: UserSettingsViewV1) => {
      u.connections[0]!.state = "revoked";
    },
    (u: UserSettingsViewV1) => {
      u.packages[0]!.version = "2.0.0";
    },
  ]) {
    const unavailable = structuredClone(user);
    mutate(unavailable);
    expect(
      modelSettingsOptions("tim", unavailable, [provider], query).items.map(
        (c) => c.value,
      ),
    ).toEqual([null]);
    const field = modelsSettingsFrame("tim", unavailable, [provider])
      .sections[0]!.fields[0]!;
    expect(field.value).toEqual({ ...user.accountModel! });
    expect(field.choices?.at(-1)?.label).toContain("unavailable");
  }
  const platform = modelsSettingsFrame("tim", user, [
    { ...provider, platformOwned: true },
  ]);
  expect(platform.sections).toHaveLength(1);
  expect(platform.sections[0]!.fields[0]!.choices![0]!.label).toBe(
    "Automatic — recommended",
  );
});

test("one manifest home, disabled controls absent, reset distinct from explicit nullable values", () => {
  const user = settings();
  const control: AvailableUserPackage = {
    packageId: "preferences",
    version: "1.0.0",
    settings: [
      {
        id: "nullable",
        schemaVersion: 1,
        scopes: ["user"],
        schema: { enum: [null, "chosen"] },
      },
      {
        id: "toggle",
        schemaVersion: 1,
        scopes: ["user"],
        schema: { type: "boolean" },
      },
    ],
  };
  user.packages.push({
    packageId: control.packageId,
    version: control.version,
    state: "installed",
    values: { nullable: null },
  });
  const frame = applicationSettingsFrame("tim", user, [provider, control]);
  expect(frame.sections.map((s) => s.id)).toEqual([
    "profile",
    "appearance",
    "package.preferences",
  ]);
  expect(frame.sections[2]!.fields).toMatchObject([
    { id: "nullable", isSet: true, canReset: true, value: null },
    { id: "toggle", isSet: false, canReset: true },
  ]);
  user.packages[1]!.state = "disabled";
  expect(
    applicationSettingsFrame("tim", user, [provider, control]).sections,
  ).toHaveLength(2);
  expect(user.packages[1]!.values).toEqual({ nullable: null });
});

test("identity prefills an unsaved profile while saved fields remain authoritative", () => {
  const user = settings();
  user.profile = { name: "FrockBot user" };
  const hinted = applicationSettingsFrame("tim", user, [provider], {
    name: "Timothy",
    email: "tim@example.test",
  });
  expect(hinted.sections[0]!.fields.map((f) => f.value)).toEqual([
    "Timothy",
    "tim@example.test",
    "UTC",
  ]);
  expect(
    applicationSettingsFrame("tim", user, [provider], {
      name: "Timothy",
      email: "tim@example.test",
      image: "https://lh3.googleusercontent.com/a/photo",
    }).sections[0]!.fields.map((f) => ({ id: f.id, value: f.value })),
  ).toContainEqual({
    id: "photo",
    value: "https://lh3.googleusercontent.com/a/photo",
  });
  expect(user.profile).toEqual({ name: "FrockBot user" });
  user.profile = { name: "Tim", email: "chosen@example.test" };
  expect(
    applicationSettingsFrame("tim", user, [provider], {
      name: "Timothy",
      email: "tim@example.test",
    }).sections[0]!.fields.map((f) => f.value),
  ).toEqual(["Tim", "chosen@example.test", "UTC"]);
});

test("the released model reader retains the account fallback without the removed control", async () => {
  const { createUserSettingsBackendContribution } = await import("./user.js");
  const { resolveReleasedModelPolicy } =
    await import("./fixtures/model-policy-v0.3.39.js");
  const { resolveEffectiveBotModelV1 } =
    await import("@frockbot/core/configuration");
  const values = new Map<string, unknown>();
  const storage: UserSettingsStorage = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === "string") values.set(key, value);
      else for (const [k, v] of Object.entries(key)) values.set(k, v);
    },
    transaction: async <T>(
      fn: (storage: UserSettingsTransaction) => Promise<T>,
    ): Promise<T> => fn(storage),
  };
  const owner = createUserSettingsBackendContribution({
    storage,
    availablePackages: [provider],
  });
  const user = settings();
  user.accountModel = { connectionId: "work", providerModelId: "model-150" };
  const packages = [
    {
      ...provider,
      settings: [],
      capabilities: [...provider.capabilities!],
      connectionTypes: [...provider.connectionTypes!],
    },
  ];
  const previous = owner.previousSettingsView(user);
  expect(previous).not.toHaveProperty("accountModel");
  expect(
    previous.packages.every(
      (p) => !Object.hasOwn(p.values ?? {}, "account-model"),
    ),
  ).toBe(true);
  expect(
    resolveReleasedModelPolicy({
      bot: { packageValues: {} },
      user: previous,
      packages,
    }).model,
  ).toEqual(
    resolveEffectiveBotModelV1({ bot: { packageValues: {} }, user, packages })
      .model,
  );
  user.connections[0]!.state = "revoked";
  expect(owner.previousSettingsView(user).platformModel).toEqual(
    user.platformModel,
  );
});

test("the platform binding has one Auto choice", () => {
  const user = settings(2);
  user.platformModel = { connectionId: "work", providerModelId: "model-0" };
  const options = modelSettingsOptions("tim", user, [provider], query);
  expect(options.items.map((item) => item.value)).toEqual([
    null,
    { connectionId: "work", providerModelId: "model-1" },
  ]);
});

test("provider knobs have one Models home, and a provider that is not added has no section", () => {
  const user = settings(1);
  const declared = {
    ...provider,
    settings: [
      {
        id: "limit",
        schemaVersion: 1 as const,
        scopes: ["user" as const],
        schema: { type: "integer" as const, minimum: 1, maximum: 10 },
      },
    ],
  };
  user.packages[0]!.values = { limit: 4 };
  expect(
    modelsSettingsFrame("tim", user, [declared]).sections[1]!.fields,
  ).toMatchObject([{ id: "limit", value: 4, canReset: true }]);
  expect(
    applicationSettingsFrame("tim", user, [declared]).sections,
  ).toHaveLength(2);
  // Removed with a key left behind is not added: the Marketplace is the way
  // back, and the values wait for it.
  user.packages[0]!.state = "disabled";
  expect(
    modelsSettingsFrame("tim", user, [declared]).sections.map(
      (section) => section.id,
    ),
  ).toEqual(["model"]);
  expect(user.packages[0]!.values).toEqual({ limit: 4 });
  expect(
    modelsSettingsCommand({
      schemaVersion: 1,
      commandId: "reset-limit",
      ownerId: "tim",
      expectedRevision: 8,
      sectionId: "provider.provider",
      values: {},
      unset: ["limit"],
    }),
  ).toMatchObject({ type: "user/set-package-settings", unset: ["limit"] });
});

test("Models lists only providers already added, not the rest of the catalog", () => {
  const user = settings();
  const together: AvailableUserPackage = {
    ...provider,
    packageId: "provider-together",
    displayName: "Together",
  };
  expect(
    modelsSettingsFrame("tim", user, [provider, together]).sections.map(
      (section) => section.id,
    ),
  ).toEqual(["model", "provider.provider"]);
  expect(() =>
    modelsSettingsCommand({
      schemaVersion: 1,
      commandId: "add-together",
      ownerId: "tim",
      expectedRevision: 8,
      sectionId: "add-provider",
      values: { provider: "provider-together" },
    }),
  ).toThrow("Unknown model section");
  user.packages.push({
    packageId: "provider-together",
    version: "1.0.0",
    state: "disabled",
  });
  expect(
    modelsSettingsFrame("tim", user, [provider, together]).sections.map(
      (section) => section.id,
    ),
  ).toEqual(["model", "provider.provider"]);
  user.packages[1]!.state = "installed";
  expect(
    modelsSettingsFrame("tim", user, [provider, together]).sections.map(
      (section) => section.id,
    ),
  ).toEqual(["model", "provider.provider", "provider.provider-together"]);
});

test("the Marketplace catalog lists uninstalled models and installed connectors", () => {
  const user = settings();
  user.packages = [];
  const gmail: AvailableUserPackage = {
    packageId: "connect",
    version: "1.0.0",
    displayName: "Connected apps",
    connectionTypes: [
      {
        id: "connect-gmail",
        displayName: "Gmail",
        description: "Read Gmail.",
        icon: "gmail",
        allowMultiple: true,
        authorization: { kind: "grant" },
        capabilities: ["gmail-tools"],
      },
      {
        id: "connect-slack",
        displayName: "Slack",
        description: "Post to Slack.",
        icon: "slack",
        allowMultiple: true,
        authorization: { kind: "grant" },
        capabilities: ["slack-tools"],
      },
    ],
  };
  const together: AvailableUserPackage = {
    ...provider,
    packageId: "provider-together",
    displayName: "Together",
    connectionTypes: [
      {
        id: "together-account",
        displayName: "Together account",
        icon: "together",
        allowMultiple: true,
        authorization: { kind: "api-key" },
        capabilities: ["models"],
      },
    ],
  };
  const installedOnly = connectionsFrame("tim", user, [together, gmail]);
  expect(installedOnly.providers).toEqual([]);
  user.packages.push({
    packageId: "connect",
    version: "1.0.0",
    state: "installed",
  });
  // The ordinary read carries an app only once it has an account.
  expect(connectionsFrame("tim", user, [together, gmail]).providers).toEqual(
    [],
  );
  const catalog = connectionsFrame("tim", user, [together, gmail], {
    catalog: everything,
  });
  expect(catalog.providers.map((row) => row.displayName)).toEqual([
    "Gmail",
    "Slack",
    "Together",
  ]);
  expect(catalog.providers[0]).toMatchObject({
    kind: "connector",
    mayConnect: true,
    installed: true,
    icon: "gmail",
  });
  expect(catalog.providers[2]).toMatchObject({
    kind: "model",
    mayConnect: false,
    installed: false,
    connected: 0,
    icon: "together",
    description: "Use Together models with your own key.",
  });
  // Connectors keep the order their Package declares, ahead of the models.
  const declared = connectionsFrame(
    "tim",
    user,
    [
      together,
      {
        ...gmail,
        connectionTypes: [...(gmail.connectionTypes ?? [])].reverse(),
      },
    ],
    { catalog: everything },
  );
  expect(declared.providers.map((row) => row.displayName)).toEqual([
    "Slack",
    "Gmail",
    "Together",
  ]);
});

test("a model provider that takes a key or a sign-in is named once, for itself", () => {
  const user = settings();
  user.packages = [];
  const openRouter: AvailableUserPackage = {
    ...provider,
    packageId: "provider-openrouter",
    displayName: "OpenRouter",
    connectionTypes: [
      {
        id: "openrouter-account",
        displayName: "OpenRouter account",
        icon: "openrouter",
        allowMultiple: true,
        authorization: { kind: "api-key" },
        capabilities: ["models"],
      },
      {
        id: "openrouter-oauth",
        displayName: "OpenRouter sign-in",
        icon: "openrouter",
        allowMultiple: true,
        authorization: { kind: "grant" },
        capabilities: ["models"],
      },
    ],
  };
  const rows = connectionsFrame("tim", user, [openRouter], {
    catalog: everything,
  }).providers;
  // One row per way in, so each keeps its own command and accounts, and both
  // carry the provider's own name and one description: a client draws them
  // as the one card they are.
  expect(rows.map((row) => [row.connectionTypeId, row.authorization])).toEqual([
    ["openrouter-account", "api-key"],
    ["openrouter-oauth", "grant"],
  ]);
  for (const row of rows) {
    expect(row).toMatchObject({
      displayName: "OpenRouter",
      kind: "model",
      description: "Use OpenRouter models with your own key, or sign in.",
    });
  }
  const signInOnly = connectionsFrame(
    "tim",
    user,
    [{ ...openRouter, connectionTypes: [openRouter.connectionTypes![1]!] }],
    { catalog: everything },
  ).providers[0]!;
  expect(signInOnly.description).toBe("Use OpenRouter models by signing in.");
});

test("a model removed with a key left behind is offered again, not shown as added", () => {
  const user = settings();
  user.packages[0]!.state = "disabled";
  const row = connectionsFrame("tim", user, [provider], { catalog: everything })
    .providers[0]!;
  // The key is still there, but the provider is not: Add is what brings it
  // back, so the row says it is not installed rather than connected.
  expect(row).toMatchObject({ connected: 1, installed: false });
  expect(row.mayConnect).toBe(false);
});

test("the Marketplace is searched, filtered and paged where it is read", () => {
  const user = settings();
  user.packages.push({
    packageId: "connect",
    version: "1.0.0",
    state: "installed",
  });
  user.connections.push({
    connectionId: "app-7",
    packageId: "connect",
    connectionTypeId: "connect-app-7",
    displayName: "App 7",
    state: "ready",
    providerType: "connect",
    safeMetadata: {},
  });
  const apps: AvailableUserPackage = {
    packageId: "connect",
    version: "1.0.0",
    displayName: "Connected apps",
    connectionTypes: Array.from({ length: 60 }, (_, i) => ({
      id: `connect-app-${i}`,
      displayName: `App ${i}`,
      description: i === 42 ? "Sends invoices." : `App number ${i}.`,
      allowMultiple: true,
      authorization: { kind: "grant" as const },
      capabilities: [`app-${i}-tools`],
    })),
  };
  const openRouter: AvailableUserPackage = {
    ...provider,
    packageId: "provider-openrouter",
    displayName: "OpenRouter",
    connectionTypes: [
      {
        id: "openrouter-account",
        displayName: "OpenRouter account",
        allowMultiple: true,
        authorization: { kind: "api-key" },
        capabilities: ["models"],
      },
      {
        id: "openrouter-oauth",
        displayName: "OpenRouter sign-in",
        allowMultiple: true,
        authorization: { kind: "grant" },
        capabilities: ["models"],
      },
    ],
  };
  const together: AvailableUserPackage = {
    ...provider,
    packageId: "provider-together",
    displayName: "Together",
  };
  const read = (
    search: string,
    options: { unmountable?: readonly string[] } = {},
  ) =>
    connectionsFrame("tim", user, [apps, openRouter, together, provider], {
      catalog: catalogQuery(search),
      ...options,
    });
  const names = (search: string) =>
    read(search).providers.map((row) => row.displayName);

  // A page is fifty cards, and says where the next one starts.
  const first = read("");
  expect(first.providers.map((row) => row.displayName)).toEqual(
    Array.from({ length: 50 }, (_, i) => `App ${i}`),
  );
  expect(first.nextCursor).toBe(50);
  // Every page carries every account, so a card on any page can list its own.
  expect(first.accounts.map((account) => account.id)).toEqual([
    "work",
    "app-7",
  ]);
  const last = read("cursor=50");
  expect(last.providers.map((row) => row.displayName)).toEqual([
    ...Array.from({ length: 10 }, (_, i) => `App ${i + 50}`),
    "Example AI",
    "OpenRouter",
    "OpenRouter",
    "Together",
  ]);
  expect(last.nextCursor).toBeUndefined();
  // A model provider's ways in are one card, so a page never ends between
  // them; the cursor counts cards.
  const window = read("limit=62");
  expect(window.providers.slice(-3).map((row) => row.connectionTypeId)).toEqual(
    ["account", "openrouter-account", "openrouter-oauth"],
  );
  expect(window.nextCursor).toBe(62);
  expect(names("cursor=62")).toEqual(["Together"]);

  // Search reaches every page, by name, description, kind or Package.
  expect(names("q=invoices")).toEqual(["App 42"]);
  expect(names("q=%20OPENROUTER%20")).toEqual(["OpenRouter", "OpenRouter"]);
  expect(names("q=provider-together")).toEqual(["Together"]);
  expect(names("q=nothing-like-it")).toEqual([]);

  expect(names("kinds=model")).toEqual([
    "Example AI",
    "OpenRouter",
    "OpenRouter",
    "Together",
  ]);
  expect(read("kinds=").providers).toEqual([]);
  expect(read("kinds=").nextCursor).toBeUndefined();
  // Installed is the models that are added and the apps with an account.
  expect(names("installed=1")).toEqual(["App 7", "Example AI"]);

  // A Package this deployment cannot run is offered only while an account
  // still holds it.
  expect(
    read("kinds=model", {
      unmountable: ["provider", "provider-together"],
    }).providers.map((row) => row.displayName),
  ).toEqual(["Example AI", "OpenRouter", "OpenRouter"]);
});

test("a Marketplace read is decoded from its query string, and refused when malformed", () => {
  expect(connectionsCatalogQueryV1(new URLSearchParams(""))).toBeUndefined();
  expect(catalogQuery()).toEqual({
    query: "",
    kinds: ["model", "connector"],
    installed: false,
    cursor: 0,
    limit: 50,
  });
  expect(
    catalogQuery("q=mail&kinds=connector,connector&installed=1&cursor=50"),
  ).toEqual({
    query: "mail",
    kinds: ["connector"],
    installed: true,
    cursor: 50,
    limit: 50,
  });
  for (const malformed of [
    "cursor=-1",
    "cursor=1.5",
    "cursor=abc",
    "cursor=",
    "limit=0",
    "limit=2001",
    "kinds=plugin",
    `q=${"a".repeat(101)}`,
  ]) {
    expect(() => catalogQuery(malformed)).toThrow("Marketplace");
  }
});

test("a provider section's one action names the next step", () => {
  const user = settings();
  const actions = () =>
    modelsSettingsFrame("tim", user, [provider]).sections[1]!.actions;
  expect(actions()).toEqual([
    { kind: "manage-provider", label: "Manage provider" },
  ]);
  user.connections = [];
  expect(actions()).toEqual([
    { kind: "manage-provider", label: "Connect account" },
  ]);
});

test("a built-in model says it needs no key, so it never reads as one someone added", () => {
  const user = settings(2);
  user.platformModel = undefined;
  const builtIn = { ...provider, platformOwned: true };
  const labels = modelSettingsOptions("tim", user, [builtIn], query).items.map(
    (item) => item.label,
  );
  expect(labels).toEqual([
    "Automatic — recommended",
    "Model 0 · Work · built in, no key needed",
    "Model 1 · Work · built in, no key needed",
  ]);
  expect(
    modelSettingsOptions("tim", user, [provider], query).items[1]!.label,
  ).toBe("Model 0 · Work");
});

test("resetting an Application setting omits the empty patch at the owner seam", () => {
  expect(
    applicationSettingsCommand({
      schemaVersion: 1,
      ownerId: "tim",
      commandId: "reset-application",
      expectedRevision: 1,
      sectionId: "package.example",
      values: {},
      unset: ["limit"],
    }),
  ).toMatchObject({ type: "user/set-package-settings", unset: ["limit"] });
});

test("Profile owns the timezone used by Routines", () => {
  const user = settings();
  user.profile.timezone = "Australia/Sydney";
  const profile = applicationSettingsFrame("tim", user, [provider])
    .sections[0]!;
  expect(profile).toMatchObject({
    id: "profile",
    fields: [
      { id: "name", value: "Tim" },
      { id: "email", value: "" },
      {
        id: "timezone",
        kind: "select",
        value: "Australia/Sydney",
        required: true,
        hint: "Your Routines use this time zone.",
      },
    ],
  });
  const timezone = profile.fields[2]!;
  expect(timezone.choices!.length).toBeGreaterThan(400);
  // The catalog is whatever this runtime's ICU build holds, and the wire bounds
  // how many choices one field may carry: an over-long catalog would fail the
  // whole Settings document on the client, not just this row.
  expect(
    isProtocolValue("SettingField", JSON.parse(JSON.stringify(timezone))),
  ).toBe(true);
  expect(timezone.choices).toContainEqual({
    label: "Australia / Sydney",
    value: "Australia/Sydney",
  });
  expect(new Set(timezone.choices!.map((choice) => choice.value)).size).toBe(
    timezone.choices!.length,
  );
  expect(
    applicationSettingsCommand({
      schemaVersion: 1,
      ownerId: "tim",
      commandId: "save-profile",
      expectedRevision: 8,
      sectionId: "profile",
      values: {
        name: "Tim",
        timezone: "Pacific/Auckland",
      },
    }),
  ).toMatchObject({
    type: "user/update-profile",
    profile: { name: "Tim", timezone: "Pacific/Auckland" },
  });
  expect(() =>
    applicationSettingsCommand({
      schemaVersion: 1,
      ownerId: "tim",
      commandId: "save-invalid-profile",
      expectedRevision: 8,
      sectionId: "profile",
      values: { name: "Tim", timezone: "Sydney-ish" },
    }),
  ).toThrow("profile.timezone is not an IANA time zone");
});

test("Appearance owns Ink, Paper, and System", () => {
  const user = settings();
  const appearance = applicationSettingsFrame("tim", user, [provider])
    .sections[1]!;
  expect(appearance).toMatchObject({
    id: "appearance",
    fields: [
      {
        id: "look",
        kind: "select",
        value: "ink",
        required: true,
      },
    ],
  });
  expect(appearance.fields[0]!.choices).toEqual([
    { label: "Ink", value: "ink" },
    { label: "Paper", value: "paper" },
    { label: "System", value: "system" },
  ]);
  expect(
    applicationSettingsCommand({
      schemaVersion: 1,
      ownerId: "tim",
      commandId: "save-appearance",
      expectedRevision: 8,
      sectionId: "appearance",
      values: { look: "paper" },
    }),
  ).toMatchObject({
    type: "user/update-appearance",
    appearance: { look: "paper" },
  });
});

test("Profile defaults to UTC and keeps a valid stored alias selectable", () => {
  const user = settings();
  let timezone = applicationSettingsFrame("tim", user, [provider]).sections[0]!
    .fields[2]!;
  expect(timezone.value).toBe("UTC");
  expect(timezone.choices![0]).toEqual({ label: "UTC", value: "UTC" });

  user.profile.timezone = "US/Eastern";
  timezone = applicationSettingsFrame("tim", user, [provider]).sections[0]!
    .fields[2]!;
  expect(timezone.value).toBe("US/Eastern");
  expect(timezone.choices).toContainEqual({
    label: "US / Eastern",
    value: "US/Eastern",
  });
});
