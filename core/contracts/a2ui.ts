// The A2UI 1.0 messages a Card is made of, and the bounds they are held to.
//
// A Card is one A2UI surface in the conversation ([ADR 0030](../../docs/adr/0030-a2ui-cards.md)).
// The Bot — or a Plugin writing on its behalf — sends the surface's own
// protocol through `send_to_user`, and the Bot Durable Object folds the
// messages into the Card's durable record. This module is the seam: the four
// agent→renderer messages, the renderer→agent `action`, and their decoders.
//
// Faithful to the 1.0 release candidate, and no wider. Each message is an
// envelope carrying `version: "v1.0"` and exactly one message key —
// `createSurface`, `updateComponents`, `updateDataModel` or `deleteSurface`.
// Components are an adjacency list: every entry has an `id` and a `component`
// name, children are named by id rather than nested, and one entry is `root`,
// which mounts under the surface. A data-model update writes `value` at a
// JSON-Pointer `path`. `callRendererFunction` and `agentFunctionResponse` are
// not carried: the kernel never asks the client to compute anything.
//
// The bounds are the ADR's "budgets and trust", and they are why a Card is
// safe to accept from an untrusted author:
//
//  * **128 components per surface.** A card is a thing with controls, not a
//    page; the `ViewDocument` budget next door is 512 nodes for a whole
//    settings page, and a card that needs half of one is a card that has
//    stopped being a card.
//  * **32,000 bytes per message.** One `send_to_user` text payload's bound,
//    for the same reason: this is a message in a conversation.
//  * **16 messages per send**, so one call cannot smuggle a stream.
//  * **32 surfaces per Session.** Cards do not tear down, so every one a Bot
//    draws stays readable; a Session is a conversation, not a canvas. A Bot
//    that draws past it does not lose the new card: the oldest surface is
//    tombstoned with a refusal saying it made room for a newer one.
//  * **32 actions per surface**, the number `ActionSchema` already allows a
//    `ViewDocument`, because the two are the same question: how many things
//    one surface may ask the kernel to do.
//  * **16,000 bytes of data model.** A settled card's state, not its content
//    store; anything larger belongs behind a tool call.
//  * **131,072 bytes for one folded record.** The bounds above are each on
//    one part of a surface, and components carry across sends, so this is the
//    one on the whole of it: room for 128 components beside a full data model,
//    and far enough under the Durable Object per-value limit that a fold is
//    refused in words on the card rather than by a `put` throwing inside the
//    transaction settling the Turn.
//  * **262,144 bytes for one listing.** Those two multiply — 32 surfaces at a
//    full record each is megabytes across two RPC hops — so a read of a
//    Session's cards stops at this and says on the view that it did: the
//    listing carries the newest cards that fit and sets `truncated` when it
//    stopped, and a card it left out is read by its id.
//
// A message past any of them is refused whole, not truncated: a partial
// surface misrepresents what its author said.
//
// One version note. The Flutter renderer the client will draw a Card with —
// `genui` 0.10.3 on `a2ui_core` 0.1.1 — speaks v0.9: it rejects any envelope
// whose `version` is not literally `"v0.9"`, and it spells `createSurface`'s
// surface properties `theme`. The four message names are the same in both. So
// this seam decodes 1.0, accepts a v0.9 envelope and its `theme` beside it,
// and stores the 1.0 shape; feeding the renderer what it speaks is the
// client's translation, not the record's. When `genui` catches up, the
// tolerance here is what gets deleted, and nothing downstream changes.

type A2uiScalarV1 = null | boolean | number | string;
type A2uiDepth1V1 =
  A2uiScalarV1 | A2uiScalarV1[] | { [key: string]: A2uiScalarV1 };
type A2uiDepth2V1 =
  A2uiScalarV1 | A2uiDepth1V1[] | { [key: string]: A2uiDepth1V1 };
type A2uiDepth3V1 =
  A2uiScalarV1 | A2uiDepth2V1[] | { [key: string]: A2uiDepth2V1 };
