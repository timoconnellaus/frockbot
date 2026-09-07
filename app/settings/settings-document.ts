// The `SettingsFrame` a settings route already produces, projected as the
// `ViewDocument` the host renders. The frame stays the authority — this reads
// one and writes the other — so the Vue client keeps the shape it has while
// the Flutter client renders settings through the one renderer a plugin will
// use.
//
// Two conventions carry the frame's extra meaning through a vocabulary that
// has no room for it:
//
// - A projected field id is `f<section>.<id>`, or `j<section>.<id>` when the
//   value is JSON-encoded. The section index disambiguates two Packages that
//   named a setting the same thing, and the letter says whether the client
//   decodes the value before it reaches a settings command, because an action
//   input carries only strings, numbers and booleans and a `select`'s value is
//   any JSON.
// - An action's declared input names the section it saves, and a section
//   action names its kind, because an action id is opaque to the renderer and
//   a section id is longer than one.

import {
  decodeProtocol,
  type SettingField,
  type SettingsFrame,
  type ViewDocument,
  type ViewNode,
} from "@frockbot/core/protocol-schemas";

/** The schema's cap on declared actions. */
export const VIEW_ACTION_LIMIT_V1 = 32;
/** The renderer's node budget, checked before it builds a widget. */
export const VIEW_NODE_LIMIT_V1 = 512;
/** The schema's cap on one action's declared properties. */
export const VIEW_ACTION_PROPERTY_LIMIT_V1 = 32;
const MAX_IDENTIFIER = 128;
const MAX_ACTION_STRING = 8000;
const OVERFLOW_V1 =
  "The rest of these settings need a newer app. Everything above is still yours to change.";

type Action = ViewDocument["actions"][number];
type Section = SettingsFrame["sections"][number];

/** The projected id of one field, or undefined when it would not be an id. */
export function projectedFieldIdV1(
  field: SettingField,
  index: number,
): string | undefined {
  const id = `${field.kind === "select" ? "j" : "f"}${index}.${field.id}`;
  return id.length > MAX_IDENTIFIER ? undefined : id;
}

function valueSchema(
  field: SettingField,
): Action["schema"]["properties"][string] {
  if (field.kind === "boolean") return { type: "boolean" };
  if (field.kind === "number")
    return {
      type: "number",
      minimum: field.minimum ?? Number.MIN_SAFE_INTEGER,
      maximum: field.maximum ?? Number.MAX_SAFE_INTEGER,
    };
  return {
    type: "string",
    maxLength: Math.min(
      field.maxLength ?? MAX_ACTION_STRING,
      MAX_ACTION_STRING,
    ),
  };
}

function fieldNode(field: SettingField, id: string): ViewNode {
  const projected =
    field.kind === "select"
      ? {
          ...field,
          id,
          value: JSON.stringify(field.value ?? null),
          ...(field.choices
            ? {
                choices: field.choices.map((choice) => ({
                  label: choice.label,
                  value: JSON.stringify(choice.value ?? null),
                })),
              }
            : {}),
        }
      : { ...field, id };
  return { type: "field", field: projected as SettingField };
}

function statusNode(text: string): ViewNode {
  return { type: "text", text, style: "status" };
}

function credentialLine(status: Section["credentialStatus"]): string {
  switch (status) {
    case "connected":
      return "Account connected";
    case "revoked":
      return "Account revoked";
    case "missing":
      return "Connect an account to use this provider";
    default:
      return "Ready to use";
  }
}

function countNodes(node: ViewNode): number {
  if (node.type === "group")
    return (
      1 + node.children.reduce((total, child) => total + countNodes(child), 0)
    );
  if (node.type === "list")
    return (
      1 + node.rows.reduce((total, row) => total + countNodes(row.node), 0)
    );
  return 1;
}

/**
 * One section as a titled group, plus the actions it declares.
 *
 * A section past the action budget still renders — read-only, and saying so —
 * because a person who cannot change a setting is better served by seeing what
 * it is than by a gap where it was.
 */
