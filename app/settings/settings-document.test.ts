import { expect, test } from "bun:test";
import {
  decodeProtocol,
  type SettingsFrame,
} from "@frockbot/core/protocol-schemas";
import {
  projectedFieldIdV1,
  settingsDocumentV1,
  VIEW_ACTION_LIMIT_V1,
  VIEW_NODE_LIMIT_V1,
} from "./settings-document.js";

function frame(sections: SettingsFrame["sections"]): SettingsFrame {
  return decodeProtocol("SettingsFrame", {
    schemaVersion: 1,
    home: "application",
    ownerId: "tim",
    revision: 4,
    sections,
  });
}

const profile: SettingsFrame["sections"][number] = {
  id: "profile",
  label: "Your profile",
  fields: [
    {
      id: "name",
      label: "Name",
      kind: "text",
      value: "Tim",
      editable: true,
      required: true,
      maxLength: 100,
    },
    { id: "email", label: "Email", kind: "text", value: "", editable: true },
  ],
};

function group(document: ReturnType<typeof settingsDocumentV1>, index: number) {
  const root = document.root;
  if (root.type !== "group") throw new Error("root is not a group");
  const child = root.children[index]!;
  if (child.type !== "group") throw new Error("section is not a group");
  return child;
}

test("a frame becomes one titled group per section, with a save action naming it", () => {
  const document = settingsDocumentV1(frame([profile]));
  expect(document.surfaceId).toBe("settings-application");
  expect(document.revision).toBe(4);
  // The root carries no title: the surface's chrome already names it.
  expect(document.root).not.toHaveProperty("title");
  const section = group(document, 0);
  expect(section.title).toBe("Your profile");
  expect(section.children.map((node) => node.type)).toEqual([
    "field",
    "field",
    "action",
  ]);
  const save = section.children[2]!;
  if (save.type !== "action") throw new Error("expected an action");
  expect(save.label).toBe("Save profile");
  expect(save.input).toEqual({ sectionId: "profile" });
  expect(document.actions).toEqual([
    {
      id: "save-0",
      schema: {
        type: "object",
        properties: {
          sectionId: { type: "string", maxLength: 256 },
          "f0.name": { type: "string", maxLength: 100 },
          "f0.email": { type: "string", maxLength: 8000 },
        },
        required: ["sectionId", "f0.name"],
        additionalProperties: false,
      },
    },
  ]);
});

test("a field id names its section, and a select says its value is JSON", () => {
  const document = settingsDocumentV1(
    frame([
      {
        id: "model",
        label: "Default model",
        fields: [
          {
            id: "account-model",
            label: "Model",
            kind: "select",
            value: { connectionId: "work", providerModelId: "llama" },
            editable: true,
            choiceSource: "account-models",
            choices: [{ label: "Auto", value: null }],
          },
        ],
      },
    ]),
  );
  const field = group(document, 0).children[0]!;
  if (field.type !== "field") throw new Error("expected a field");
  expect(field.field.id).toBe("j0.account-model");
  expect(field.field.value).toBe(
    '{"connectionId":"work","providerModelId":"llama"}',
  );
  expect(field.field.choices).toEqual([{ label: "Auto", value: "null" }]);
  expect(field.field.choiceSource).toBe("account-models");
});

test("the add-provider section's save reads as connecting", () => {
  const document = settingsDocumentV1(
    frame([
      {
        id: "add-provider",
        label: "Add a provider",
        fields: [
          {
            id: "provider",
            label: "Provider",
            kind: "select",
            value: null,
            editable: true,
            required: true,
            choices: [{ label: "Together", value: "provider-together" }],
          },
        ],
      },
    ]),
  );
  const save = group(document, 0).children[1]!;
  if (save.type !== "action") throw new Error("expected an action");
  expect(save.label).toBe("Connect provider");
  expect(document.actions[0]!.schema.required).toEqual([
    "sectionId",
    "j0.provider",
  ]);
});

