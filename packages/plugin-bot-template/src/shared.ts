// The Bot Template Package's wire shapes: everything that crosses a seam.
//
// "Cross-runtime communication uses narrow, versioned DTOs, and every inbound
// value is decoded at its seam." The template *document* lives in
// `@frockbot/template-core` beside `catalog-core`, because it is a product
// artifact several runtimes read without this Package mounted. What lives here
// is the traffic around it: the commands a User issues, the receipts they get
// back, and the summary of what an export packed and what it scrubbed.
//
// Nothing here carries a credential, a `connectionId`, or a webhook key, and
// the decoders refuse an unknown key, so a shape that grew one would fail at
// the seam rather than travel.
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
  | (TemplateCommandMetaV1 & { type: "template/plan-import"; shareId: string })
  | (TemplateCommandMetaV1 & {
      type: "template/apply-import";
      importId: string;
    })
  | (TemplateCommandMetaV1 & {
      type: "template/set-visibility";
      shareId: string;
      visibility: TemplateVisibilityV1;
    })
  | (TemplateCommandMetaV1 & { type: "template/revoke"; shareId: string });

export const TEMPLATE_COMMAND_TYPES_V1: readonly TemplateCommandV1["type"][] = [
  "template/stage",
  "template/plan-import",
  "template/apply-import",
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
  if (type === "template/plan-import") {
    exact(value, ["schemaVersion", "type", "commandId", "shareId"], type);
    parseTemplateShareIdV1(value.shareId);
    return {
      schemaVersion: 1,
      type,
      commandId: identifier(value.commandId, "template commandId"),
      shareId: value.shareId as string,
    };
  }
  if (type === "template/apply-import") {
    exact(value, ["schemaVersion", "type", "commandId", "importId"], type);
    return {
      schemaVersion: 1,
      type,
      commandId: identifier(value.commandId, "template commandId"),
      importId: identifier(value.importId, "template importId"),
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
    "importId" in semantic ? semantic.importId : null,
    "visibility" in semantic ? semantic.visibility : null,
  ]);
}

/** The path a `link` share is reachable at, relative to the deployment origin. */
export function templateSharePathV1(shareId: string): string {
  parseTemplateShareIdV1(shareId);
  return `/templates/v1/${encodeURIComponent(shareId)}`;
}

// ---------------------------------------------------------------------------
// Import: the durable record and the review card.
//
// "Failures are observable through durable state rather than existing only in
// process logs or client memory." An import is a saga with one receipt per
// step, so a Bot that came out half-built says exactly which step failed and
// why, and re-applying resumes from there rather than starting again.
// ---------------------------------------------------------------------------

export const TEMPLATE_IMPORT_STEP_STATUSES_V1 = [
  "pending",
  "in-flight",
  "done",
  "skipped",
  "failed",
] as const;

export type TemplateImportStepStatusV1 =
  (typeof TEMPLATE_IMPORT_STEP_STATUSES_V1)[number];

export interface TemplateImportStepReceiptV1 {
  key: string;
  kind:
    | "bot/create"
    | "user/install-package"
    | "skill/write"
    | "routine/create"
    | "routine/disable";
  status: TemplateImportStepStatusV1;
  subject?: string;
  /** What the step produced: a generation id, a routine id, a receipt id. */
  detail?: string;
  failure?: string;
}

export const TEMPLATE_IMPORT_STATUSES_V1 = [
  "planned",
  "applying",
  "applied",
  "failed",
] as const;

export type TemplateImportStatusV1 =
  (typeof TEMPLATE_IMPORT_STATUSES_V1)[number];

/**
 * One import, as the User Durable Object holds it and the client renders it.
 *
 * `status: "planned"` is the state a review card is shown in, and nothing has
 * been applied in it. Only an explicit `template/apply-import` moves it on,
 * which is what "Nothing is applied before the User confirms" means in durable
 * state rather than in a component's `v-if`.
 */
export interface TemplateImportRecordV1 {
  schemaVersion: 1;
  importId: string;
  shareId: string;
  hash: string;
  botId: string;
  status: TemplateImportStatusV1;
  botName: string;
  packages: {
    catalogId: string;
    packageId: string;
    displayName: string;
    version: string;
    status: "will-install" | "already-installed" | "missing";
  }[];
  connections: {
    name: string;
    connectionTypeId?: string;
    url?: string;
    hint?: string;
  }[];
  skills: string[];
  routines: { slug: string; disabled: boolean }[];
  steps: TemplateImportStepReceiptV1[];
  createdAt: string;
  updatedAt: string;
  catalogGeneration?: string;
  failure?: string;
}

export interface TemplateImportListViewV1 {
  schemaVersion: 1;
  imports: TemplateImportRecordV1[];
}

export interface TemplateImportReceiptV1 {
  schemaVersion: 1;
  commandId: string;
  status: "applied";
  import: TemplateImportRecordV1;
}

/** Most imports one User may hold, so planning cannot fill the object. */
export const MAX_TEMPLATE_IMPORTS_V1 = 100;

function importStatus(value: unknown): TemplateImportStatusV1 {
  const found = TEMPLATE_IMPORT_STATUSES_V1.find((known) => known === value);
  if (!found)
    throw new TemplateDecodeError("template import status is invalid");
  return found;
}

function importStepStatus(value: unknown): TemplateImportStepStatusV1 {
  const found = TEMPLATE_IMPORT_STEP_STATUSES_V1.find(
    (known) => known === value,
  );
  if (!found) {
    throw new TemplateDecodeError("template import step status is invalid");
  }
  return found;
}

