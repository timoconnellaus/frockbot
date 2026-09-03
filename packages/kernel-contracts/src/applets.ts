// The Applet DTOs.
//
// An Applet is one durable instance per User of a Package's Instance
// Contribution (ADR 0022). The kernel is the authority for its directory
// entry, its generations, its viewer sessions, and its deletion — never for
// its contents. These are the narrow, versioned records and views that cross
// between the User Durable Object, the Applet Durable Object, the Bot isolate
// capability, and the hosted client, so they are declared once here and every
// inbound value is decoded at its seam.
//
// The manifest side of the same feature lives in `@frockbot/kernel-composition`
// (`InstanceContributionV1`); the durable authority that writes these records
// is lane K3.

/** The tool declaration an Applet generation copies from its manifest. */
export interface AppletToolDeclarationV1 {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AppletArtifactRefV1 {
  contentHash: string;
  size: number;
  mediaType: "application/javascript";
  bundlerVersion: string;
}

export interface AppletUiArtifactRefV1 {
  contentHash: string;
  size: number;
  mediaType: "text/html";
  bundlerVersion: string;
}

export type AppletStatusV1 = "draft" | "published" | "deleted";

export type AppletGenerationStatusV1 =
  "pending" | "active" | "superseded" | "failed";

export type AppletProvenanceV1 =
  | { kind: "bot"; botId: string; sessionId: string; turnId: string }
  | { kind: "user" };

/** User Durable Object, key `applets:entry:<appletId>`. */
export interface AppletDirectoryEntryV1 {
  schemaVersion: 1;
  /** `<publicUserId>.<random>` — the ADR 0015 shape. */
  appletId: string;
  displayName: string;
  /** Absent until the first successful publish. */
  currentGenerationId?: string;
  tools: AppletToolDeclarationV1[];
  provenance: AppletProvenanceV1;
  createdAt: string;
  status: AppletStatusV1;
}

/** Applet Durable Object, key `applet:generation:<generationId>`. */
export interface AppletGenerationV1 {
  schemaVersion: 1;
  /** Sortable and monotonic within one Applet. */
  generationId: string;
  parentGenerationId?: string;
  server: AppletArtifactRefV1;
  ui: AppletUiArtifactRefV1;
  tools: AppletToolDeclarationV1[];
  contract: 1;
  origin: "publish" | "revert";
  provenance: {
    botId: string;
    sessionId: string;
    turnId: string;
    runId: string;
  };
  createdAt: string;
  status: AppletGenerationStatusV1;
}

/** What `ctx.applets.list` and `create` return to a Bot isolate. */
export interface AppletSummaryV1 {
  appletId: string;
  displayName: string;
  status: AppletStatusV1;
  currentGenerationId?: string;
  tools: string[];
  createdAt: string;
}

/** One row of an Applet's version history. */
export interface AppletGenerationSummaryV1 {
  generationId: string;
  parentGenerationId?: string;
  origin: "publish" | "revert";
  status: AppletGenerationStatusV1;
  tools: string[];
  createdAt: string;
  isCurrent: boolean;
}

/** The outcome of `publish` or `revert`. A failure is visible, never silent. */
export type AppletPublishResultV1 =
  | {
      status: "published";
      appletId: string;
      generationId: string;
      tools: string[];
      /** The Composition generation proposed for the calling Bot. */
      compositionGenerationId?: string;
    }
  | {
      status: "failed";
      appletId: string;
      generationId: string;
      reason: string;
      diagnostics: string[];
    };

/** A short-lived credential for one viewer of one Applet generation. */
export interface AppletViewerTokenV1 {
  token: string;
  expiresAt: string;
  socketUrl: string;
}

/** Where the canvas reads an Applet's live UI from. */
export interface AppletUiViewV1 {
  uiUrl: string;
  /** Absent while the Applet has no active generation. */
  generationId?: string;
}

/**
 * The Session's focused Applet. One per Session, and `null` is a value: it is
 * the Session having deliberately no Applet in the canvas, not a missing read.
 */
export interface AppletFocusViewV1 {
  appletId: string | null;
}

/** The Applets the User owns, as a client reads them. */
export interface AppletListViewV1 {
  schemaVersion: 1;
  applets: AppletSummaryV1[];
}

/** One text file of an Applet's source, as the canvas draws it. */
export interface AppletSourceFileV1 {
  /** Relative to `applets/<appletId>/` in the Applets Package's durable root. */
  path: string;
  text: string;
  /** The Workspace generation this text was read at. */
  generationId: string;
  /** When the Workspace last recorded a write, when the store knows it. */
  changedAt?: string;
}

/**
 * An Applet's source as the canvas shows it while the Bot is still writing it.
 * `truncated` says the store held more than the read limit, so the canvas can
 * say so rather than implying the Applet is smaller than it is.
 */
export interface AppletSourceViewV1 {
  appletId: string;
  files: AppletSourceFileV1[];
  truncated: boolean;
}

/** The outcome the Bot last recorded for `applet check` or `applet build`. */
export interface AppletBuildViewV1 {
  status: "unknown" | "passed" | "failed";
  command?: "check" | "build";
  at?: string;
  summary?: string;
  diagnostics?: string[];
}

/** Bounds on the source read, so a canvas load can never be unbounded. */
export const APPLET_SOURCE_MAX_BYTES_V1 = 512 * 1024;
export const APPLET_SOURCE_MAX_FILES_V1 = 256;
export const APPLET_SOURCE_MAX_DIAGNOSTICS_V1 = 64;

export const APPLET_ID_V1 = /^[a-z0-9][a-z0-9-]{0,63}\.[a-z0-9-]{1,64}$/;
export const APPLET_TOOL_NAME_V1 = /^[a-z][a-z0-9_]{0,63}$/;
export const APPLET_MAX_TOOLS_V1 = 64;
export const APPLET_MAX_GENERATIONS_PAGE_V1 = 64;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set<string>([...required, ...optional]);
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    !Object.keys(value).every((key) => allowed.has(key))
  ) {
    throw new Error(`${label} has invalid fields`);
  }
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    throw new Error(`${label} must be a bounded non-empty string`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  const text = boundedString(value, label, 64);
  if (Number.isNaN(Date.parse(text)))
    throw new Error(`${label} must be an ISO timestamp`);
  return text;
}