test("projectedFieldIdV1 refuses an id longer than an identifier", () => {
  expect(
    projectedFieldIdV1(
      { id: "a", label: "A", kind: "text", value: "", editable: true },
      3,
    ),
  ).toBe("f3.a");
  expect(
    projectedFieldIdV1(
      {
        id: "a".repeat(128),
        label: "A",
        kind: "text",
        value: "",
        editable: true,
      },
      3,
    ),
  ).toBeUndefined();
});

test("a section action carries its kind, and a resettable field gets its own action", () => {
  const document = settingsDocumentV1(
    frame([
      {
        id: "provider.example",
        label: "Example AI",
        credentialStatus: "missing",
        fields: [
          {
            id: "region",
            label: "Region",
            kind: "text",
            value: "eu",
            editable: true,
            canReset: true,
            isSet: true,
          },
        ],
        actions: [
          {
            kind: "manage-provider",
            label: "Manage account",
          },
        ],
      },
    ]),
  );
  const section = group(document, 0);
  expect(section.children.map((node) => node.type)).toEqual([
    "text",
    "action",
    "group",
  ]);
  const [, manage, advanced] = section.children;
  if (advanced?.type !== "group") throw new Error("expected advanced settings");
  expect(advanced.collapsed).toBe(true);
  expect(advanced.children.map((node) => node.type)).toEqual([
    "field",
    "action",
    "action",
  ]);
  const unset = advanced.children[2];
  if (manage?.type !== "action" || unset?.type !== "action")
    throw new Error("expected actions");
  expect(manage.input).toEqual({
    sectionId: "provider.example",
    kind: "manage-provider",
  });
  expect(unset.label).toBe("Use default for Region");
  expect(unset.input).toEqual({
    sectionId: "provider.example",
    fieldId: "region",
  });
});

test("a frame past the budgets is projected whole up to them, then says so", () => {
  const many: SettingsFrame["sections"] = Array.from(
    { length: 64 },
    (_, index) => ({
      id: `package.p${index}`,
      label: `Package ${index}`,
      fields: Array.from({ length: 8 }, (_, field) => ({
        id: `s${field}`,
        label: `Setting ${field}`,
        kind: "boolean" as const,
        value: false,
        editable: true,
      })),
    }),
  );
  const document = settingsDocumentV1(frame(many));
  expect(document.actions.length).toBeLessThanOrEqual(VIEW_ACTION_LIMIT_V1);
  const root = document.root;
  if (root.type !== "group") throw new Error("root is not a group");
  const tail = root.children.at(-1)!;
  if (tail.type !== "text") throw new Error("expected an overflow status");
  expect(tail.style).toBe("status");
  let nodes = 0;
  const walk = (node: (typeof root)["children"][number]): void => {
    nodes += 1;
    if (node.type === "group") node.children.forEach(walk);
    if (node.type === "list") node.rows.forEach((row) => walk(row.node));
  };
  walk(root);
  expect(nodes).toBeLessThanOrEqual(VIEW_NODE_LIMIT_V1);
});

test("a section beyond the action budget still renders, read-only", () => {
  const sections: SettingsFrame["sections"] = Array.from(
    { length: 40 },
    (_, index) => ({
      id: `package.p${index}`,
      label: `Package ${index}`,
      fields: [
        {
          id: "flag",
          label: "Flag",
          kind: "boolean" as const,
          value: false,
          editable: true,
        },
      ],
    }),
  );
  const document = settingsDocumentV1(frame(sections));
  expect(document.actions).toHaveLength(VIEW_ACTION_LIMIT_V1);
  const last = group(document, VIEW_ACTION_LIMIT_V1);
  const field = last.children[0]!;
  if (field.type !== "field") throw new Error("expected a field");
  expect(field.field.editable).toBe(false);
  expect(last.children.at(-1)).toEqual({
    type: "text",
    text: "These settings can’t be changed here yet.",
    style: "status",
  });
});