type A2uiDepth4V1 =
  A2uiScalarV1 | A2uiDepth3V1[] | { [key: string]: A2uiDepth3V1 };
/**
 * Plain JSON, spelled out and bounded rather than recursive, for the reason
 * `AppletJsonValueV1` is: a Card crosses a Durable Object RPC boundary, where
 * `unknown` is not transferable — a record typed with it collapses the whole
 * answer to `never` at the call site — and a self-referential type makes the
 * serializability mapper give up instead. A component's properties and a data
 * model are a handful of levels at the outside; the byte budget is the real
 * bound, and the decoder enforces it whatever the depth.
 */
/** A JSON object carried by a surface: a data model, a context, properties. */
export type A2uiJsonObjectV1 = { [key: string]: A2uiDepth4V1 };

export type A2uiJsonValueV1 = A2uiScalarV1 | A2uiDepth4V1[] | A2uiJsonObjectV1;

/** One component in a surface's adjacency list. Catalog properties ride along. */
export interface A2uiComponentV1 {
  id: string;
  component: string;
  /** Overrides the surface's catalog for this component alone. */
  catalogId?: string;
  /** The component's own properties, as its catalog entry declares them. */
  [property: string]: A2uiJsonValueV1 | undefined;
}

export interface A2uiCreateSurfaceV1 {
  surfaceId: string;
  catalogId?: string;
  /** Whether a renderer `action` carries the surface's data model with it. */
  sendDataModel?: boolean;
  /** 1.0's name for what v0.9 calls `theme`; both are accepted, this is stored. */
  surfaceProperties?: A2uiJsonObjectV1;
  components?: A2uiComponentV1[];
  dataModel?: A2uiJsonObjectV1;
}

export interface A2uiUpdateComponentsV1 {
  surfaceId: string;
  components: A2uiComponentV1[];
}

export interface A2uiUpdateDataModelV1 {
  surfaceId: string;
  /** RFC 6901 JSON Pointer; absent means the whole model. */
  path?: string;
  value: A2uiJsonValueV1;
}

export interface A2uiDeleteSurfaceV1 {
  surfaceId: string;
}

/** One agent→renderer message: the envelope plus exactly one message key. */
export type A2uiAgentMessageV1 =
  | { version: "v1.0"; createSurface: A2uiCreateSurfaceV1 }
  | { version: "v1.0"; updateComponents: A2uiUpdateComponentsV1 }
  | { version: "v1.0"; updateDataModel: A2uiUpdateDataModelV1 }
  | { version: "v1.0"; deleteSurface: A2uiDeleteSurfaceV1 };

/** The protocol version this seam speaks and stores. */
export const A2UI_VERSION_V1 = "v1.0";
/** The version the Flutter renderer still writes; accepted, never stored. */
export const A2UI_RENDERER_VERSION_V09 = "v0.9";

export const A2UI_AGENT_MESSAGE_KEYS_V1 = [
  "createSurface",
  "updateComponents",
  "updateDataModel",
  "deleteSurface",
] as const;

/** What a renderer sends back, before the kernel decides what it means. */
export interface A2uiActionV1 {
  name: string;
  context?: A2uiJsonObjectV1;
}

/**
 * The bounds, gathered so the decoder and the fold cannot disagree about
 * them. The module header says why each one is where it is.
 */
export const A2UI_LIMITS_V1 = {
  surfaceId: 128,
  messagesPerSend: 16,
  bytesPerMessage: 32_000,
  componentsPerSurface: 128,
  surfacesPerSession: 32,
  actionsPerSurface: 32,
  dataModelBytes: 16_000,
  cardRecordBytes: 131_072,
  cardListBytes: 262_144,
  componentId: 128,
  componentName: 128,
  catalogId: 512,
  pointer: 1_024,
  actionName: 256,
} as const;

/**
 * The shape a `surfaceId` may take, and a component `id` with it. The same
 * `Identifier` an approval id is: a surface id becomes a URL path segment and
 * a durable storage key, and a component id is written into a JSON Pointer.
 */
