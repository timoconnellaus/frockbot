import { expect, test } from "bun:test";
import type { UserSettingsViewV1 } from "@frockbot/configuration-core";
import {
  applicationSettingsFrame,
  applicationSettingsCommand,
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
    "Example AI · Auto",
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
    "package.preferences",
  ]);
  expect(frame.sections[1]!.fields).toMatchObject([
    { id: "nullable", isSet: true, canReset: true, value: null },
    { id: "toggle", isSet: false, canReset: true },
  ]);
  user.packages[1]!.state = "disabled";
  expect(
    applicationSettingsFrame("tim", user, [provider, control]).sections,
  ).toHaveLength(1);
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
  ]);
  expect(user.profile).toEqual({ name: "FrockBot user" });
  user.profile = { name: "Tim", email: "chosen@example.test" };
  expect(
    applicationSettingsFrame("tim", user, [provider], {
      name: "Timothy",
      email: "tim@example.test",
    }).sections[0]!.fields.map((f) => f.value),
  ).toEqual(["Tim", "chosen@example.test"]);
});

test("the released model reader retains the account fallback without the removed control", async () => {
  const { createUserSettingsBackendContribution } = await import("./user.js");
  const { resolveReleasedModelPolicy } =
    await import("./fixtures/model-policy-v0.3.39.js");
  const { resolveEffectiveBotModelV1 } =
    await import("@frockbot/configuration-core");
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

test("provider knobs have one Models home and disappear while disabled", () => {
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
  ).toHaveLength(1);
  user.packages[0]!.state = "disabled";
  expect(
    modelsSettingsFrame("tim", user, [declared]).sections[1]!.fields,
  ).toEqual([]);
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