function appletId(value: unknown, label: string): string {
  const id = boundedString(value, label, 129);
  if (!APPLET_ID_V1.test(id)) throw new Error(`${label} is invalid`);
  return id;
}

function json(value: unknown, label: string, depth = 0): void {
  if (depth > 16) throw new Error(`${label} is too deeply nested`);
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw new Error(`${label} has too many entries`);
    for (const entry of value) json(entry, label, depth + 1);
    return;
  }
  const object = record(value, label);
  if (Object.keys(object).length > 256)
    throw new Error(`${label} has too many fields`);
  for (const entry of Object.values(object)) json(entry, label, depth + 1);
}

function toolNames(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > APPLET_MAX_TOOLS_V1)
    throw new Error(`${label} must be a bounded array`);
  const names = value.map((name, index) => {
    const decoded = boundedString(name, `${label}[${index}]`, 64);
    if (!APPLET_TOOL_NAME_V1.test(decoded))
      throw new Error(`${label}[${index}] is invalid`);
    return decoded;
  });
  if (new Set(names).size !== names.length)
    throw new Error(`${label} contains duplicate names`);
  return names;
}

export function decodeAppletToolDeclarationV1(
  input: unknown,
  label = "Applet tool declaration",
): AppletToolDeclarationV1 {
  const value = record(input, label);
  exactKeys(value, ["name", "description", "inputSchema"], [], label);
  const name = boundedString(value.name, `${label}.name`, 64);
  if (!APPLET_TOOL_NAME_V1.test(name))
    throw new Error(`${label}.name is invalid`);
  const inputSchema = record(value.inputSchema, `${label}.inputSchema`);
  json(inputSchema, `${label}.inputSchema`);
  return {
    name,
    description: boundedString(
      value.description,
      `${label}.description`,
      1_024,
    ),
    inputSchema: structuredClone(inputSchema),
  };
}