export const A2UI_IDENTIFIER_V1 = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/** A catalog component name, as the standard catalog writes them. */
const A2UI_COMPONENT_NAME_V1 = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

const UTF8 = new TextEncoder();

function a2uiRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function a2uiExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${label} has an unexpected key "${key}"`);
    }
  }
}

function a2uiIdentifier(
  value: unknown,
  maximum: number,
  label: string,
): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (value.length === 0 || value.length > maximum) {
    throw new Error(`${label} must be 1 to ${maximum} characters`);
  }
  if (!A2UI_IDENTIFIER_V1.test(value)) {
    throw new Error(
      `${label} must be letters, digits, dot, underscore or dash`,
    );
  }
  return value;
}

function a2uiBoundedString(
  value: unknown,
  maximum: number,
  label: string,
): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (value.length === 0 || value.length > maximum) {
    throw new Error(`${label} must be 1 to ${maximum} characters`);
  }
  return value;
}

/** JSON that survives a round trip, so the fold and the client agree on it. */
function a2uiJson(value: unknown, label: string): A2uiJsonValueV1 {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} is not JSON`);
  }
  if (serialized === undefined) throw new Error(`${label} is not JSON`);
  return JSON.parse(serialized) as A2uiJsonValueV1;
}

export function a2uiByteLengthV1(value: unknown): number {
  return UTF8.encode(JSON.stringify(value) ?? "").length;
}

/**
 * How many actions a component set asks for. An action is a catalog
 * component's `action` property carrying a name — the one thing on a surface
 * that reaches back into the kernel — so it is counted where it is written
 * rather than declared separately the way a `ViewDocument` declares one.
 */
export function a2uiActionCountV1(
  components: readonly A2uiComponentV1[],
): number {
  let count = 0;
  for (const component of components) {
    const action = component.action;
    if (
      typeof action === "object" &&
      action !== null &&
      !Array.isArray(action) &&
      typeof (action as { name?: unknown }).name === "string"
    ) {
      count++;
    }
  }
  return count;
}

function decodeComponent(value: unknown, label: string): A2uiComponentV1 {
  const component = a2uiRecord(value, label);
  const id = a2uiIdentifier(
    component.id,
    A2UI_LIMITS_V1.componentId,
    `${label}.id`,
  );
  const name = a2uiBoundedString(
    component.component,
    A2UI_LIMITS_V1.componentName,
    `${label}.component`,
  );
  if (!A2UI_COMPONENT_NAME_V1.test(name)) {
    throw new Error(`${label}.component is not a catalog component name`);
  }
  const catalogId =
    component.catalogId === undefined
      ? undefined
      : a2uiBoundedString(
          component.catalogId,
          A2UI_LIMITS_V1.catalogId,
          `${label}.catalogId`,
        );
  // The rest is the catalog's business, not this seam's: a component's own
  // properties are whatever its catalog entry declares, and a renderer that
  // does not know the component refuses the surface. They are carried as
  // JSON and bounded by the message's own byte budget.
  const properties = a2uiJson(component, label) as A2uiComponentV1;
  return {
    ...properties,
    id,
    component: name,
    ...(catalogId === undefined ? {} : { catalogId }),
  };
}

function decodeComponents(value: unknown, label: string): A2uiComponentV1[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > A2UI_LIMITS_V1.componentsPerSurface) {
    throw new Error(
      `${label} exceeds ${A2UI_LIMITS_V1.componentsPerSurface} components`,
    );
  }
  const components = value.map((entry, index) =>
    decodeComponent(entry, `${label}[${index}]`),
  );
  const ids = new Set(components.map((component) => component.id));
  if (ids.size !== components.length) {
    throw new Error(`${label} names the same component id twice`);
  }
  if (a2uiActionCountV1(components) > A2UI_LIMITS_V1.actionsPerSurface) {
    throw new Error(
      `${label} exceeds ${A2UI_LIMITS_V1.actionsPerSurface} actions`,
    );
  }
  return components;
}

