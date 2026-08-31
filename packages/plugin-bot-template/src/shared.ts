// The Bot Template Package's wire shapes: everything that crosses a seam.
//
// "Cross-runtime communication uses narrow, versioned DTOs, and every inbound
// value is decoded at its seam." The template *document* lives in
// `@frockbot/template-core` beside `catalog-core`, because it is a product
// artifact several runtimes read without this Package mounted. What lives here
// is the traffic around it: the commands a User issues, the receipts they get
// back, and the summary of what an export packed and what it scrubbed.
//
// Nothing here carries a credential, a `connectionId`, an Assignment, or a
// webhook key, and the decoders refuse an unknown key, so a shape that grew one
// would fail at the seam rather than travel.
import {
  decodeTemplateShareRecordV1,
  decodeTemplateVisibilityV1,
  parseTemplateShareIdV1,
  TemplateDecodeError,
  type TemplateShareRecordV1,
  type TemplateVisibilityV1,
} from "@frockbot/template-core";

export { TemplateDecodeError };

/** Why something on the Bot did not reach the template. */
export const TEMPLATE_OMISSION_REASONS_V1 = [
  "managed-skill",
  "plugin-skill",
  "unattributed-skill",
  "unreadable-skill",
  "first-party-package",
  "package-values",
  "connection",
  "assignment",
  "model",
  "avatar-image",
  "memory",
  "private-network-server",
] as const;

export type TemplateOmissionReasonV1 =
  (typeof TEMPLATE_OMISSION_REASONS_V1)[number];

export interface TemplateOmissionV1 {
  reason: TemplateOmissionReasonV1;
  count: number;
}

/**
 * What one export packed and what it left behind.
 *
 * The card a Bot returns and the dialog a User confirms in are both drawn from
 * this, so "what was scrubbed" is durable state rather than prose a tool
 * happened to write.
 */
export interface TemplateExportSummaryV1 {
  schemaVersion: 1;
  botId: string;
  skills: number;
  routines: number;
  packages: number;
  publicServers: number;
  needsConnection: number;
  omitted: TemplateOmissionV1[];
}

interface TemplateCommandMetaV1 {
  schemaVersion: 1;
  commandId: string;
}

export type TemplateCommandV1 =
  | (TemplateCommandMetaV1 & { type: "template/stage"; botId: string })
  | (TemplateCommandMetaV1 & {
      type: "template/set-visibility";
      shareId: string;
      visibility: TemplateVisibilityV1;
    })
  | (TemplateCommandMetaV1 & { type: "template/revoke"; shareId: string });

export const TEMPLATE_COMMAND_TYPES_V1: readonly TemplateCommandV1["type"][] = [
  "template/stage",
  "template/set-visibility",
  "template/revoke",
];

export interface TemplateShareReceiptV1 {
  schemaVersion: 1;
  commandId: string;
  status: "applied";
  share: TemplateShareRecordV1;
  /** Present on a stage; a visibility change repacks nothing. */
  summary?: TemplateExportSummaryV1;
}

export interface TemplateShareListViewV1 {
  schemaVersion: 1;
  shares: TemplateShareRecordV1[];
}

/** Most shares one User may hold, so a staging loop cannot fill the object. */
export const MAX_TEMPLATE_SHARES_V1 = 200;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TemplateDecodeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
): void {
  const allowed = new Set(required);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TemplateDecodeError(`${label} has unknown field "${key}"`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new TemplateDecodeError(`${label} is missing "${key}"`);
    }
  }
}

function identifier(value: unknown, label: string, maximum = 128): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value)
  ) {
    throw new TemplateDecodeError(`${label} is invalid`);
  }
  return value;
}

function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TemplateDecodeError(`${label} is invalid`);
  }
  return value as number;
}

