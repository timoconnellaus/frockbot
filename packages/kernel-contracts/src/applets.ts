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

type AppletJsonScalarV1 = null | boolean | number | string;
type AppletJsonDepth1V1 =
  | AppletJsonScalarV1
  | AppletJsonScalarV1[]
  | { [key: string]: AppletJsonScalarV1 };
type AppletJsonDepth2V1 =
  | AppletJsonScalarV1
  | AppletJsonDepth1V1[]
  | { [key: string]: AppletJsonDepth1V1 };
type AppletJsonDepth3V1 =
  | AppletJsonScalarV1
  | AppletJsonDepth2V1[]
  | { [key: string]: AppletJsonDepth2V1 };
/**
 * Plain JSON, spelled out and bounded rather than recursive.
 *
 * These records cross a Durable Object RPC boundary, where `unknown` is not
 * transferable — a record typed with it collapses the whole answer to `never`
 * at the call site — and a self-referential type makes the serializability
 * mapper give up instead. A tool's input schema is four levels at the outside.
 */
export type AppletJsonValueV1 =
  | AppletJsonScalarV1
  | AppletJsonDepth3V1[]
  | { [key: string]: AppletJsonDepth3V1 };

/** The tool declaration an Applet generation copies from its manifest. */
export interface AppletToolDeclarationV1 {
  name: string;
  description: string;
  inputSchema: { [key: string]: AppletJsonValueV1 };
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
    // The round trip is the narrowing: `json` above proved every leaf is a
    // JSON scalar, array, or object, which is exactly `AppletJsonValueV1`.
    inputSchema: JSON.parse(JSON.stringify(inputSchema)) as {
      [key: string]: AppletJsonValueV1;
    },
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

/**
 * Who created an Applet. A Bot-created one names the Bot, Session, and Turn,
 * because a Bot-authored change is a durable effect whose provenance names all
 * three; a User-created one names nothing more, because the User Durable Object
 * already is the User.
 */
export function decodeAppletProvenanceV1(
  input: unknown,
  label = "Applet provenance",
): AppletProvenanceV1 {
  const provenance = record(input, label);
  if (provenance.kind === "user") {
    exactKeys(provenance, ["kind"], [], label);
    return { kind: "user" };
  }
  if (provenance.kind === "bot") {
    exactKeys(provenance, ["kind", "botId", "sessionId", "turnId"], [], label);
    return {
      kind: "bot",
      botId: boundedString(provenance.botId, `${label}.botId`, 256),
      sessionId: boundedString(provenance.sessionId, `${label}.sessionId`, 257),
      turnId: boundedString(provenance.turnId, `${label}.turnId`, 256),
    };
  }
  throw new Error(`${label}.kind is invalid`);
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