function projectSection(
  section: Section,
  index: number,
  budget: number,
): { node: ViewNode; actions: Action[] } {
  const actions: Action[] = [];
  const children: ViewNode[] = [];
  if (section.credentialStatus)
    children.push(statusNode(credentialLine(section.credentialStatus)));
  if (section.failure) children.push({ type: "text", text: section.failure });

  const properties: Action["schema"]["properties"] = {
    sectionId: { type: "string", maxLength: 256 },
  };
  const required = ["sectionId"];
  let dropped = false;
  const resettable: { id: string; label: string }[] = [];
  for (const field of section.fields) {
    const id = projectedFieldIdV1(field, index);
    if (!id) {
      dropped = true;
      continue;
    }
    const editable =
      field.editable &&
      budget > 0 &&
      Object.keys(properties).length < VIEW_ACTION_PROPERTY_LIMIT_V1;
    children.push(fieldNode({ ...field, editable }, id));
    if (!editable) continue;
    properties[id] = valueSchema(field);
    if (field.required) required.push(id);
    if (field.canReset && field.isSet)
      resettable.push({ id: field.id, label: field.label });
  }

  if (Object.keys(properties).length > 1) {
    actions.push({
      id: `save-${index}`,
      schema: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    });
    children.push({
      type: "action",
      actionId: `save-${index}`,
      label: section.id === "profile" ? "Save profile" : "Save changes",
      style: "primary",
      input: { sectionId: section.id },
    });
  }

  for (const [order, action] of (section.actions ?? []).entries()) {
    if (actions.length >= budget) break;
    const id = `section-${index}-${order}`;
    actions.push({
      id,
      schema: {
        type: "object",
        properties: {
          sectionId: { type: "string", maxLength: 256 },
          kind: {
            type: "string",
            enum: ["choose-provider", "manage-provider"],
          },
        },
        required: ["sectionId", "kind"],
        additionalProperties: false,
      },
    });
    children.push({
      type: "action",
      actionId: id,
      label: action.label,
      input: { sectionId: section.id, kind: action.kind },
    });
  }

  // Reset lives on its own action because a `field` node has no affordance for
  // "use the default" and a null cannot travel through an action input.
  for (const [order, field] of resettable.entries()) {
    if (actions.length >= budget) break;
    const id = `unset-${index}-${order}`;
    actions.push({
      id,
      schema: {
        type: "object",
        properties: {
          sectionId: { type: "string", maxLength: 256 },
          fieldId: { type: "string", maxLength: MAX_IDENTIFIER },
        },
        required: ["sectionId", "fieldId"],
        additionalProperties: false,
      },
    });
    children.push({
      type: "action",
      actionId: id,
      label: `Use default for ${field.label}`.slice(0, 100),
      input: { sectionId: section.id, fieldId: field.id },
    });
  }

  if (dropped)
    children.push(
      statusNode("Some of these settings need a newer app to change."),
    );
  if (budget === 0 && section.fields.some((field) => field.editable))
    children.push(statusNode("These settings can’t be changed here yet."));

  return {
    node: {
      type: "group",
      orientation: "column",
      title: section.label,
      children,
    },
    actions,
  };
}

/**
 * A `SettingsFrame` as a `ViewDocument`.
 *
 * Sections are taken in order until the node or action budget would be spent,
 * so the document the host receives is one it can render whole rather than one
 * it refuses.
 */
export function settingsDocumentV1(frame: SettingsFrame): ViewDocument {
  const children: ViewNode[] = [];
  const actions: Action[] = [];
  // The root group and the overflow status the tail may need.
  let nodes = 2;
  let complete = true;
  for (const [index, section] of frame.sections.entries()) {
    const projected = projectSection(
      section,
      index,
      VIEW_ACTION_LIMIT_V1 - actions.length,
    );
    const cost = countNodes(projected.node);
    if (
      nodes + cost > VIEW_NODE_LIMIT_V1 ||
      actions.length + projected.actions.length > VIEW_ACTION_LIMIT_V1
    ) {
      complete = false;
      break;
    }
    nodes += cost;
    children.push(projected.node);
    actions.push(...projected.actions);
  }
  if (!complete) children.push(statusNode(OVERFLOW_V1));
  return decodeProtocol("ViewDocument", {
    schemaVersion: 1,
    surfaceId: `settings-${frame.home}`,
    revision: frame.revision,
    // No title on the root: the frame's title is the surface's name, and the
    // host chrome that opened the surface has already said it.
    root: { type: "group", orientation: "column", children },
    actions,
  });
}