function toolDeclarations(
  value: unknown,
  label: string,
): AppletToolDeclarationV1[] {
  if (!Array.isArray(value) || value.length > APPLET_MAX_TOOLS_V1)
    throw new Error(`${label} must be a bounded array`);
  const tools = value.map((tool, index) =>
    decodeAppletToolDeclarationV1(tool, `${label}[${index}]`),
  );
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
    throw new Error(`${label} contains duplicate names`);
  return tools;
}

function serverRef(input: unknown, label: string): AppletArtifactRefV1 {
  const value = record(input, label);
  exactKeys(
    value,
    ["contentHash", "size", "mediaType", "bundlerVersion"],
    [],
    label,
  );
  if (
    typeof value.contentHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.contentHash)
  )
    throw new Error(`${label}.contentHash must be a sha-256 hex digest`);
  if (!Number.isSafeInteger(value.size) || (value.size as number) < 0)
    throw new Error(`${label}.size must be a non-negative integer`);
  if (value.mediaType !== "application/javascript")
    throw new Error(`${label}.mediaType is invalid`);
  return {
    contentHash: value.contentHash,
    size: value.size as number,
    mediaType: "application/javascript",
    bundlerVersion: boundedString(
      value.bundlerVersion,
      `${label}.bundlerVersion`,
      128,
    ),
  };
}

function uiRef(input: unknown, label: string): AppletUiArtifactRefV1 {
  const value = record(input, label);
  exactKeys(
    value,
    ["contentHash", "size", "mediaType", "bundlerVersion"],
    [],
    label,
  );
  if (
    typeof value.contentHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.contentHash)
  )
    throw new Error(`${label}.contentHash must be a sha-256 hex digest`);
  if (
    !Number.isSafeInteger(value.size) ||
    (value.size as number) < 0 ||
    (value.size as number) > 256 * 1024
  )
    throw new Error(`${label}.size must be within the 256 KB quota`);
  if (value.mediaType !== "text/html")
    throw new Error(`${label}.mediaType is invalid`);
  return {
    contentHash: value.contentHash,
    size: value.size as number,
    mediaType: "text/html",
    bundlerVersion: boundedString(
      value.bundlerVersion,
      `${label}.bundlerVersion`,
      128,
    ),
  };
}

function status(value: unknown, label: string): AppletStatusV1 {
  if (value !== "draft" && value !== "published" && value !== "deleted")
    throw new Error(`${label} is invalid`);
  return value;
}

function generationStatus(
  value: unknown,
  label: string,
): AppletGenerationStatusV1 {
  if (
    value !== "pending" &&
    value !== "active" &&
    value !== "superseded" &&
    value !== "failed"
  )
    throw new Error(`${label} is invalid`);
  return value;
}

function origin(value: unknown, label: string): "publish" | "revert" {
  if (value !== "publish" && value !== "revert")
    throw new Error(`${label} is invalid`);
  return value;
}

export function decodeAppletDirectoryEntryV1(
  input: unknown,
  label = "Applet directory entry",
): AppletDirectoryEntryV1 {
  const value = record(input, label);
  exactKeys(
    value,
    [
      "schemaVersion",
      "appletId",
      "displayName",
      "tools",
      "provenance",
      "createdAt",
      "status",
    ],
    ["currentGenerationId"],
    label,
  );
  if (value.schemaVersion !== 1)
    throw new Error(`${label}.schemaVersion is unsupported`);
  const provenance = record(value.provenance, `${label}.provenance`);
  let decodedProvenance: AppletProvenanceV1;
  if (provenance.kind === "user") {
    exactKeys(provenance, ["kind"], [], `${label}.provenance`);
    decodedProvenance = { kind: "user" };
  } else if (provenance.kind === "bot") {
    exactKeys(
      provenance,
      ["kind", "botId", "sessionId", "turnId"],
      [],
      `${label}.provenance`,
    );
    decodedProvenance = {
      kind: "bot",
      botId: boundedString(provenance.botId, `${label}.provenance.botId`, 256),
      sessionId: boundedString(
        provenance.sessionId,
        `${label}.provenance.sessionId`,
        256,
      ),
      turnId: boundedString(
        provenance.turnId,
        `${label}.provenance.turnId`,
        256,
      ),
    };
  } else {
    throw new Error(`${label}.provenance.kind is invalid`);
  }
  return {
    schemaVersion: 1,
    appletId: appletId(value.appletId, `${label}.appletId`),
    displayName: boundedString(value.displayName, `${label}.displayName`, 128),
    ...(value.currentGenerationId === undefined
      ? {}
      : {
          currentGenerationId: boundedString(
            value.currentGenerationId,
            `${label}.currentGenerationId`,
            128,
          ),
        }),
    tools: toolDeclarations(value.tools, `${label}.tools`),
    provenance: decodedProvenance,
    createdAt: timestamp(value.createdAt, `${label}.createdAt`),
    status: status(value.status, `${label}.status`),
  };
}

