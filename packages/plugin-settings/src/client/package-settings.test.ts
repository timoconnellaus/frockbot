import { describe, expect, test } from "bun:test";
import type { PackageSettingDefinition } from "@frockbot/kernel-composition";
import {
  collectSettingsValues,
  seedSettingsDraft,
  settingFieldKind,
  settingLabel,
} from "./package-settings.js";

function definition(
  id: string,
  schema: PackageSettingDefinition["schema"],
): PackageSettingDefinition {
  return { id, schemaVersion: 1, scopes: ["user"], schema };
}

const definitions = [
  definition("model", { type: "string", title: "Model", enum: ["a", "b"] }),
  definition("enabled", { type: "boolean" }),
  definition("results", { type: "integer", title: "Web search results" }),
  definition("prefix", { type: "string" }),
];

describe("generated Package settings", () => {
  test("derives a control from the declared schema", () => {
    expect(definitions.map((entry) => settingFieldKind(entry.schema))).toEqual([
      "enum",
      "boolean",
      "number",
      "text",
    ]);
    expect(settingLabel(definitions[0]!)).toBe("Model");
    // A schema with no title is named by its own id rather than by a label a
    // surface invented for it.
    expect(settingLabel(definitions[1]!)).toBe("enabled");
  });

  test("seeds the draft from durable values and neutral empties", () => {
    expect(seedSettingsDraft(definitions, { model: "b", results: 7 })).toEqual({
      model: "b",
      enabled: false,
      results: 7,
      prefix: "",
    });
  });

  test("sends only the fields the User filled in", () => {
    expect(
      collectSettingsValues(definitions, {
        model: "",
        enabled: true,
        results: "9",
        prefix: "hello",
      }),
    ).toEqual({ enabled: true, results: 9, prefix: "hello" });
  });

  test("drops a number that is not one", () => {
    expect(
      collectSettingsValues(definitions, { results: "not a number" }),
    ).toEqual({ enabled: false });
  });
});
