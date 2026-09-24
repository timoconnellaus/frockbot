import {
  A2UI_IDENTIFIER_V1,
  A2UI_LIMITS_V1,
  a2uiMessageSurfaceIdV1,
  decodeA2uiAgentMessageV1,
  type A2uiAgentMessageV1,
} from "./a2ui.js";
import { cardSurfacePluginIdV1 } from "./plugin-worker.js";

// The typed payload a user-facing send carries.
//
// Parity register row 57b: GrokBot has exactly one voice to the user in chat,
// `SendToUser`, and it carries a payload union rather than a family of tools;
// row 57c: a question widget is one of those payloads, not a tool of its own,
// and sending one ends the turn.
//
// The DTO and its decoder live in core/contracts for the same reason
// `memory/injected` and `skill/injected` do: contracts carry the versioned
// shape that crosses a seam and gets written to the durable log, and the
// Package carries every scrap of behaviour. Nothing here decides what a turn
// type admits, when a payload ends a Turn, or how a client draws one.
//
// Only the `widget` shape is host-source. The other members are named
// alongside it but their field lists were never recorded, so they are declared
// here in the narrowest shape that carries the observed meaning, and widened
// when a primary source says more.
//
// `approval` has no GrokBot payload behind it at all: row 53 records only the
// harness sentence "when your own action needs approval". It carries a human
// confirmation required by a deny-only guard; it never widens Bot authority.
// Like `widget` it ends the Turn: the Bot has nothing to do until a human
// answers.

/** The widget shape, verbatim from the register: `options` holds 1–6 entries. */
export interface SendToUserWidgetV1 {
  prompt: string;
  helpText?: string;
  options: string[];
  allowCustom?: boolean;
  dismissOnMoveOn?: boolean;
}

export type SendToUserPayloadV1 =
  | { type: "text"; text: string }
  | {
      /**
       * One A2UI surface in the conversation (ADR 0030). Unlike `widget` and
       * `approval` it does not end the Turn: a card is something the Bot put
       * in the thread and keeps updating, not a question it is waiting on.
       */
      type: "card";
      surfaceId: string;
      messages: A2uiAgentMessageV1[];
    }
  | { type: "attachment"; url: string; name?: string; mediaType?: string }
  | { type: "widget"; widget: SendToUserWidgetV1 }
  | { type: "secret-request"; prompt: string; secretName: string }
  | { type: "agent-card"; agentId: string; title: string; body?: string }
  | {
      type: "approval";
      /** The Bot's own id for the decision, and the key it is recorded under. */
      approvalId: string;
      /** What the Bot proposes to do, in the words the User is asked about. */
      action: string;
      /** Why, when the action does not speak for itself. */
      rationale?: string;
      risk: SendToUserApprovalRiskV1;
      /** Clamped when it is recorded; absent takes the default. */
      expiresInSeconds?: number;
    };

/** How much a refused-by-silence outcome would cost. Ordered, not free text. */
export type SendToUserApprovalRiskV1 = "low" | "medium" | "high";

export const SEND_TO_USER_APPROVAL_RISKS_V1: readonly SendToUserApprovalRiskV1[] =
  ["low", "medium", "high"];

export const SEND_TO_USER_PAYLOAD_TYPES_V1: readonly SendToUserPayloadV1["type"][] =
  [
    "text",
    "attachment",
    "widget",
    "secret-request",
    "agent-card",
    "approval",
    "card",
  ];

/**
 * Bounds, so a payload cannot be the way a Turn writes an unbounded record
 * into durable state. They are product-shaped rather than protocol-shaped and
 * live beside the decoder that enforces them.
 */