export function decodeAppletGenerationV1(
  input: unknown,
  label = "Applet generation",
): AppletGenerationV1 {
  const value = record(input, label);
  exactKeys(
    value,
    [
      "schemaVersion",
      "generationId",
      "server",
      "ui",
      "tools",
      "contract",
      "origin",
      "provenance",
      "createdAt",
      "status",
    ],
    ["parentGenerationId"],
    label,
  );
  if (value.schemaVersion !== 1)
    throw new Error(`${label}.schemaVersion is unsupported`);
  if (value.contract !== 1) throw new Error(`${label}.contract is unsupported`);
  const provenance = record(value.provenance, `${label}.provenance`);
  exactKeys(
    provenance,
    ["botId", "sessionId", "turnId", "runId"],
    [],
    `${label}.provenance`,
  );
  return {
    schemaVersion: 1,
    generationId: boundedString(
      value.generationId,
      `${label}.generationId`,
      128,
    ),
    ...(value.parentGenerationId === undefined
      ? {}
      : {
          parentGenerationId: boundedString(
            value.parentGenerationId,
            `${label}.parentGenerationId`,
            128,
          ),
        }),
    server: serverRef(value.server, `${label}.server`),
    ui: uiRef(value.ui, `${label}.ui`),
    tools: toolDeclarations(value.tools, `${label}.tools`),
    contract: 1,
    origin: origin(value.origin, `${label}.origin`),
    provenance: {
      botId: boundedString(provenance.botId, `${label}.provenance.botId`, 256),
      sessionId: boundedString(
        provenance.sessionId,
        `${label}.provenance.sessionId`,
        256,
      ),
      turnId: boundedString(
        provenance.turnId,
        `${label}.provenance.turnId`,
        256,
      ),
      runId: boundedString(provenance.runId, `${label}.provenance.runId`, 256),
    },
    createdAt: timestamp(value.createdAt, `${label}.createdAt`),
    status: generationStatus(value.status, `${label}.status`),
  };
}

export function decodeAppletSummaryV1(
  input: unknown,
  label = "Applet summary",
): AppletSummaryV1 {
  const value = record(input, label);
  exactKeys(
    value,
    ["appletId", "displayName", "status", "tools", "createdAt"],
    ["currentGenerationId"],
    label,
  );
  return {
    appletId: appletId(value.appletId, `${label}.appletId`),
    displayName: boundedString(value.displayName, `${label}.displayName`, 128),
    status: status(value.status, `${label}.status`),
    ...(value.currentGenerationId === undefined
      ? {}
      : {
          currentGenerationId: boundedString(
            value.currentGenerationId,
            `${label}.currentGenerationId`,
            128,
          ),
        }),
    tools: toolNames(value.tools, `${label}.tools`),
    createdAt: timestamp(value.createdAt, `${label}.createdAt`),
  };
}

export function decodeAppletGenerationSummaryV1(
  input: unknown,
  label = "Applet generation summary",
): AppletGenerationSummaryV1 {
  const value = record(input, label);
  exactKeys(
    value,
    ["generationId", "origin", "status", "tools", "createdAt", "isCurrent"],
    ["parentGenerationId"],
    label,
  );
  if (typeof value.isCurrent !== "boolean")
    throw new Error(`${label}.isCurrent must be a boolean`);
  return {
    generationId: boundedString(
      value.generationId,
      `${label}.generationId`,
      128,
    ),
    ...(value.parentGenerationId === undefined
      ? {}
      : {
          parentGenerationId: boundedString(
            value.parentGenerationId,
            `${label}.parentGenerationId`,
            128,
          ),
        }),
    origin: origin(value.origin, `${label}.origin`),
    status: generationStatus(value.status, `${label}.status`),
    tools: toolNames(value.tools, `${label}.tools`),
    createdAt: timestamp(value.createdAt, `${label}.createdAt`),
    isCurrent: value.isCurrent,
  };
}