function decodeDataModel(value: unknown, label: string): A2uiJsonObjectV1 {
  const model = a2uiRecord(value, label);
  const json = a2uiJson(model, label) as A2uiJsonObjectV1;
  if (a2uiByteLengthV1(json) > A2UI_LIMITS_V1.dataModelBytes) {
    throw new Error(`${label} exceeds ${A2UI_LIMITS_V1.dataModelBytes} bytes`);
  }
  return json;
}

/**
 * The member names a data model may not be written through. They are not
 * data: an untrusted author naming one is reaching for the prototype chain,
 * not for a key, so the pointer is refused here like any other malformed one.
 */
const A2UI_POINTER_RESERVED_V1 = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * A JSON Pointer (RFC 6901). Empty is the whole document; anything else is a
 * run of `/`-prefixed tokens. Refused here rather than at the fold, because a
 * pointer that cannot be resolved is a write with nowhere to land.
 */
export function a2uiPointerV1(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (value.length > A2UI_LIMITS_V1.pointer) {
    throw new Error(`${label} exceeds ${A2UI_LIMITS_V1.pointer} characters`);
  }
  if (value.length === 0) return value;
  if (!value.startsWith("/")) {
    throw new Error(`${label} must be a JSON Pointer starting with "/"`);
  }
  for (const token of value.slice(1).split("/")) {
    // `~` escapes `~0` and `~1` and nothing else; an unescaped one is a
    // pointer two implementations would resolve differently.
    if (/~(?![01])/.test(token)) {
      throw new Error(`${label} has an invalid JSON Pointer escape`);
    }
    const member = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (A2UI_POINTER_RESERVED_V1.has(member)) {
      throw new Error(`${label} names the reserved member "${member}"`);
    }
  }
  return value;
}