export const SEND_TO_USER_LIMITS_V1 = {
  text: 32_000,
  url: 2_048,
  name: 256,
  mediaType: 128,
  prompt: 2_000,
  helpText: 2_000,
  option: 200,
  minOptions: 1,
  maxOptions: 6,
  secretName: 128,
  agentId: 128,
  title: 200,
  body: 8_000,
  approvalId: 128,
  action: 2_000,
  rationale: 8_000,
  // The Card budgets (ADR 0030). The numbers and the reasoning behind each of
  // them live in `a2ui.ts`, with the decoder that enforces them; naming them
  // here is how a send's bounds stay readable in one list.
  cardSurfaceId: A2UI_LIMITS_V1.surfaceId,
  cardMessagesPerSend: A2UI_LIMITS_V1.messagesPerSend,
  cardBytesPerMessage: A2UI_LIMITS_V1.bytesPerMessage,
  cardComponentsPerSurface: A2UI_LIMITS_V1.componentsPerSurface,
  cardSurfacesPerSession: A2UI_LIMITS_V1.surfacesPerSession,
  cardActionsPerSurface: A2UI_LIMITS_V1.actionsPerSurface,
  cardDataModelBytes: A2UI_LIMITS_V1.dataModelBytes,
} as const;

/**
 * The shape an `approvalId` may take. Narrower than a bounded string because
 * the id becomes a URL path segment and a durable storage key: an id that
 * cannot be addressed is a decision that cannot be answered.
 */
const APPROVAL_ID_PATTERN_V1 = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/**
 * The namespace the kernel mints a Card's own Approval ids in.
 *
 * Approval records live in one store, so an id the model may choose and an id
 * the kernel mints for a Card share a namespace. A model that could spell a
 * Card's id could ask for a decision under it on an earlier Turn, have a
 * person answer *that* question, and leave an approved record sitting behind a
 * card nobody decided about. So the namespace is the kernel's alone: the
 * minted half carries a seed no caller can guess, and this half — every
 * `send_to_user` approval, whoever sends it — refuses the prefix outright.
 */
export const CARD_APPROVAL_ID_PREFIX_V1 = "card-approval-";

/**
 * The namespace the kernel mints a saved secret's fill Approvals in.
 *
 * Reserved for the same reason as a Card's: filling a payment detail into a
 * page is released by an approved record under this id, so a model that
 * could ask for a decision under it in its own words could have a person
 * approve something they were never shown.
 */
export const SECRET_FILL_APPROVAL_ID_PREFIX_V1 = "secret-fill-";

/** What may waive the reserved prefix. */
export interface DecodeSendToUserOptionsV1 {
  /**
   * True only for a payload whose reserved ids the kernel itself minted or
   * has already checked: the Card ask it just minted, the card draw whose
   * surface id it minted for that Plugin, or a send being read back off a
   * Session's log. Never set where a model chose the ids — that is the seam
   * the reserved prefixes exist to hold.
   */
  kernelMinted?: boolean;
}

function payloadRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactPayloadKeys(
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

function boundedString(
  value: unknown,
  maximum: number,
  label: string,
  options: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (!options.allowEmpty && value.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (value.length > maximum) {
    throw new Error(`${label} exceeds ${maximum} characters`);
  }
  return value;
}

function optionalBoundedString(
  value: unknown,
  maximum: number,
  label: string,
): string | undefined {
  return value === undefined ? undefined : boundedString(value, maximum, label);
}

function boundedBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function decodeWidget(value: unknown, label: string): SendToUserWidgetV1 {
  const widget = payloadRecord(value, label);
  exactPayloadKeys(
    widget,
    ["prompt", "helpText", "options", "allowCustom", "dismissOnMoveOn"],
    label,
  );
  const limits = SEND_TO_USER_LIMITS_V1;
  const prompt = boundedString(widget.prompt, limits.prompt, `${label}.prompt`);
  const helpText = optionalBoundedString(
    widget.helpText,
    limits.helpText,
    `${label}.helpText`,
  );
  if (!Array.isArray(widget.options)) {
    throw new Error(`${label}.options must be an array`);
  }
  if (
    widget.options.length < limits.minOptions ||
    widget.options.length > limits.maxOptions
  ) {
    throw new Error(
      `${label}.options must hold ${limits.minOptions} to ${limits.maxOptions} entries`,
    );
  }
  const options = widget.options.map((option, index) =>
    boundedString(option, limits.option, `${label}.options[${index}]`),
  );
  if (new Set(options).size !== options.length) {
    throw new Error(`${label}.options has duplicates`);
  }
  const allowCustom = boundedBoolean(
    widget.allowCustom,
    `${label}.allowCustom`,
  );
  const dismissOnMoveOn = boundedBoolean(
    widget.dismissOnMoveOn,
    `${label}.dismissOnMoveOn`,
  );
  return {
    prompt,
    ...(helpText === undefined ? {} : { helpText }),
    options,
    ...(allowCustom === undefined ? {} : { allowCustom }),
    ...(dismissOnMoveOn === undefined ? {} : { dismissOnMoveOn }),
  };
}

/** The strict decoder for a send payload crossing any seam. */
export function decodeSendToUserPayloadV1(
  value: unknown,
  label = "send payload",
  options: DecodeSendToUserOptionsV1 = {},
): SendToUserPayloadV1 {
  const payload = payloadRecord(value, label);
  const limits = SEND_TO_USER_LIMITS_V1;
  switch (payload.type) {
    case "text": {
      exactPayloadKeys(payload, ["type", "text"], label);
      return {
        type: "text",
        text: boundedString(payload.text, limits.text, `${label}.text`),
      };
    }
    case "attachment": {
      exactPayloadKeys(payload, ["type", "url", "name", "mediaType"], label);
      const url = boundedString(payload.url, limits.url, `${label}.url`);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(`${label}.url must be an absolute URL`);
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error(`${label}.url must be an http or https URL`);
      }
      const name = optionalBoundedString(
        payload.name,
        limits.name,
        `${label}.name`,
      );
      const mediaType = optionalBoundedString(
        payload.mediaType,
        limits.mediaType,
        `${label}.mediaType`,
      );
      return {
        type: "attachment",
        url,
        ...(name === undefined ? {} : { name }),
        ...(mediaType === undefined ? {} : { mediaType }),
      };
    }
    case "widget": {
      exactPayloadKeys(payload, ["type", "widget"], label);
      return {
        type: "widget",
        widget: decodeWidget(payload.widget, `${label}.widget`),
      };
    }
    case "secret-request": {
      exactPayloadKeys(payload, ["type", "prompt", "secretName"], label);
      return {
        type: "secret-request",
        prompt: boundedString(payload.prompt, limits.prompt, `${label}.prompt`),
        secretName: boundedString(
          payload.secretName,
          limits.secretName,
          `${label}.secretName`,
        ),
      };
    }
    case "approval": {
      exactPayloadKeys(
        payload,
        [
          "type",
          "approvalId",
          "action",
          "rationale",
          "risk",
          "expiresInSeconds",
        ],
        label,
      );
      if (
        typeof payload.risk !== "string" ||
        !SEND_TO_USER_APPROVAL_RISKS_V1.includes(
          payload.risk as SendToUserApprovalRiskV1,
        )
      ) {
        throw new Error(`${label}.risk must be low, medium or high`);
      }
      // A window, not a duration to be interpreted: the record clamps it, and
      // the decoder only refuses what could not be a window at all.
      if (payload.expiresInSeconds !== undefined) {
        if (
          typeof payload.expiresInSeconds !== "number" ||
          !Number.isSafeInteger(payload.expiresInSeconds) ||
          payload.expiresInSeconds <= 0
        ) {
          throw new Error(
            `${label}.expiresInSeconds must be a positive whole number of seconds`,
          );
        }
      }
      const rationale = optionalBoundedString(
        payload.rationale,
        limits.rationale,
        `${label}.rationale`,
      );
      const approvalId = boundedString(
        payload.approvalId,
        limits.approvalId,
        `${label}.approvalId`,
      );
      if (!APPROVAL_ID_PATTERN_V1.test(approvalId)) {
        throw new Error(
          `${label}.approvalId must be letters, digits, dot, underscore or dash`,
        );
      }
      if (
        options.kernelMinted !== true &&
        approvalId.startsWith(CARD_APPROVAL_ID_PREFIX_V1)
      ) {
        throw new Error(
          `${label}.approvalId must not start with "${CARD_APPROVAL_ID_PREFIX_V1}": that namespace is the kernel's, for the decisions a Card asks for`,
        );
      }
      if (
        options.kernelMinted !== true &&
        approvalId.startsWith(SECRET_FILL_APPROVAL_ID_PREFIX_V1)
      ) {
        throw new Error(
          `${label}.approvalId must not start with "${SECRET_FILL_APPROVAL_ID_PREFIX_V1}": that namespace is the kernel's, for filling a saved secret into a page`,
        );
      }
      return {
        type: "approval",
        approvalId,
        action: boundedString(payload.action, limits.action, `${label}.action`),
        ...(rationale === undefined ? {} : { rationale }),
        risk: payload.risk as SendToUserApprovalRiskV1,
        ...(payload.expiresInSeconds === undefined
          ? {}
          : { expiresInSeconds: payload.expiresInSeconds }),
      };
    }
    case "card": {
      exactPayloadKeys(payload, ["type", "surfaceId", "messages"], label);
      const surfaceId = boundedString(
        payload.surfaceId,
        limits.cardSurfaceId,
        `${label}.surfaceId`,
      );
      if (!A2UI_IDENTIFIER_V1.test(surfaceId)) {
        throw new Error(
          `${label}.surfaceId must be letters, digits, dot, underscore or dash`,
        );
      }
      // The minted `<pluginId>_<cardId>.` shape is what says whose card a
      // surface is, on the draw and on the press alike. A payload the kernel
      // has not already admitted may not spell it: otherwise a Bot could draw
      // a card wearing a Plugin's prefix and a `plugin/<id>/<action>` press on
      // it would reach that Plugin's handler with a surface it never drew.
      if (
        options.kernelMinted !== true &&
        cardSurfacePluginIdV1(surfaceId) !== undefined
      ) {
        throw new Error(
          `${label}.surfaceId must not carry a "<pluginId>_<cardId>." prefix: that namespace is the kernel's, for the cards a Plugin draws`,
        );
      }
      if (!Array.isArray(payload.messages)) {
        throw new Error(`${label}.messages must be an array`);
      }
      if (
        payload.messages.length === 0 ||
        payload.messages.length > limits.cardMessagesPerSend
      ) {
        throw new Error(
          `${label}.messages must hold 1 to ${limits.cardMessagesPerSend} entries`,
        );
      }
      const messages = payload.messages.map((message, index) =>
        decodeA2uiAgentMessageV1(message, `${label}.messages[${index}]`),
      );
      // One send is one surface. A payload whose messages wander between
      // surfaces would fold into records the send does not name, which is
      // how a Card would reach a Card the Bot was not talking about.
      for (const [index, message] of messages.entries()) {
        if (a2uiMessageSurfaceIdV1(message) !== surfaceId) {
          throw new Error(
            `${label}.messages[${index}] names a different surface`,
          );
        }
      }
      return { type: "card", surfaceId, messages };
    }
    case "agent-card": {
      exactPayloadKeys(payload, ["type", "agentId", "title", "body"], label);
      const body = optionalBoundedString(
        payload.body,
        limits.body,
        `${label}.body`,
      );
      return {
        type: "agent-card",
        agentId: boundedString(
          payload.agentId,
          limits.agentId,
          `${label}.agentId`,
        ),
        title: boundedString(payload.title, limits.title, `${label}.title`),
        ...(body === undefined ? {} : { body }),
      };
    }
    default:
      throw new Error(`${label}.type is invalid`);
  }
}