export function decodeAppletPublishResultV1(
  input: unknown,
  label = "Applet publish result",
): AppletPublishResultV1 {
  const value = record(input, label);
  if (value.status === "published") {
    exactKeys(
      value,
      ["status", "appletId", "generationId", "tools"],
      ["compositionGenerationId"],
      label,
    );
    return {
      status: "published",
      appletId: appletId(value.appletId, `${label}.appletId`),
      generationId: boundedString(
        value.generationId,
        `${label}.generationId`,
        128,
      ),
      tools: toolNames(value.tools, `${label}.tools`),
      ...(value.compositionGenerationId === undefined
        ? {}
        : {
            compositionGenerationId: boundedString(
              value.compositionGenerationId,
              `${label}.compositionGenerationId`,
              128,
            ),
          }),
    };
  }
  if (value.status === "failed") {
    exactKeys(
      value,
      ["status", "appletId", "generationId", "reason", "diagnostics"],
      [],
      label,
    );
    if (!Array.isArray(value.diagnostics) || value.diagnostics.length > 64)
      throw new Error(`${label}.diagnostics must be a bounded array`);
    return {
      status: "failed",
      appletId: appletId(value.appletId, `${label}.appletId`),
      generationId: boundedString(
        value.generationId,
        `${label}.generationId`,
        128,
      ),
      reason: boundedString(value.reason, `${label}.reason`, 512),
      diagnostics: value.diagnostics.map((entry, index) =>
        boundedString(entry, `${label}.diagnostics[${index}]`, 8_192),
      ),
    };
  }
  throw new Error(`${label}.status is invalid`);
}

export function decodeAppletListViewV1(
  input: unknown,
  label = "Applet list",
): AppletListViewV1 {
  const value = record(input, label);
  exactKeys(value, ["schemaVersion", "applets"], [], label);
  if (value.schemaVersion !== 1)
    throw new Error(`${label} version is unsupported`);
  if (!Array.isArray(value.applets) || value.applets.length > 256)
    throw new Error(`${label}.applets must be a bounded array`);
  const applets = value.applets.map((candidate, index) =>
    decodeAppletSummaryV1(candidate, `${label}.applets[${index}]`),
  );
  if (new Set(applets.map((applet) => applet.appletId)).size !== applets.length)
    throw new Error(`${label}.applets contains duplicate Applets`);
  return { schemaVersion: 1, applets };
}

export function decodeAppletUiViewV1(
  input: unknown,
  label = "Applet UI",
): AppletUiViewV1 {
  const value = record(input, label);
  exactKeys(value, ["uiUrl"], ["generationId"], label);
  const uiUrl = boundedString(value.uiUrl, `${label}.uiUrl`, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(uiUrl);
  } catch {
    throw new Error(`${label}.uiUrl is invalid`);
  }
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new Error(`${label}.uiUrl is invalid`);
  return {
    uiUrl,
    ...(value.generationId === undefined
      ? {}
      : {
          generationId: boundedString(
            value.generationId,
            `${label}.generationId`,
            128,
          ),
        }),
  };
}

/** The focus read and write share one shape, so a write reads back exactly. */
export function decodeAppletFocusViewV1(
  input: unknown,
  label = "Applet focus",
): AppletFocusViewV1 {
  const value = record(input, label);
  exactKeys(value, ["appletId"], ["schemaVersion"], label);
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1)
    throw new Error(`${label} version is unsupported`);
  return {
    appletId:
      value.appletId === null
        ? null
        : appletId(value.appletId, `${label}.appletId`),
  };
}

/**
 * The Applet's source as the canvas reads it. Text only and bounded: this is a
 * projection for a person watching a Bot write code, never a file transfer.
 */
