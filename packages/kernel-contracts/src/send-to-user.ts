// The typed payload a user-facing send carries.
//
// Parity register row 57b: GrokBot has exactly one voice to the user in chat,
// `SendToUser`, and it carries a payload union rather than a family of tools;
// row 57c: a question widget is one of those payloads, not a tool of its own,
// and sending one ends the turn.
//
// The DTO and its decoder live in kernel-contracts for the same reason
// `memory/injected` and `skill/injected` do: contracts carry the versioned
// shape that crosses a seam and gets written to the durable log, and the
// Package carries every scrap of behaviour. Nothing here decides what a turn
// type admits, when a payload ends a Turn, or how a client draws one.
//
// Only the `widget` shape is host-source (§4.2 of `docs/research/
// grokbot-computer.md`). The other four members are named in the same section
// but their field lists are not recorded, so they are declared here in the
// narrowest shape that carries the observed meaning, and widened when a
// primary source says more.

/** The widget shape, verbatim from §4.2: `options` holds 1–6 entries. */
export interface SendToUserWidgetV1 {
  prompt: string;
  helpText?: string;
  options: string[];
  allowCustom?: boolean;
  dismissOnMoveOn?: boolean;
}

export type SendToUserPayloadV1 =
  | { type: "text"; text: string }
  | { type: "attachment"; url: string; name?: string; mediaType?: string }
  | { type: "widget"; widget: SendToUserWidgetV1 }
  | { type: "secret-request"; prompt: string; secretName: string }
  | { type: "agent-card"; agentId: string; title: string; body?: string }
  /**
   * A Connection the Bot has recorded a pending authorization decision for.
   *
   * There is deliberately **no URL** on this payload, and there never will be.
   * A Bot may create a durable *request* for authorization; only an
   * authenticated User action mints a redirect, and a single-use ten-minute
   * link sitting in a client-readable transcript would outlive the decision it
   * belonged to. The client draws a card from the Connection's own projection
   * and the User presses it; the host authors the link at that moment.
   */
  | {
      type: "connect-card";
      connectionId: string;
      title: string;
      body?: string;
    };

export const SEND_TO_USER_PAYLOAD_TYPES_V1: readonly SendToUserPayloadV1["type"][] =
  [
    "text",
    "attachment",
    "widget",
    "secret-request",
    "agent-card",
    "connect-card",
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
  connectionId: 128,
  title: 200,
  body: 8_000,
} as const;

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
    case "connect-card": {
      exactPayloadKeys(
        payload,
        ["type", "connectionId", "title", "body"],
        label,
      );
      const body = optionalBoundedString(
        payload.body,
        limits.body,
        `${label}.body`,
      );
      return {
        type: "connect-card",
        connectionId: boundedString(
          payload.connectionId,
          limits.connectionId,
          `${label}.connectionId`,
        ),
        title: boundedString(payload.title, limits.title, `${label}.title`),
        ...(body === undefined ? {} : { body }),
      };
    }
    default:
      throw new Error(`${label}.type is invalid`);
  }
}
