// Package-level setting *values*: the durable configuration one installed
// Package carries for one User.
//
// A manifest declares `configuration.settings` — the knobs a Package offers —
// and until now nothing anywhere held a value for one, so every Package read
// its own default forever. This module is the codec that stands between a
// command and that durable state.
//
// WHAT BELONGS HERE, AND WHAT DOES NOT. A Package-level setting is
// configuration scoped to the User: a default model, a ceiling, an endpoint
// root. A *secret* never is. A credential reaches the keyring through a
// Connection and only through one, so a definition that declares itself secret
// is refused here with that answer rather than stored.
//
// STRICT IN, LENIENT OUT. A write is validated against the exact schema the
// Package declared: an unknown setting id, a wrong type, a value outside its
// bounds or off its enum is refused and nothing is stored. A read is lenient
// about keys it does not recognise, because the durable bag has a second
// writer — a Catalog install's setup `values` (ADR 0014) — whose keys a
// Package's declared settings need not cover. Refusing a read over one of
// those would take a Package's whole configuration away over a value written
// by someone else.
import type {
  PackageSettingDefinition,
  PackageSettingSchema,
  PackageSettingSchemaValue,
} from "@frockbot/kernel-composition";
import { ConfigurationDecodeError } from "./errors.js";
import { isPublicIdentifier } from "./identifiers.js";

/**
 * What one Package-level setting may hold. Scalars only: a Package-level value
 * is a knob a User turns on a generated form, and an object or an array is a
 * document, which belongs in a Package's own durable state rather than in the
 * User's settings bag.
 */
export type PackageSettingValueV1 = string | number | boolean;

/** The durable record of one installed Package's setting values. */
export interface PackageSettingValuesV1 {
  schemaVersion: 1;
  values: Record<string, PackageSettingValueV1>;
}

/** The durable per-User ceiling on how many values one Package may hold. */
export const MAX_PACKAGE_SETTINGS_V1 = 32;

/** The ceiling on one text value, whatever the schema's own `maxLength`. */
export const MAX_PACKAGE_SETTING_TEXT_V1 = 2_048;

/** An installed Package with no values yet. */
export function emptyPackageSettingValuesV1(): PackageSettingValuesV1 {
  return { schemaVersion: 1, values: {} };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationDecodeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * The declared type a value must satisfy. A schema that names none is treated
 * as unconstrained in *kind* — every other rule it states still applies — so a
 * Package that declares only an `enum` is honoured rather than refused.
 */
type ScalarSettingType = "string" | "number" | "integer" | "boolean";

function scalarType(
  schema: PackageSettingSchema,
  settingId: string,
): ScalarSettingType | undefined {
  if (schema.type === undefined) return undefined;
  if (
    schema.type === "string" ||
    schema.type === "number" ||
    schema.type === "integer" ||
    schema.type === "boolean"
  ) {
    return schema.type;
  }
  throw new ConfigurationDecodeError(
    `Package setting "${settingId}" is not a scalar setting`,
  );
}

function matchesEnumValue(
  value: PackageSettingValueV1,
  candidate: PackageSettingSchemaValue,
): boolean {
  return value === candidate;
}

function checkString(
  value: string,
  schema: PackageSettingSchema,
  settingId: string,
): void {
  if (value.length > MAX_PACKAGE_SETTING_TEXT_V1) {
    throw new ConfigurationDecodeError(
      `Package setting "${settingId}" is too long`,
    );
  }
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    throw new ConfigurationDecodeError(
      `Package setting "${settingId}" is shorter than ${schema.minLength}`,
    );
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    throw new ConfigurationDecodeError(
      `Package setting "${settingId}" is longer than ${schema.maxLength}`,
    );
  }
}

function checkNumber(
  value: number,
  schema: PackageSettingSchema,
  settingId: string,
): void {
  if (!Number.isFinite(value)) {
    throw new ConfigurationDecodeError(
      `Package setting "${settingId}" is not a finite number`,
    );
  }
  if (schema.type === "integer" && !Number.isSafeInteger(value)) {
    throw new ConfigurationDecodeError(
      `Package setting "${settingId}" must be an integer`,
    );
  }
  if (schema.minimum !== undefined && value < schema.minimum) {
    throw new ConfigurationDecodeError(
      `Package setting "${settingId}" is below ${schema.minimum}`,
    );
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    throw new ConfigurationDecodeError(
      `Package setting "${settingId}" is above ${schema.maximum}`,
    );
  }
  if (
    schema.exclusiveMinimum !== undefined &&
    value <= schema.exclusiveMinimum
  ) {
    throw new ConfigurationDecodeError(
      `Package setting "${settingId}" is not above ${schema.exclusiveMinimum}`,
    );
  }
  if (
    schema.exclusiveMaximum !== undefined &&
    value >= schema.exclusiveMaximum
  ) {
    throw new ConfigurationDecodeError(
      `Package setting "${settingId}" is not below ${schema.exclusiveMaximum}`,
    );
  }
  if (schema.multipleOf !== undefined && schema.multipleOf > 0) {
    const quotient = value / schema.multipleOf;
    if (!Number.isInteger(Number(quotient.toFixed(10)))) {
      throw new ConfigurationDecodeError(
        `Package setting "${settingId}" is not a multiple of ${schema.multipleOf}`,
      );
    }
  }
}

/**
 * One value, against the definition its Package declared.
 *
 * The scope check is the constitution's, not a convenience: Package
 * availability is User-level, so a User-level bag holds a `user`-scoped
 * setting. A `connection`-scoped one belongs to a Connection and a `bot`-only
 * one to a Bot, and neither has a home here.
 */