export function decodeTemplateCommandV1(input: unknown): TemplateCommandV1 {
  const value = record(input, "template command");
  if (value.schemaVersion !== 1) {
    throw new TemplateDecodeError(
      "template command schemaVersion is unsupported",
    );
  }
  const type = TEMPLATE_COMMAND_TYPES_V1.find((known) => known === value.type);
  if (!type) throw new TemplateDecodeError("template command type is unknown");
  if (type === "template/stage") {
    exact(value, ["schemaVersion", "type", "commandId", "botId"], type);
    return {
      schemaVersion: 1,
      type,
      commandId: identifier(value.commandId, "template commandId"),
      botId: identifier(value.botId, "template command botId"),
    };
  }
  if (type === "template/set-visibility") {
    exact(
      value,
      ["schemaVersion", "type", "commandId", "shareId", "visibility"],
      type,
    );
    parseTemplateShareIdV1(value.shareId);
    return {
      schemaVersion: 1,
      type,
      commandId: identifier(value.commandId, "template commandId"),
      shareId: value.shareId as string,
      visibility: decodeTemplateVisibilityV1(value.visibility),
    };
  }
  exact(value, ["schemaVersion", "type", "commandId", "shareId"], type);
  parseTemplateShareIdV1(value.shareId);
  return {
    schemaVersion: 1,
    type,
    commandId: identifier(value.commandId, "template commandId"),
    shareId: value.shareId as string,
  };
}

export function decodeTemplateOmissionV1(input: unknown): TemplateOmissionV1 {
  const value = record(input, "template omission");
  exact(value, ["reason", "count"], "template omission");
  const reason = TEMPLATE_OMISSION_REASONS_V1.find(
    (known) => known === value.reason,
  );
  if (!reason) {
    throw new TemplateDecodeError("template omission reason is unknown");
  }
  return { reason, count: count(value.count, "template omission count") };
}

export function decodeTemplateExportSummaryV1(
  input: unknown,
): TemplateExportSummaryV1 {
  const value = record(input, "template summary");
  exact(
    value,
    [
      "schemaVersion",
      "botId",
      "skills",
      "routines",
      "packages",
      "publicServers",
      "needsConnection",
      "omitted",
    ],
    "template summary",
  );
  if (value.schemaVersion !== 1) {
    throw new TemplateDecodeError("template summary schemaVersion is invalid");
  }
  if (
    !Array.isArray(value.omitted) ||
    value.omitted.length > TEMPLATE_OMISSION_REASONS_V1.length
  ) {
    throw new TemplateDecodeError("template summary omissions are invalid");
  }
  return {
    schemaVersion: 1,
    botId: identifier(value.botId, "template summary botId"),
    skills: count(value.skills, "template summary skills"),
    routines: count(value.routines, "template summary routines"),
    packages: count(value.packages, "template summary packages"),
    publicServers: count(value.publicServers, "template summary publicServers"),
    needsConnection: count(
      value.needsConnection,
      "template summary needsConnection",
    ),
    omitted: value.omitted.map(decodeTemplateOmissionV1),
  };
}

export function decodeTemplateShareReceiptV1(
  input: unknown,
): TemplateShareReceiptV1 {
  const value = record(input, "template receipt");
  const keys = ["schemaVersion", "commandId", "status", "share"];
  if (Object.hasOwn(value, "summary")) keys.push("summary");
  exact(value, keys, "template receipt");
  if (value.schemaVersion !== 1 || value.status !== "applied") {
    throw new TemplateDecodeError("template receipt is invalid");
  }
  return {
    schemaVersion: 1,
    commandId: identifier(value.commandId, "template receipt commandId"),
    status: "applied",
    share: decodeTemplateShareRecordV1(value.share),
    ...(value.summary === undefined
      ? {}
      : { summary: decodeTemplateExportSummaryV1(value.summary) }),
  };
}

export function decodeTemplateShareListViewV1(
  input: unknown,
): TemplateShareListViewV1 {
  const value = record(input, "template share list");
  exact(value, ["schemaVersion", "shares"], "template share list");
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.shares) ||
    value.shares.length > MAX_TEMPLATE_SHARES_V1
  ) {
    throw new TemplateDecodeError("template share list is invalid");
  }
  return {
    schemaVersion: 1,
    shares: value.shares.map(decodeTemplateShareRecordV1),
  };
}

/** The idempotency fingerprint of one template command. */
export function templateCommandFingerprintV1(
  command: TemplateCommandV1,
): string {
  const { commandId: _commandId, ...semantic } = command;
  return JSON.stringify([
    "bot-template-command-v1",
    semantic.type,
    "botId" in semantic ? semantic.botId : null,
    "shareId" in semantic ? semantic.shareId : null,
    "visibility" in semantic ? semantic.visibility : null,
  ]);
}

/** The path a `link` share is reachable at, relative to the deployment origin. */
export function templateSharePathV1(shareId: string): string {
  parseTemplateShareIdV1(shareId);
  return `/templates/v1/${encodeURIComponent(shareId)}`;
}
