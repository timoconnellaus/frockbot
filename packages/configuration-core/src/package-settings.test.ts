import { describe, expect, test } from "bun:test";
import type { PackageSettingDefinition } from "@frockbot/kernel-composition";
import {
  decodeInstalledPackageSettingsPatchV1,
  decodeModelBindingV1,
  decodePackageSettingsPatchV1,
  decodePackageSettingValuesV1,
  emptyPackageSettingValuesV1,
  MAX_PACKAGE_SETTINGS_V1,
  resolvePackageSettingValuesV1,
} from "./package-settings.js";

function definition(
  overrides: Partial<PackageSettingDefinition> & {
    id: string;
  },
): PackageSettingDefinition {
  return {
    schemaVersion: 1,
    scopes: ["user"],
    schema: { type: "string" },
    ...overrides,
  };
}

const declared: PackageSettingDefinition[] = [
  definition({
    id: "model",
    schema: { type: "string", enum: ["fast", "slow"] },
  }),
  definition({
    id: "max-results",
    schema: { type: "integer", minimum: 1, maximum: 10 },
  }),
  definition({ id: "verbose", schema: { type: "boolean" } }),
  definition({
    id: "endpoint",
    schema: { type: "string", minLength: 4, maxLength: 32 },
  }),
];

describe("the Package setting values codec", () => {
  test("accepts every declared scalar kind against its own schema", () => {
    expect(
      decodePackageSettingsPatchV1(declared, {
        model: "fast",
        "max-results": 3,
        verbose: true,
        endpoint: "https://example.test",
      }),
    ).toEqual({
      model: "fast",
      "max-results": 3,
      verbose: true,
      endpoint: "https://example.test",
    });
  });

  test("refuses a setting the Package never declared", () => {
    expect(() =>
      decodePackageSettingsPatchV1(declared, { unknown: "value" }),
    ).toThrow(/not declared by this Package/);
  });

  test("refuses a value of the wrong type", () => {
    expect(() =>
      decodePackageSettingsPatchV1(declared, { "max-results": "3" }),
    ).toThrow(/must be a number/);
    expect(() =>
      decodePackageSettingsPatchV1(declared, { verbose: "yes" }),
    ).toThrow(/must be a boolean/);
    expect(() => decodePackageSettingsPatchV1(declared, { model: 1 })).toThrow(
      /must be a string/,
    );
  });

  test("refuses a value outside the schema's bounds", () => {
    expect(() =>
      decodePackageSettingsPatchV1(declared, { "max-results": 11 }),
    ).toThrow(/is above 10/);
    expect(() =>
      decodePackageSettingsPatchV1(declared, { "max-results": 0 }),
    ).toThrow(/is below 1/);
    expect(() =>
      decodePackageSettingsPatchV1(declared, { "max-results": 2.5 }),
    ).toThrow(/must be an integer/);
    expect(() =>
      decodePackageSettingsPatchV1(declared, { endpoint: "abc" }),
    ).toThrow(/shorter than 4/);
    expect(() =>
      decodePackageSettingsPatchV1(declared, { endpoint: "x".repeat(33) }),
    ).toThrow(/longer than 32/);
  });

  test("refuses a value off the declared enum", () => {
    expect(() =>
      decodePackageSettingsPatchV1(declared, { model: "medium" }),
    ).toThrow(/is not one of/);
  });

  test("refuses a value that is not a scalar at all", () => {
    expect(() =>
      decodePackageSettingsPatchV1(declared, { model: { nested: true } }),
    ).toThrow(/must be a string, number or boolean/);
    expect(() =>
      decodePackageSettingsPatchV1(declared, { "max-results": Number.NaN }),
    ).toThrow(/not a finite number/);
  });

  test("refuses a setting whose declared type is an object or an array", () => {
    const structured = [
      definition({ id: "shape", schema: { type: "object" } }),
    ];
    expect(() =>
      decodePackageSettingsPatchV1(structured, { shape: "anything" }),
    ).toThrow(/is not a scalar setting/);
  });

  test("refuses a Connection-scoped setting, naming the Connection", () => {
    const connectionScoped = [
      definition({ id: "url", scopes: ["connection"] }),
    ];
    expect(() =>
      decodePackageSettingsPatchV1(connectionScoped, { url: "https://x.test" }),
    ).toThrow(/use a Connection/);
  });

  test("refuses a Bot-scoped setting: it has no home in User settings", () => {
    const botScoped = [definition({ id: "tone", scopes: ["bot"] })];
    expect(() =>
      decodePackageSettingsPatchV1(botScoped, { tone: "terse" }),
    ).toThrow(/not a User-level setting/);
    expect(
      decodePackageSettingsPatchV1(botScoped, { tone: "terse" }, "bot"),
    ).toEqual({ tone: "terse" });
  });

  test("validates the model role's exact structured value at either scope", () => {
    const modelRole = [
      definition({
        id: "model",
        role: "model",
        scopes: ["user", "bot"],
        schema: {
          type: "object",
          properties: {
            connectionId: { type: "string" },
            providerModelId: { type: "string" },
          },
          required: ["connectionId", "providerModelId"],
          additionalProperties: false,
        },
      }),
    ];
    const model = {
      connectionId: "ollama-work",
      providerModelId: "glm-5.3-flash:cloud",
    };
    expect(decodePackageSettingsPatchV1(modelRole, { model })).toEqual({
      model,
    });
    expect(decodePackageSettingsPatchV1(modelRole, { model }, "bot")).toEqual({
      model,
    });
    expect(() =>
      decodePackageSettingsPatchV1(modelRole, {
        model: { ...model, extra: true },
      }),
    ).toThrow(/invalid fields/);
  });

  test("rejects hidden, symbol, inherited, and prototype-shaped fields", () => {
    const hidden = { verbose: true };
    Object.defineProperty(hidden, "secret", { value: "hidden" });
    expect(() => decodePackageSettingsPatchV1(declared, hidden)).toThrow(
      /invalid fields/,
    );

    const symbol = { verbose: true, [Symbol("extra")]: true };
    expect(() => decodePackageSettingsPatchV1(declared, symbol)).toThrow(
      /invalid fields/,
    );

    const inherited = Object.create({ verbose: true });
    expect(() => decodePackageSettingsPatchV1(declared, inherited)).toThrow(
      /plain object|inherited fields/,
    );

    expect(() =>
      decodeModelBindingV1({
        connectionId: "constructor",
        providerModelId: "model-1",
      }),
    ).toThrow(/connectionId is invalid/);
  });

  test("validates a Bot command against the installed manifest version", () => {
    const installations = [{ packageId: "preferences", version: "1.0.0" }];
    const packages = [
      { packageId: "preferences", version: "1.0.0", settings: declared },
    ];
    const validate = (packageId: string, values: unknown) =>
      decodeInstalledPackageSettingsPatchV1({
        packageId,
        values,
        scope: "bot",
        installations,
        packages,
      });
    const botSetting = [
      definition({ id: "tone", scopes: ["bot"], schema: { type: "string" } }),
    ];
    packages[0] = {
      packageId: "preferences",
      version: "1.0.0",
      settings: botSetting,
    };

    expect(validate("preferences", { tone: "terse" })).toEqual({
      tone: "terse",
    });
    expect(() => validate("missing", { tone: "terse" })).toThrow(
      'Package "missing" is not installed',
    );
    expect(() => validate("preferences", { unknown: "value" })).toThrow(
      /not declared/,
    );
    expect(() => validate("preferences", { tone: 42 })).toThrow(
      /must be a string/,
    );
  });

  test("refuses a secret, whatever its schema says", () => {
    const secret = [
      {
        ...definition({ id: "api-key" }),
        secret: true,
      } as PackageSettingDefinition,
    ];
    expect(() =>
      decodePackageSettingsPatchV1(secret, { "api-key": "sk-live" }),
    ).toThrow(/use a Connection/);
  });

  test("bounds how many values one Package may carry", () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_PACKAGE_SETTINGS_V1 + 1 }, (_value, index) => [
        `setting-${index}`,
        "x",
      ]),
    );
    expect(() => decodePackageSettingsPatchV1(declared, many)).toThrow(
      /too many/,
    );
  });

  test("decodes the durable record whole, and refuses another schema", () => {
    expect(
      decodePackageSettingValuesV1(declared, {
        schemaVersion: 1,
        values: { verbose: false },
      }),
    ).toEqual({ schemaVersion: 1, values: { verbose: false } });
    expect(() =>
      decodePackageSettingValuesV1(declared, {
        schemaVersion: 2,
        values: {},
      }),
    ).toThrow(/unsupported/);
    expect(emptyPackageSettingValuesV1()).toEqual({
      schemaVersion: 1,
      values: {},
    });
  });
});

describe("resolving stored values for a running Package", () => {
  test("keeps what the Package declares and drops the rest", () => {
    // `catalog-setup-field` is what a Catalog install wrote (ADR 0014): it is
    // in the same bag and is not one of this Package's declared settings.
    expect(
      resolvePackageSettingValuesV1(declared, {
        verbose: true,
        "catalog-setup-field": "kept elsewhere",
      }),
    ).toEqual({ verbose: true });
  });

  test("drops a stored value the installed version no longer accepts", () => {
    // The bag was written when the ceiling was higher. A Composition must not
    // fail over it: the Package falls back to its own default instead.
    expect(
      resolvePackageSettingValuesV1(declared, { "max-results": 99 }),
    ).toEqual({});
  });

  test("answers empty for a Package that has never been configured", () => {
    expect(resolvePackageSettingValuesV1(declared, undefined)).toEqual({});
  });
});