/** One agent→renderer message, decoded strictly at the seam. */
export function decodeA2uiAgentMessageV1(
  value: unknown,
  label = "A2UI message",
): A2uiAgentMessageV1 {
  const message = a2uiRecord(value, label);
  if (
    message.version !== A2UI_VERSION_V1 &&
    message.version !== A2UI_RENDERER_VERSION_V09
  ) {
    throw new Error(`${label}.version must be "${A2UI_VERSION_V1}"`);
  }
  if (a2uiByteLengthV1(message) > A2UI_LIMITS_V1.bytesPerMessage) {
    throw new Error(`${label} exceeds ${A2UI_LIMITS_V1.bytesPerMessage} bytes`);
  }
  const named = A2UI_AGENT_MESSAGE_KEYS_V1.filter((key) =>
    Object.hasOwn(message, key),
  );
  if (named.length !== 1) {
    throw new Error(
      `${label} must carry exactly one of ${A2UI_AGENT_MESSAGE_KEYS_V1.join(", ")}`,
    );
  }
  const kind = named[0]!;
  a2uiExactKeys(message, ["version", kind], label);
  const body = a2uiRecord(message[kind], `${label}.${kind}`);
  const surfaceId = a2uiIdentifier(
    body.surfaceId,
    A2UI_LIMITS_V1.surfaceId,
    `${label}.${kind}.surfaceId`,
  );
  switch (kind) {
    case "createSurface": {
      a2uiExactKeys(
        body,
        [
          "surfaceId",
          "catalogId",
          "sendDataModel",
          "surfaceProperties",
          "theme",
          "components",
          "dataModel",
        ],
        `${label}.${kind}`,
      );
      if (
        body.sendDataModel !== undefined &&
        typeof body.sendDataModel !== "boolean"
      ) {
        throw new Error(`${label}.${kind}.sendDataModel must be a boolean`);
      }
      if (body.surfaceProperties !== undefined && body.theme !== undefined) {
        throw new Error(
          `${label}.${kind} names both surfaceProperties and theme`,
        );
      }
      const properties = body.surfaceProperties ?? body.theme;
      return {
        version: A2UI_VERSION_V1,
        createSurface: {
          surfaceId,
          ...(body.catalogId === undefined
            ? {}
            : {
                catalogId: a2uiBoundedString(
                  body.catalogId,
                  A2UI_LIMITS_V1.catalogId,
                  `${label}.${kind}.catalogId`,
                ),
              }),
          ...(body.sendDataModel === undefined
            ? {}
            : { sendDataModel: body.sendDataModel }),
          ...(properties === undefined
            ? {}
            : {
                surfaceProperties: decodeDataModel(
                  properties,
                  `${label}.${kind}.surfaceProperties`,
                ),
              }),
          ...(body.components === undefined
            ? {}
            : {
                components: decodeComponents(
                  body.components,
                  `${label}.${kind}.components`,
                ),
              }),
          ...(body.dataModel === undefined
            ? {}
            : {
                dataModel: decodeDataModel(
                  body.dataModel,
                  `${label}.${kind}.dataModel`,
                ),
              }),
        },
      };
    }
    case "updateComponents": {
      a2uiExactKeys(body, ["surfaceId", "components"], `${label}.${kind}`);
      return {
        version: A2UI_VERSION_V1,
        updateComponents: {
          surfaceId,
          components: decodeComponents(
            body.components,
            `${label}.${kind}.components`,
          ),
        },
      };
    }
    case "updateDataModel": {
      a2uiExactKeys(body, ["surfaceId", "path", "value"], `${label}.${kind}`);
      if (!Object.hasOwn(body, "value")) {
        throw new Error(`${label}.${kind} is missing "value"`);
      }
      const written = a2uiJson(body.value, `${label}.${kind}.value`);
      if (a2uiByteLengthV1(written) > A2UI_LIMITS_V1.dataModelBytes) {
        throw new Error(
          `${label}.${kind}.value exceeds ${A2UI_LIMITS_V1.dataModelBytes} bytes`,
        );
      }
      return {
        version: A2UI_VERSION_V1,
        updateDataModel: {
          surfaceId,
          ...(body.path === undefined
            ? {}
            : { path: a2uiPointerV1(body.path, `${label}.${kind}.path`) }),
          value: written,
        },
      };
    }
    default: {
      a2uiExactKeys(body, ["surfaceId"], `${label}.${kind}`);
      return { version: A2UI_VERSION_V1, deleteSurface: { surfaceId } };
    }
  }
}

/** The `surfaceId` every message in one send must name. */
export function a2uiMessageSurfaceIdV1(message: A2uiAgentMessageV1): string {
  if ("createSurface" in message) return message.createSurface.surfaceId;
  if ("updateComponents" in message) return message.updateComponents.surfaceId;
  if ("updateDataModel" in message) return message.updateDataModel.surfaceId;
  return message.deleteSurface.surfaceId;
}

/**
 * One renderer `action`, as the client posts it. The name is the kernel's
 * business — `approval/<id>`, `plugin/<id>/<action>`, or conversation input —
 * so nothing here decides what it means.
 */
export function decodeA2uiActionV1(
  value: unknown,
  label = "A2UI action",
): A2uiActionV1 {
  const action = a2uiRecord(value, label);
  a2uiExactKeys(action, ["name", "context"], label);
  const name = a2uiBoundedString(
    action.name,
    A2UI_LIMITS_V1.actionName,
    `${label}.name`,
  );
  // The name is read back to a Bot as one line of its prompt preamble, so a
  // name carrying a line break could forge a lane a press must never become.
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error(`${label}.name must not contain control characters`);
  }
  if (action.context === undefined) return { name };
  const context = a2uiRecord(action.context, `${label}.context`);
  const json = a2uiJson(context, `${label}.context`) as A2uiJsonObjectV1;
  if (a2uiByteLengthV1(json) > A2UI_LIMITS_V1.dataModelBytes) {
    throw new Error(
      `${label}.context exceeds ${A2UI_LIMITS_V1.dataModelBytes} bytes`,
    );
  }
  return { name, context: json };
}
