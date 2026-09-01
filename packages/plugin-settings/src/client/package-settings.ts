import type {
  PackageSettingDefinition,
  PackageSettingSchema,
} from "@frockbot/kernel-composition";

/**
 * The generated Package settings form, minus the rendering.
 *
 * The fields come from the schema each Package declares, so a Package that
 * adds a setting gets a control with no edit to a surface: the manifest is the
 * only description of the knob that exists.
 */
export type SettingFieldKind = "enum" | "boolean" | "number" | "text";

export function settingFieldKind(
  schema: PackageSettingSchema,
): SettingFieldKind {
  if (schema.enum && schema.enum.length > 0) return "enum";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "number" || schema.type === "integer") return "number";
  return "text";
}

export function settingLabel(definition: PackageSettingDefinition): string {
  return definition.schema.title ?? definition.id;
}

/** A draft seeded from durable state, so an untouched field saves unchanged. */
export function seedSettingsDraft(
  definitions: readonly PackageSettingDefinition[],
  stored: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const draft: Record<string, string | number | boolean> = {};
  for (const definition of definitions) {
    const value = stored[definition.id];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      draft[definition.id] = value;
      continue;
    }
    draft[definition.id] =
      settingFieldKind(definition.schema) === "boolean" ? false : "";
  }
  return draft;
}

/**
 * The command payload. Only the fields the User filled in are sent: the
 * command is a partial update, and an empty text or number box means "leave
 * this one alone" rather than "store an empty string".
 */
export function collectSettingsValues(
  definitions: readonly PackageSettingDefinition[],
  draft: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  const values: Record<string, string | number | boolean> = {};
  for (const definition of definitions) {
    const kind = settingFieldKind(definition.schema);
    const raw = draft[definition.id];
    if (kind === "boolean") {
      values[definition.id] = raw === true;
      continue;
    }
    if (raw === "" || raw === undefined) continue;
    if (kind === "number") {
      const parsed = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(parsed)) continue;
      values[definition.id] = parsed;
      continue;
    }
    values[definition.id] = String(raw);
  }
  return values;
}