const IMPORT_STEP_KINDS = [
  "bot/create",
  "user/install-package",
  "skill/write",
  "routine/create",
  "routine/disable",
] as const;

function optional(value: unknown, label: string, maximum: number) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximum) {
    throw new TemplateDecodeError(`${label} is invalid`);
  }
  return value;
}

function required(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum) {
    throw new TemplateDecodeError(`${label} is invalid`);
  }
  return value;
}

export function decodeTemplateImportStepReceiptV1(
  input: unknown,
): TemplateImportStepReceiptV1 {
  const value = record(input, "template import step");
  const kind = IMPORT_STEP_KINDS.find((known) => known === value.kind);
  if (!kind) {
    throw new TemplateDecodeError("template import step kind is unknown");
  }
  return {
    key: required(value.key, "template import step key", 200),
    kind,
    status: importStepStatus(value.status),
    ...(value.subject === undefined
      ? {}
      : { subject: required(value.subject, "step subject", 200) }),
    ...(value.detail === undefined
      ? {}
      : { detail: required(value.detail, "step detail", 500) }),
    ...(value.failure === undefined
      ? {}
      : { failure: required(value.failure, "step failure", 2_000) }),
  };
}

export function decodeTemplateImportRecordV1(
  input: unknown,
): TemplateImportRecordV1 {
  const value = record(input, "template import");
  if (value.schemaVersion !== 1) {
    throw new TemplateDecodeError("template import schemaVersion is invalid");
  }
  if (
    !Array.isArray(value.steps) ||
    !Array.isArray(value.packages) ||
    !Array.isArray(value.connections) ||
    !Array.isArray(value.skills) ||
    !Array.isArray(value.routines)
  ) {
    throw new TemplateDecodeError("template import sections are invalid");
  }
  parseTemplateShareIdV1(value.shareId);
  return {
    schemaVersion: 1,
    importId: identifier(value.importId, "template importId"),
    shareId: value.shareId as string,
    hash: required(value.hash, "template import hash", 64),
    botId: required(value.botId, "template import botId", 128),
    status: importStatus(value.status),
    botName: required(value.botName, "template import botName", 100),
    packages: value.packages.map((entry) => {
      const line = record(entry, "template import package");
      const status = ["will-install", "already-installed", "missing"].find(
        (known) => known === line.status,
      );
      if (!status) {
        throw new TemplateDecodeError(
          "template import package status is invalid",
        );
      }
      return {
        catalogId: required(line.catalogId, "catalogId", 64),
        packageId: required(line.packageId, "packageId", 64),
        displayName: required(line.displayName, "displayName", 100),
        version: required(line.version, "version", 100),
        status: status as "will-install" | "already-installed" | "missing",
      };
    }),
    connections: value.connections.map((entry) => {
      const line = record(entry, "template import connection");
      return {
        name: required(line.name, "connection name", 100),
        ...(line.connectionTypeId === undefined
          ? {}
          : {
              connectionTypeId: required(
                line.connectionTypeId,
                "connectionTypeId",
                64,
              ),
            }),
        ...(line.url === undefined
          ? {}
          : { url: required(line.url, "connection url", 2_048) }),
        ...(line.hint === undefined
          ? {}
          : { hint: required(line.hint, "connection hint", 500) }),
      };
    }),
    skills: value.skills.map((slug) => required(slug, "skill slug", 128)),
    routines: value.routines.map((entry) => {
      const line = record(entry, "template import routine");
      if (typeof line.disabled !== "boolean") {
        throw new TemplateDecodeError("template import routine is invalid");
      }
      return {
        slug: required(line.slug, "routine slug", 128),
        disabled: line.disabled,
      };
    }),
    steps: value.steps.map(decodeTemplateImportStepReceiptV1),
    createdAt: required(value.createdAt, "template import createdAt", 64),
    updatedAt: required(value.updatedAt, "template import updatedAt", 64),
    ...(value.catalogGeneration === undefined
      ? {}
      : {
          catalogGeneration: required(
            value.catalogGeneration,
            "catalogGeneration",
            64,
          ),
        }),
    ...(value.failure === undefined
      ? {}
      : { failure: required(value.failure, "template import failure", 2_000) }),
  };
}

export function decodeTemplateImportReceiptV1(
  input: unknown,
): TemplateImportReceiptV1 {
  const value = record(input, "template import receipt");
  exact(
    value,
    ["schemaVersion", "commandId", "status", "import"],
    "template import receipt",
  );
  if (value.schemaVersion !== 1 || value.status !== "applied") {
    throw new TemplateDecodeError("template import receipt is invalid");
  }
  return {
    schemaVersion: 1,
    commandId: identifier(value.commandId, "template receipt commandId"),
    status: "applied",
    import: decodeTemplateImportRecordV1(value.import),
  };
}

export function decodeTemplateImportListViewV1(
  input: unknown,
): TemplateImportListViewV1 {
  const value = record(input, "template import list");
  exact(value, ["schemaVersion", "imports"], "template import list");
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.imports) ||
    value.imports.length > MAX_TEMPLATE_IMPORTS_V1
  ) {
    throw new TemplateDecodeError("template import list is invalid");
  }
  return {
    schemaVersion: 1,
    imports: value.imports.map(decodeTemplateImportRecordV1),
  };
}