export function decodePackageSettingValueV1(
  definition: PackageSettingDefinition,
  value: unknown,
): PackageSettingValueV1 {
  const settingId = definition.id;
  // Defensive, and deliberately not dead: `PackageSettingDefinition` carries no
  // `secret` flag today, and the manifest decoder refuses unknown fields, so
  // one cannot arrive. The day the schema grows one, a secret must be refused
  // here rather than quietly stored in User settings the client reads back.
  if ((definition as { secret?: unknown }).secret === true) {
    throw new ConfigurationDecodeError(
      `Package setting "${settingId}" is a secret: use a Connection`,
    );
  }
  if (!definition.scopes.includes("user")) {
    throw new ConfigurationDecodeError(
      definition.scopes.includes("connection")
        ? `Package setting "${settingId}" is Connection-scoped: use a Connection`
        : `Package setting "${settingId}" is not a User-level setting`,
    );
  }
  const schema = definition.schema;
  const declared = scalarType(schema, settingId);
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    throw new ConfigurationDecodeError(
      `Package setting "${settingId}" must be a string, number or boolean`,
    );
  }
  if (declared === "boolean" && typeof value !== "boolean") {
    throw new ConfigurationDecodeError(
      `Package setting "${settingId}" must be a boolean`,
    );
  }
  if (declared === "string" && typeof value !== "string") {
    throw new ConfigurationDecodeError(
      `Package setting "${settingId}" must be a string`,
    );
  }
  if (
    (declared === "number" || declared === "integer") &&
    typeof value !== "number"
  ) {
    throw new ConfigurationDecodeError(
      `Package setting "${settingId}" must be a number`,
    );
  }
  if (schema.const !== undefined && !matchesEnumValue(value, schema.const)) {
    throw new ConfigurationDecodeError(
      `Package setting "${settingId}" must be ${JSON.stringify(schema.const)}`,
    );
  }
  if (
    schema.enum !== undefined &&
    !schema.enum.some((candidate) => matchesEnumValue(value, candidate))
  ) {
    throw new ConfigurationDecodeError(
      `Package setting "${settingId}" is not one of ${JSON.stringify(schema.enum)}`,
    );
  }
  if (typeof value === "string") checkString(value, schema, settingId);
  if (typeof value === "number") checkNumber(value, schema, settingId);
  return value;
}

function definitionsById(
  definitions: readonly PackageSettingDefinition[],
): Map<string, PackageSettingDefinition> {
  const map = new Map<string, PackageSettingDefinition>();
  for (const definition of definitions) map.set(definition.id, definition);
  return map;
}

/**
 * The `values` a `user/set-package-settings` command carries: a *partial*
 * update, so only the ids it names are decoded. Every one of them must be a
 * setting the Package declares at User scope.
 */
export function decodePackageSettingsPatchV1(
  definitions: readonly PackageSettingDefinition[],
  input: unknown,
): Record<string, PackageSettingValueV1> {
  const values = record(input, "values");
  const entries = Object.entries(values);
  if (entries.length > MAX_PACKAGE_SETTINGS_V1) {
    throw new ConfigurationDecodeError("Package settings are too many");
  }
  const declared = definitionsById(definitions);
  const decoded: Record<string, PackageSettingValueV1> = {};
  for (const [settingId, value] of entries) {
    if (!isPublicIdentifier(settingId)) {
      throw new ConfigurationDecodeError("Package setting id is invalid");
    }
    const definition = declared.get(settingId);
    if (!definition) {
      throw new ConfigurationDecodeError(
        `Package setting "${settingId}" is not declared by this Package`,
      );
    }
    decoded[settingId] = decodePackageSettingValueV1(definition, value);
  }
  return decoded;
}

/** The durable record, decoded whole. */
export function decodePackageSettingValuesV1(
  definitions: readonly PackageSettingDefinition[],
  input: unknown,
): PackageSettingValuesV1 {
  const value = record(input, "Package setting values");
  if (value.schemaVersion !== 1) {
    throw new ConfigurationDecodeError(
      "unsupported Package setting values schema",
    );
  }
  if (
    Object.keys(value).some(
      (key) => key !== "schemaVersion" && key !== "values",
    )
  ) {
    throw new ConfigurationDecodeError("Package setting values are invalid");
  }
  return {
    schemaVersion: 1,
    values: decodePackageSettingsPatchV1(definitions, value.values),
  };
}

/**
 * The read side: the values an installed Package's stored bag holds *for the
 * settings it declares*, and nothing else.
 *
 * Anything the Package does not declare, or that no longer satisfies the
 * schema of the version now installed, is dropped rather than raised. The bag
 * is written by two writers and read on every Turn: a Catalog setup value with
 * no matching declaration, or a value a Package narrowed in a later version,
 * must leave the Package on its default rather than fail Composition.
 */
export function resolvePackageSettingValuesV1(
  definitions: readonly PackageSettingDefinition[],
  stored: Readonly<Record<string, unknown>> | undefined,
): Record<string, PackageSettingValueV1> {
  if (!stored) return {};
  const resolved: Record<string, PackageSettingValueV1> = {};
  for (const definition of definitions) {
    if (!Object.hasOwn(stored, definition.id)) continue;
    try {
      resolved[definition.id] = decodePackageSettingValueV1(
        definition,
        stored[definition.id],
      );
    } catch {
      continue;
    }
  }
  return resolved;
}