export function decodeAppletSourceViewV1(
  input: unknown,
  label = "Applet source",
): AppletSourceViewV1 {
  const value = record(input, label);
  exactKeys(value, ["appletId", "files", "truncated"], [], label);
  if (typeof value.truncated !== "boolean")
    throw new Error(`${label}.truncated must be a boolean`);
  if (
    !Array.isArray(value.files) ||
    value.files.length > APPLET_SOURCE_MAX_FILES_V1
  ) {
    throw new Error(`${label}.files must be a bounded array`);
  }
  let bytes = 0;
  const files = value.files.map((candidate, index) => {
    const fileLabel = `${label}.files[${index}]`;
    const file = record(candidate, fileLabel);
    exactKeys(file, ["path", "text", "generationId"], ["changedAt"], fileLabel);
    const path = boundedString(file.path, `${fileLabel}.path`, 512);
    if (path.startsWith("/") || path.includes("..") || path.includes("\\"))
      throw new Error(`${fileLabel}.path is invalid`);
    if (typeof file.text !== "string")
      throw new Error(`${fileLabel}.text must be a string`);
    bytes += file.text.length;
    if (bytes > APPLET_SOURCE_MAX_BYTES_V1)
      throw new Error(`${label} exceeds the source read limit`);
    return {
      path,
      text: file.text,
      generationId: boundedString(
        file.generationId,
        `${fileLabel}.generationId`,
        128,
      ),
      ...(file.changedAt === undefined
        ? {}
        : { changedAt: timestamp(file.changedAt, `${fileLabel}.changedAt`) }),
    };
  });
  if (new Set(files.map((file) => file.path)).size !== files.length)
    throw new Error(`${label}.files contains duplicate paths`);
  return {
    appletId: appletId(value.appletId, `${label}.appletId`),
    files,
    truncated: value.truncated,
  };
}

export function decodeAppletBuildViewV1(
  input: unknown,
  label = "Applet build",
): AppletBuildViewV1 {
  const value = record(input, label);
  exactKeys(
    value,
    ["status"],
    ["command", "at", "summary", "diagnostics"],
    label,
  );
  if (
    value.status !== "unknown" &&
    value.status !== "passed" &&
    value.status !== "failed"
  ) {
    throw new Error(`${label}.status is invalid`);
  }
  if (
    value.command !== undefined &&
    value.command !== "check" &&
    value.command !== "build"
  ) {
    throw new Error(`${label}.command is invalid`);
  }
  if (
    value.diagnostics !== undefined &&
    (!Array.isArray(value.diagnostics) ||
      value.diagnostics.length > APPLET_SOURCE_MAX_DIAGNOSTICS_V1)
  ) {
    throw new Error(`${label}.diagnostics must be a bounded array`);
  }
  return {
    status: value.status,
    ...(value.command === undefined
      ? {}
      : { command: value.command as "check" | "build" }),
    ...(value.at === undefined
      ? {}
      : { at: timestamp(value.at, `${label}.at`) }),
    ...(value.summary === undefined
      ? {}
      : { summary: boundedString(value.summary, `${label}.summary`, 512) }),
    ...(value.diagnostics === undefined
      ? {}
      : {
          diagnostics: (value.diagnostics as unknown[]).map((line, index) =>
            boundedString(line, `${label}.diagnostics[${index}]`, 1_024),
          ),
        }),
  };
}

export function decodeAppletViewerTokenV1(
  input: unknown,
  label = "Applet viewer token",
): AppletViewerTokenV1 {
  const value = record(input, label);
  exactKeys(value, ["token", "expiresAt", "socketUrl"], [], label);
  const socketUrl = boundedString(value.socketUrl, `${label}.socketUrl`, 2_048);
  const url = new URL(socketUrl);
  if (!["ws:", "wss:", "http:", "https:"].includes(url.protocol))
    throw new Error(`${label}.socketUrl is invalid`);
  return {
    token: boundedString(value.token, `${label}.token`, 1_024),
    expiresAt: timestamp(value.expiresAt, `${label}.expiresAt`),
    socketUrl,
  };
}
