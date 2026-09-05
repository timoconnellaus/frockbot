import {
  isBotIsolateHookEventNameV1,
  decodeTurnTypeV1,
  iframePageSlotAllowedV1,
  PACKAGE_IFRAME_ENTRY_LABEL_MAX_V1,
  PACKAGE_IFRAME_ENTRY_SLOT_V1,
  PACKAGE_IFRAME_ID_V1,
  PACKAGE_IFRAME_MAX_ENTRIES_V1,
  PACKAGE_IFRAME_MAX_PAGES_V1,
  type BotIsolateHookEventNameV1,
  type TurnTypeV1,
} from "@frockbot/kernel-contracts";
import type { ArtifactRefV1 } from "./generation.ts";

/** The Contribution kinds a Package manifest can declare. */
export type ManifestContributionKind =
  "backend" | "runtime" | "client" | "desktop" | "mobile";

/**
 * Every execution host a Contribution can be mounted in. A Bot-authored
 * manifest declares `bot-isolate`, but provenance and an immutable artifact
 * still decide whether the host accepts it; a manifest never grants itself
 * that execution authority.
 */
export type ContributionKind = ManifestContributionKind | "bot-isolate";

export interface BackendContribution {
  entry: string;
  host: "gateway" | "bot" | "user";
}

export interface RuntimeContribution {
  entry: string;
  /** Present only on a Bot-authored manifest; provenance still decides host authority. */
  host?: "bot-isolate";
}

/** A Bot-authored manifest's durable declaration; isolate health supplies details at mount. */
export interface ManifestToolDeclaration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ClientMount {
  slot: string;
  order?: number;
}

/** A reviewed first-party client module compiled into the hosted bundle. */
export interface ClientModuleContribution {
  entry: string;
  mounts: ClientMount[];
  outlets: string[];
}

/** Immutable HTML bytes rendered only by the first-party sandbox host. */
export interface ClientIframeArtifactV1 {
  contentHash: string;
  size: number;
  mediaType: "text/html";
  bundlerVersion: string;
}

/** One non-first-party page. It never becomes JavaScript in the app origin. */
export interface ClientIframePageV1 {
  /** `/^[a-z][a-z0-9-]{0,31}$/`, unique within the Contribution. */
  id: string;
  artifact: ClientIframeArtifactV1;
  mounts: ClientMount[];
}

/**
 * Manifest v5. A declarative launcher for one of the Package's pages. The
 * shell renders it; the Package never scripts the app origin to place it.
 */
export interface ClientEntryV1 {
  id: string;
  slot: "frockbot.sidebar-actions";
  order?: number;
  /** At most 32 characters. */
  label: string;
  /** A `UiIcon` name. */
  icon: string;
  opens: { kind: "surface"; page: string };
}

/**
 * Manifest v5. The multi-page iframe client. A v3/v4 record carrying one
 * top-level `artifact` and `mounts` is migrated to `pages: [{ id: "main" }]`
 * at the decoder; there is one in-memory shape, never two.
 */
export interface ClientIframeContribution {
  kind: "iframe";
  /** 1..8 pages. */
  pages: ClientIframePageV1[];
  /** 0..4 entries. */
  entries?: ClientEntryV1[];
}

/**
 * Manifest v5. What a Package contributes as one durable instance per User —
 * an Applet. The kernel mounts `server` as a facet under its own Applet
 * Durable Object; `tools` is what that instance offers the User's Bots.
 */
export interface InstanceContributionV1 {
  contract: 1;
  server: ArtifactRefV1;
  ui: ClientIframeArtifactV1;
  tools: ManifestToolDeclaration[];
}

export type ClientContribution =
  ClientModuleContribution | ClientIframeContribution;

export function isClientIframeContribution(
  contribution: ClientContribution,
): contribution is ClientIframeContribution {
  return "kind" in contribution && contribution.kind === "iframe";
}

export interface DesktopContribution {
  entry: string;
  execution: "sandboxed-renderer" | "trusted-main";
  commands: string[];
}

export interface MobileContribution {
  entry: string;
}

/**
 * Where one setting's value lives. `connection` is manifest v4: a setting a
 * Connection Type declares, whose value belongs to one Connection.
 */
export type SettingScope = "user" | "bot" | "connection";

export type PackageSettingSchemaType =
  "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

export type PackageSettingSchemaValue = string | number | boolean | null;

export interface PackageSettingSchema {
  type?: PackageSettingSchemaType;
  title?: string;
  description?: string;
  enum?: PackageSettingSchemaValue[];
  const?: PackageSettingSchemaValue;
  properties?: Record<string, PackageSettingSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: PackageSettingSchema;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minProperties?: number;
  maxProperties?: number;
}

export interface PackageSettingDefinition {
  id: string;
  schemaVersion: number;
  scopes: SettingScope[];
  /**
   * A kernel-consumed semantic role. The model role is deliberately generic:
   * ADR 0019 lets a Package opt the User into model choice without teaching
   * the kernel that Package's identity or policy.
   */
  role?: "model";
  schema: PackageSettingSchema;
}

export interface ConnectionTypeDefinition {
  /** A same-origin backend catalog of named variants of this Connection Type. */
  catalogPath?: string;
  id: string;
  displayName: string;
  allowMultiple: boolean;
  authorization: {
    kind: "none" | "api-key" | "ambient-native" | "grant";
    /** Ambient native bindings have no credential or authorization driver. */
    driverId?: string;
  };
  capabilities: string[];
  /**
   * Manifest v4. Connection-scoped settings: the configuration one Connection
   * of this type carries beside its credential — an MCP server's URL and
   * transport, say. They are declared here rather than under `settings`
   * because their scope is a Connection, not the User or the Bot, and they are
   * configuration only: a secret reaches the keyring through the Connection's
   * credential and never through a setting.
   */
  settings?: PackageSettingDefinition[];
}

export interface CapabilityDefinition {
  id: string;
  kind: "tool" | "model" | "memory" | "notification" | "computer";
  connectionTypes: string[];
  /**
   * Manifest v4. The durable ceiling on the turn types this Capability's
   * tools may be admitted onto: a Contribution cannot offer a tool on a turn
   * type its manifest does not list. Absent means the manifest set no bound.
   */
  admission?: { turnTypes: TurnTypeV1[]; subagentRoles?: string[] };
}

/**
 * One durable Workspace root a Package declares for itself.
 *
 * "Durable roots, declared by the Computer Package's Workspace layout and by
 * Package manifests, survive hibernation, cold start, host migration, and
 * image rebuild." The Computer half of that sentence has always been real —
 * `FLY_WORKSPACE_LAYOUT` carries the `package-declared` mount template — but
 * the manifest half had nowhere to be written, so no Package-declared root
 * ever reached the durable-root sync. This is that half.
 *
 * `scope` is `user` and only `user`: `WorkspaceRootV1` names a
 * `package-declared` root by User and Package with no Bot in it, and Package
 * availability is a User-level fact (ADR 0019). A Bot-scoped Package root
 * would be a root the kernel's own root type cannot address.
 */
export interface ManifestDeclaredRootV1 {
  /** The `rootId`, in the kernel's `package-declared` root-id shape. */
  id: string;
  scope: "user";
}

export interface PackageConfiguration {
  settings: PackageSettingDefinition[];
  connectionTypes: ConnectionTypeDefinition[];
  capabilities: CapabilityDefinition[];
}

export interface FrockBotManifest {
  schemaVersion: 2 | 3 | 4 | 5;
  id: string;
  displayName: string;
  version: string;
  compatibility: { frockbot: string };
  dependencies: Record<string, string>;
  defaultEnablement?: "enabled" | "disabled";
  contributions: {
    backend?: BackendContribution[];
    runtime?: RuntimeContribution;
    client?: ClientContribution;
    desktop?: DesktopContribution;
    mobile?: MobileContribution;
    /** Manifest v5 only; refused below it. */
    instance?: InstanceContributionV1;
  };
  permissions: string[];
  configuration?: PackageConfiguration;
  /** Present exactly when `contributions.runtime.host` is `bot-isolate`. */
  tools?: ManifestToolDeclaration[];
  /** Bot-isolate waterfalls the immutable artifact declares it exports. */
  hooks?: BotIsolateHookEventNameV1[];
  /** The durable Workspace roots this Package declares. Manifest v3 onward. */
  roots?: ManifestDeclaredRootV1[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  boundary: string,
): void {
  const allowedFields = new Set(allowed);
  const unknown = Reflect.ownKeys(record).find(
    (key) => typeof key !== "string" || !allowedFields.has(key),
  );
  if (unknown !== undefined) {
    throw new Error(`${boundary} has unknown field "${String(unknown)}"`);
  }
}

function validateManifestJson(value: unknown, label: string, depth = 0): void {
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
    for (const entry of value) validateManifestJson(entry, label, depth + 1);
    return;
  }
  if (!isRecord(value)) throw new Error(`${label} must contain only JSON`);
  for (const entry of Object.values(value)) {
    validateManifestJson(entry, label, depth + 1);
  }
}

function decodeManifestTools(
  value: unknown,
): ManifestToolDeclaration[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new Error("manifest tools must be a non-empty bounded array");
  }
  const tools = value.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new Error(`manifest tools[${index}] must be an object`);
    }
    exactFields(
      candidate,
      ["name", "description", "inputSchema"],
      `manifest tools[${index}]`,
    );
    const name = requiredString(candidate, "name");
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) {
      throw new Error(`manifest tools[${index}] name is invalid`);
    }
    const description = requiredString(candidate, "description");
    if (description.length > 1_024) {
      throw new Error(`manifest tools[${index}] description is too long`);
    }
    if (!isRecord(candidate.inputSchema)) {
      throw new Error(`manifest tools[${index}] inputSchema must be an object`);
    }
    validateManifestJson(
      candidate.inputSchema,
      `manifest tools[${index}] inputSchema`,
    );
    return {
      name,
      description,
      inputSchema: structuredClone(candidate.inputSchema),
    };
  });
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
    throw new Error("manifest tools contains duplicate names");
  }
  return tools;
}

function decodeManifestHooks(
  value: unknown,
): BotIsolateHookEventNameV1[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new Error("manifest hooks must be a non-empty bounded array");
  }
  const hooks = value.map((hook, index) => {
    if (!isBotIsolateHookEventNameV1(hook)) {
      throw new Error(`manifest hooks[${index}] is invalid`);
    }
    return hook;
  });
  if (new Set(hooks).size !== hooks.length) {
    throw new Error("manifest hooks contains duplicates");
  }
  return hooks;
}

/**
 * The `package-declared` root-id shape, kept identical to the kernel's own
 * `ROOT_ID` in `kernel-contracts/src/workspace.ts`.
 *
 * Restated rather than imported because `kernel-composition` decodes a
 * manifest without depending on the Workspace contracts; the round-trip test
 * beside this decoder is what keeps the two from drifting.
 */
const MANIFEST_ROOT_ID = /^[a-z][a-z0-9-]{0,127}$/;

function decodeManifestRoots(
  value: unknown,
): ManifestDeclaredRootV1[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw new Error("manifest roots must be a non-empty bounded array");
  }
  const roots = value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`manifest roots[${index}] must be an object`);
    }
    exactFields(entry, ["id", "scope"], `manifest roots[${index}]`);
    const id = requiredString(entry, "id");
    if (!MANIFEST_ROOT_ID.test(id)) {
      throw new Error(`manifest roots[${index}] id is invalid`);
    }
    // User and only User: a `package-declared` root names no Bot, so a
    // Bot-scoped one would be a root the kernel cannot address.
    if (entry.scope !== "user") {
      throw new Error(`manifest roots[${index}] scope must be "user"`);
    }
    return { id, scope: "user" as const };
  });
  if (new Set(roots.map((root) => root.id)).size !== roots.length) {
    throw new Error("manifest roots contains duplicate ids");
  }
  return roots;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`manifest field "${key}" must be a non-empty string`);
  }
  return value;
}

function optionalStringArray(
  record: Record<string, unknown>,
  key: string,
): string[] {
  const value = record[key] ?? [];
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.length > 0)
  ) {
    throw new Error(`manifest field "${key}" must contain non-empty strings`);
  }
  return [...value];
}

function relativeEntry(record: Record<string, unknown>, key: string): string {
  const value = requiredString(record, key);
  if (!value.startsWith("./")) {
    throw new Error(
      `manifest contribution "${key}" must be a relative export path`,
    );
  }
  return value;
}

function optionalLegacyEntry(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.startsWith("./")) {
    throw new Error(
      `manifest contribution "${key}" must be a relative export path`,
    );
  }
  return value;
}

function decodeDependencies(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value))
    throw new Error("manifest dependencies must be an object");
  const dependencies: Record<string, string> = {};
  for (const [id, range] of Object.entries(value).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!/^[a-z][a-z0-9-]*$/.test(id) || typeof range !== "string" || !range) {
      throw new Error("manifest dependencies must map package ids to versions");
    }
    dependencies[id] = range;
  }
  return dependencies;
}

function decodeDefaultEnablement(
  value: unknown,
): FrockBotManifest["defaultEnablement"] {
  if (value === undefined) return undefined;
  if (value !== "enabled" && value !== "disabled") {
    throw new Error(
      'manifest defaultEnablement must be "enabled" or "disabled"',
    );
  }
  return value;
}

function decodeIdentity(
  value: Record<string, unknown>,
): Pick<FrockBotManifest, "id" | "displayName" | "version" | "permissions"> {
  const id = requiredString(value, "id");
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error("manifest id must be lowercase kebab-case");
  }
  return {
    id,
    displayName: requiredString(value, "displayName"),
    version: requiredString(value, "version"),
    permissions: optionalStringArray(value, "permissions"),
  };
}

function decodeV1(value: Record<string, unknown>): FrockBotManifest {
  const identity = decodeIdentity(value);
  if (!isRecord(value.contributions)) {
    throw new Error("manifest contributions must be an object");
  }
  exactFields(
    value.contributions,
    ["agent", "web", "desktop", "mobile"],
    "manifest contributions",
  );
  const agent = optionalLegacyEntry(value.contributions, "agent");
  if (value.contributions.desktop !== undefined) {
    throw new Error("manifest v1 desktop Contributions are unsupported");
  }
  const mobile = optionalLegacyEntry(value.contributions, "mobile");
  let client: ClientContribution | undefined;
  if (value.contributions.web !== undefined) {
    const web = value.contributions.web;
    if (!isRecord(web))
      throw new Error("manifest web contribution must be an object");
    exactFields(
      web,
      ["entry", "manifest", "slots"],
      "manifest legacy web contribution",
    );
    optionalLegacyEntry(web, "manifest");
    const slots = optionalStringArray(web, "slots");
    client = {
      entry: relativeEntry(web, "entry"),
      mounts: slots.map((slot) => ({ slot })),
      outlets: [],
    };
  }
  const contributions: FrockBotManifest["contributions"] = {
    runtime: agent ? { entry: agent } : undefined,
    client,
    mobile: mobile ? { entry: mobile } : undefined,
  };
  if (
    !contributions.backend &&
    !contributions.runtime &&
    !contributions.client &&
    !contributions.desktop &&
    !contributions.mobile
  ) {
    throw new Error("manifest has no contributions");
  }
  return {
    schemaVersion: 2,
    ...identity,
    compatibility: { frockbot: "*" },
    dependencies: {},
    contributions,
  };
}

/**
 * Manifest v4 extends v3, so every v3 rule applies unchanged to a v4 body.
 */
function isV3OrLater(value: Record<string, unknown>): boolean {
  return (
    value.schemaVersion === 3 ||
    value.schemaVersion === 4 ||
    value.schemaVersion === 5
  );
}

function isV5(value: Record<string, unknown>): boolean {
  return value.schemaVersion === 5;
}

function decodeClientMounts(value: unknown, label: string): ClientMount[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((mount) => {
    if (!isRecord(mount)) throw new Error(`${label} entry must be an object`);
    exactFields(mount, ["slot", "order"], label);
    const order = mount.order;
    if (
      order !== undefined &&
      (typeof order !== "number" || !Number.isFinite(order))
    ) {
      throw new Error(`${label} order must be finite`);
    }
    return {
      slot: requiredString(mount, "slot"),
      ...(order === undefined ? {} : { order }),
    };
  });
}

function decodeClientIframeArtifact(
  value: unknown,
  label: string,
): ClientIframeArtifactV1 {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  exactFields(
    value,
    ["contentHash", "size", "mediaType", "bundlerVersion"],
    label,
  );
  if (
    typeof value.contentHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.contentHash)
  ) {
    throw new Error(`${label} contentHash must be a sha-256 digest`);
  }
  if (
    !Number.isSafeInteger(value.size) ||
    (value.size as number) < 0 ||
    (value.size as number) > 256 * 1024
  ) {
    throw new Error(`${label} size must be within the 256 KB quota`);
  }
  if (value.mediaType !== "text/html") {
    throw new Error(`${label} mediaType is invalid`);
  }
  return {
    contentHash: value.contentHash,
    size: value.size as number,
    mediaType: "text/html",
    bundlerVersion: requiredString(value, "bundlerVersion"),
  };
}

function decodeInstanceContribution(value: unknown): InstanceContributionV1 {
  if (!isRecord(value)) {
    throw new Error("manifest instance Contribution must be an object");
  }
  exactFields(
    value,
    ["contract", "server", "ui", "tools"],
    "manifest instance Contribution",
  );
  if (value.contract !== 1) {
    throw new Error("manifest instance Contribution contract is unsupported");
  }
  if (!isRecord(value.server)) {
    throw new Error("manifest instance Contribution server must be an object");
  }
  exactFields(
    value.server,
    ["contentHash", "size", "mediaType", "bundlerVersion"],
    "manifest instance Contribution server",
  );
  const server = value.server;
  if (
    typeof server.contentHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(server.contentHash)
  ) {
    throw new Error(
      "manifest instance Contribution server contentHash must be a sha-256 digest",
    );
  }
  if (!Number.isSafeInteger(server.size) || (server.size as number) < 0) {
    throw new Error(
      "manifest instance Contribution server size must be a non-negative integer",
    );
  }
  if (server.mediaType !== "application/javascript") {
    throw new Error(
      "manifest instance Contribution server mediaType is invalid",
    );
  }
  const tools = decodeManifestTools(value.tools);
  if (!tools) {
    throw new Error(
      "manifest instance Contribution must declare its instance tools",
    );
  }
  return {
    contract: 1,
    server: {
      contentHash: server.contentHash,
      size: server.size as number,
      mediaType: "application/javascript",
      bundlerVersion: requiredString(server, "bundlerVersion"),
    },
    ui: decodeClientIframeArtifact(
      value.ui,
      "manifest instance Contribution ui",
    ),
    tools,
  };
}

function decodeClientEntries(value: unknown): ClientEntryV1[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > PACKAGE_IFRAME_MAX_ENTRIES_V1) {
    throw new Error("manifest iframe client entries must be a bounded array");
  }
  const entries = value.map((candidate, index) => {
    const label = `manifest iframe client entries[${index}]`;
    if (!isRecord(candidate)) throw new Error(`${label} must be an object`);
    exactFields(
      candidate,
      ["id", "slot", "order", "label", "icon", "opens"],
      label,
    );
    const id = requiredString(candidate, "id");
    if (!PACKAGE_IFRAME_ID_V1.test(id)) {
      throw new Error(`${label} id is invalid`);
    }
    if (candidate.slot !== PACKAGE_IFRAME_ENTRY_SLOT_V1) {
      throw new Error(`${label} slot is invalid`);
    }
    const order = candidate.order;
    if (
      order !== undefined &&
      (typeof order !== "number" || !Number.isFinite(order))
    ) {
      throw new Error(`${label} order must be finite`);
    }
    const entryLabel = requiredString(candidate, "label");
    if (entryLabel.length > PACKAGE_IFRAME_ENTRY_LABEL_MAX_V1) {
      throw new Error(`${label} label is too long`);
    }
    const icon = requiredString(candidate, "icon");
    if (icon.length > 64) throw new Error(`${label} icon is too long`);
    if (!isRecord(candidate.opens)) {
      throw new Error(`${label} opens must be an object`);
    }
    exactFields(candidate.opens, ["kind", "page"], `${label} opens`);
    if (candidate.opens.kind !== "surface") {
      throw new Error(`${label} opens.kind is invalid`);
    }
    return {
      id,
      slot: PACKAGE_IFRAME_ENTRY_SLOT_V1 as "frockbot.sidebar-actions",
      ...(order === undefined ? {} : { order }),
      label: entryLabel,
      icon,
      opens: {
        kind: "surface" as const,
        page: requiredString(candidate.opens, "page"),
      },
    };
  });
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    throw new Error("manifest iframe client entries contain duplicate ids");
  }
  return entries;
}

function decodeV2(value: Record<string, unknown>): FrockBotManifest {
  const identity = decodeIdentity(value);
  const defaultEnablement = decodeDefaultEnablement(value.defaultEnablement);
  if (!isRecord(value.compatibility)) {
    throw new Error("manifest compatibility must be an object");
  }
  exactFields(value.compatibility, ["frockbot"], "manifest compatibility");
  if (!isRecord(value.contributions)) {
    throw new Error("manifest contributions must be an object");
  }
  exactFields(
    value.contributions,
    isV3OrLater(value)
      ? ["backend", "runtime", "client", "desktop", "mobile", "instance"]
      : ["runtime", "client", "desktop", "mobile"],
    "manifest contributions",
  );
  const contributions: FrockBotManifest["contributions"] = {};
  if (isV3OrLater(value) && value.contributions.backend !== undefined) {
    const backend = Array.isArray(value.contributions.backend)
      ? value.contributions.backend
      : [value.contributions.backend];
    if (backend.length === 0 || !backend.every(isRecord)) {
      throw new Error("manifest backend contributions must contain objects");
    }
    contributions.backend = backend.map((contribution) => {
      exactFields(
        contribution,
        ["entry", "host"],
        "manifest backend contribution",
      );
      if (
        contribution.host !== "gateway" &&
        contribution.host !== "bot" &&
        contribution.host !== "user"
      ) {
        throw new Error("manifest backend host is invalid");
      }
      return {
        entry: relativeEntry(contribution, "entry"),
        host: contribution.host,
      };
    });
  }
  if (value.contributions.runtime !== undefined) {
    if (!isRecord(value.contributions.runtime)) {
      throw new Error("manifest runtime contribution must be an object");
    }
    exactFields(
      value.contributions.runtime,
      ["entry", ...(isV3OrLater(value) ? ["host"] : [])],
      "manifest runtime contribution",
    );
    const host = value.contributions.runtime.host;
    if (host !== undefined && host !== "bot-isolate") {
      throw new Error("manifest runtime host is invalid");
    }
    contributions.runtime = {
      entry: relativeEntry(value.contributions.runtime, "entry"),
      ...(host === "bot-isolate" ? { host } : {}),
    };
  }
  if (value.contributions.client !== undefined) {
    const client = value.contributions.client;
    if (!isRecord(client))
      throw new Error("manifest client contribution must be an object");
    if (client.kind === "iframe") {
      if (!isV3OrLater(value)) {
        throw new Error("manifest iframe client requires schema version 3");
      }
      if (isV5(value)) {
        exactFields(
          client,
          ["kind", "pages", "entries"],
          "manifest iframe client contribution",
        );
        if (
          !Array.isArray(client.pages) ||
          client.pages.length === 0 ||
          client.pages.length > PACKAGE_IFRAME_MAX_PAGES_V1
        ) {
          throw new Error(
            "manifest iframe client pages must be a non-empty bounded array",
          );
        }
        const pages = client.pages.map((candidate, index) => {
          const label = `manifest iframe client pages[${index}]`;
          if (!isRecord(candidate))
            throw new Error(`${label} must be an object`);
          exactFields(candidate, ["id", "artifact", "mounts"], label);
          const id = requiredString(candidate, "id");
          if (!PACKAGE_IFRAME_ID_V1.test(id)) {
            throw new Error(`${label} id is invalid`);
          }
          return {
            id,
            artifact: decodeClientIframeArtifact(
              candidate.artifact,
              `${label} artifact`,
            ),
            mounts: decodeClientMounts(candidate.mounts, `${label} mounts`),
          };
        });
        if (new Set(pages.map((page) => page.id)).size !== pages.length) {
          throw new Error("manifest iframe client pages contain duplicate ids");
        }
        const entries = decodeClientEntries(client.entries);
        contributions.client = {
          kind: "iframe",
          pages,
          ...(entries ? { entries } : {}),
        };
      } else {
        // Migration, not compatibility: the v3/v4 single-page record becomes
        // the one in-memory multi-page shape and is written back as v5.
        exactFields(
          client,
          ["kind", "artifact", "mounts"],
          "manifest iframe client contribution",
        );
        contributions.client = {
          kind: "iframe",
          pages: [
            {
              id: "main",
              artifact: decodeClientIframeArtifact(
                client.artifact,
                "manifest iframe client artifact",
              ),
              mounts: decodeClientMounts(
                client.mounts,
                "manifest client mount",
              ),
            },
          ],
        };
      }
    } else {
      exactFields(
        client,
        ["entry", "mounts", "outlets"],
        "manifest client contribution",
      );
      contributions.client = {
        entry: relativeEntry(client, "entry"),
        mounts: decodeClientMounts(client.mounts, "manifest client mount"),
        outlets: optionalStringArray(client, "outlets"),
      };
    }
  }
  if (value.contributions.mobile !== undefined) {
    const mobile = value.contributions.mobile;
    if (!isRecord(mobile)) {
      throw new Error("manifest mobile contribution must be an object");
    }
    exactFields(mobile, ["entry"], "manifest mobile contribution");
    contributions.mobile = { entry: relativeEntry(mobile, "entry") };
  }
  if (value.contributions.desktop !== undefined) {
    const desktop = value.contributions.desktop;
    if (!isRecord(desktop)) {
      throw new Error("manifest desktop contribution must be an object");
    }
    exactFields(
      desktop,
      ["entry", "execution", "commands"],
      "manifest desktop contribution",
    );
    const execution = desktop.execution;
    if (
      execution !== "sandboxed-renderer" &&
      (!isV3OrLater(value) || execution !== "trusted-main")
    ) {
      throw new Error(
        isV3OrLater(value)
          ? 'manifest desktop execution must be "sandboxed-renderer" or "trusted-main"'
          : 'manifest v2 desktop execution must be "sandboxed-renderer"',
      );
    }
    contributions.desktop = {
      entry: relativeEntry(desktop, "entry"),
      execution,
      commands: optionalStringArray(desktop, "commands"),
    };
  }
  if (value.contributions.instance !== undefined) {
    if (!isV5(value)) {
      throw new Error(
        "manifest instance Contribution requires schema version 5",
      );
    }
    contributions.instance = decodeInstanceContribution(
      value.contributions.instance,
    );
  }
  if (
    !contributions.backend &&
    !contributions.runtime &&
    !contributions.client &&
    !contributions.desktop &&
    !contributions.mobile &&
    !contributions.instance
  ) {
    throw new Error("manifest has no contributions");
  }
  return {
    schemaVersion: 2,
    ...identity,
    compatibility: {
      frockbot: requiredString(value.compatibility, "frockbot"),
    },
    dependencies: decodeDependencies(value.dependencies),
    ...(defaultEnablement ? { defaultEnablement } : {}),
    contributions,
  };
}

function definitionArray(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown>[] {
  const candidate = value[key] ?? [];
  if (!Array.isArray(candidate) || !candidate.every(isRecord)) {
    throw new Error(`manifest configuration "${key}" must be an array`);
  }
  return candidate;
}

function definitionId(value: Record<string, unknown>): string {
  const id = requiredString(value, "id");
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error("manifest configuration id must be lowercase kebab-case");
  }
  return id;
}

const PACKAGE_SETTING_SCHEMA_TYPES = new Set<PackageSettingSchemaType>([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

const PACKAGE_SETTING_SCHEMA_KEYWORDS = new Set([
  "type",
  "title",
  "description",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);

function schemaKeywordError(keyword: string, message: string): Error {
  return new Error(`manifest setting schema "${keyword}" ${message}`);
}

function invalidSchemaJson(message: string): never {
  throw new Error(`manifest setting schema ${message}`);
}

function validateSchemaJsonValue(value: unknown, ancestors: Set<object>): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      invalidSchemaJson("numbers must be finite");
    }
    return;
  }
  if (typeof value !== "object") {
    invalidSchemaJson("must contain only JSON values");
  }
  if (ancestors.has(value)) {
    invalidSchemaJson("must be acyclic");
  }
  ancestors.add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      invalidSchemaJson("arrays must not inherit custom entries");
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.some(
        (key) =>
          typeof key !== "string" ||
          (key !== "length" &&
            (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)),
      )
    ) {
      invalidSchemaJson("arrays must contain only indexed entries");
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        invalidSchemaJson("arrays must be dense");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        invalidSchemaJson("arrays must contain plain JSON entries");
      }
      validateSchemaJsonValue(descriptor.value, ancestors);
    }
    for (const key in value) {
      if (!Object.hasOwn(value, key)) {
        invalidSchemaJson("arrays must not inherit entries");
      }
    }
    ancestors.delete(value);
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalidSchemaJson("objects must not inherit custom entries");
  }
  for (const key in value) {
    if (!Object.hasOwn(value, key)) {
      invalidSchemaJson("objects must not inherit entries");
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      invalidSchemaJson("objects must use string keys");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      invalidSchemaJson("objects must contain plain JSON entries");
    }
    validateSchemaJsonValue(descriptor.value, ancestors);
  }
  ancestors.delete(value);
}

function schemaString(
  value: Record<string, unknown>,
  keyword: "title" | "description",
): string | undefined {
  const candidate = value[keyword];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string") {
    throw schemaKeywordError(keyword, "must be a string");
  }
  return candidate;
}

function schemaNonNegativeInteger(
  value: Record<string, unknown>,
  keyword:
    | "minLength"
    | "maxLength"
    | "minItems"
    | "maxItems"
    | "minProperties"
    | "maxProperties",
): number | undefined {
  const candidate = value[keyword];
  if (candidate === undefined) return undefined;
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
    throw schemaKeywordError(keyword, "must be a non-negative integer");
  }
  return candidate as number;
}

function schemaFiniteNumber(
  value: Record<string, unknown>,
  keyword:
    | "minimum"
    | "maximum"
    | "exclusiveMinimum"
    | "exclusiveMaximum"
    | "multipleOf",
): number | undefined {
  const candidate = value[keyword];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    throw schemaKeywordError(keyword, "must be a finite number");
  }
  if (keyword === "multipleOf" && candidate <= 0) {
    throw schemaKeywordError(keyword, "must be greater than zero");
  }
  return candidate;
}

function schemaValue(
  value: unknown,
  keyword: "enum" | "const",
): PackageSettingSchemaValue {
  if (
    value !== null &&
    typeof value !== "string" &&
    typeof value !== "boolean" &&
    (typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw schemaKeywordError(keyword, "must contain only primitive values");
  }
  return value as PackageSettingSchemaValue;
}

function schemaValueMatchesType(
  value: PackageSettingSchemaValue,
  type: PackageSettingSchemaType,
): boolean {
  if (type === "null") return value === null;
  if (type === "integer") return Number.isSafeInteger(value);
  if (type === "number") return typeof value === "number";
  if (type === "object" || type === "array") return false;
  return typeof value === type;
}

function decodeSafeSchema(value: unknown, depth: number): PackageSettingSchema {
  if (!isRecord(value)) {
    throw new Error("manifest setting schema must be an object");
  }
  if (depth > 12) {
    throw new Error("manifest setting schema is too deeply nested");
  }
  const source = Object.fromEntries(Object.entries(value));
  for (const keyword of Object.keys(source)) {
    if (keyword === "default") {
      throw schemaKeywordError(keyword, "is not supported");
    }
    if (keyword === "format") {
      throw schemaKeywordError(keyword, "is not supported");
    }
    if (keyword.startsWith("$")) {
      throw schemaKeywordError(keyword, "is not supported");
    }
    if (!PACKAGE_SETTING_SCHEMA_KEYWORDS.has(keyword)) {
      throw schemaKeywordError(keyword, "is not supported");
    }
  }

  const schema: PackageSettingSchema = {};
  const rawType = source.type;
  if (rawType !== undefined) {
    if (
      typeof rawType !== "string" ||
      !PACKAGE_SETTING_SCHEMA_TYPES.has(rawType as PackageSettingSchemaType)
    ) {
      throw schemaKeywordError("type", "is unsupported");
    }
    schema.type = rawType as PackageSettingSchemaType;
  }
  const title = schemaString(source, "title");
  if (title !== undefined) schema.title = title;
  const description = schemaString(source, "description");
  if (description !== undefined) schema.description = description;

  if (source.enum !== undefined) {
    if (!Array.isArray(source.enum) || source.enum.length === 0) {
      throw schemaKeywordError("enum", "must be a non-empty array");
    }
    schema.enum = source.enum.map((candidate) =>
      schemaValue(candidate, "enum"),
    );
    if (
      new Set(schema.enum.map((candidate) => JSON.stringify(candidate)))
        .size !== schema.enum.length
    ) {
      throw schemaKeywordError("enum", "must contain unique values");
    }
  }
  if (Object.hasOwn(source, "const")) {
    schema.const = schemaValue(source.const, "const");
  }
  if (
    schema.type &&
    schema.enum?.some((item) => !schemaValueMatchesType(item, schema.type!))
  ) {
    throw schemaKeywordError("enum", "values must match type");
  }
  if (
    schema.type &&
    Object.hasOwn(schema, "const") &&
    !schemaValueMatchesType(schema.const!, schema.type)
  ) {
    throw schemaKeywordError("const", "must match type");
  }

  if (source.properties !== undefined) {
    if (!isRecord(source.properties)) {
      throw schemaKeywordError("properties", "must be an object");
    }
    schema.properties = Object.fromEntries(
      Object.entries(source.properties).map(([name, nested]) => {
        if (!name) {
          throw schemaKeywordError(
            "properties",
            "must use non-empty property names",
          );
        }
        return [name, decodeSafeSchema(nested, depth + 1)];
      }),
    );
  }
  if (source.required !== undefined) {
    if (
      !Array.isArray(source.required) ||
      !source.required.every(
        (item) => typeof item === "string" && item.length > 0,
      )
    ) {
      throw schemaKeywordError(
        "required",
        "must contain non-empty property names",
      );
    }
    schema.required = [...source.required];
    if (new Set(schema.required).size !== schema.required.length) {
      throw schemaKeywordError("required", "must contain unique names");
    }
    if (
      !schema.properties ||
      schema.required.some((name) => !Object.hasOwn(schema.properties!, name))
    ) {
      throw schemaKeywordError("required", "must name declared properties");
    }
  }
  if (source.additionalProperties !== undefined) {
    if (typeof source.additionalProperties !== "boolean") {
      throw schemaKeywordError("additionalProperties", "must be a boolean");
    }
    schema.additionalProperties = source.additionalProperties;
  }
  if (source.items !== undefined) {
    schema.items = decodeSafeSchema(source.items, depth + 1);
  }

  for (const keyword of [
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "minProperties",
    "maxProperties",
  ] as const) {
    const candidate = schemaNonNegativeInteger(source, keyword);
    if (candidate !== undefined) schema[keyword] = candidate;
  }
  for (const keyword of [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
  ] as const) {
    const candidate = schemaFiniteNumber(source, keyword);
    if (candidate !== undefined) schema[keyword] = candidate;
  }
  if (source.uniqueItems !== undefined) {
    if (typeof source.uniqueItems !== "boolean") {
      throw schemaKeywordError("uniqueItems", "must be a boolean");
    }
    schema.uniqueItems = source.uniqueItems;
  }

  const objectKeywords = [
    schema.properties,
    schema.required,
    schema.additionalProperties,
    schema.minProperties,
    schema.maxProperties,
  ];
  const arrayKeywords = [
    schema.items,
    schema.minItems,
    schema.maxItems,
    schema.uniqueItems,
  ];
  const stringKeywords = [schema.minLength, schema.maxLength];
  const numberKeywords = [
    schema.minimum,
    schema.maximum,
    schema.exclusiveMinimum,
    schema.exclusiveMaximum,
    schema.multipleOf,
  ];
  if (
    objectKeywords.some((item) => item !== undefined) &&
    schema.type !== "object"
  ) {
    throw new Error(
      "manifest setting schema object keywords require object type",
    );
  }
  if (
    arrayKeywords.some((item) => item !== undefined) &&
    schema.type !== "array"
  ) {
    throw new Error(
      "manifest setting schema array keywords require array type",
    );
  }
  if (
    stringKeywords.some((item) => item !== undefined) &&
    schema.type !== "string"
  ) {
    throw new Error(
      "manifest setting schema string keywords require string type",
    );
  }
  if (
    numberKeywords.some((item) => item !== undefined) &&
    schema.type !== "number" &&
    schema.type !== "integer"
  ) {
    throw new Error(
      "manifest setting schema number keywords require numeric type",
    );
  }
  if (
    schema.minLength !== undefined &&
    schema.maxLength !== undefined &&
    schema.minLength > schema.maxLength
  ) {
    throw new Error("manifest setting schema minLength exceeds maxLength");
  }
  if (
    schema.minItems !== undefined &&
    schema.maxItems !== undefined &&
    schema.minItems > schema.maxItems
  ) {
    throw new Error("manifest setting schema minItems exceeds maxItems");
  }
  if (
    schema.minProperties !== undefined &&
    schema.maxProperties !== undefined &&
    schema.minProperties > schema.maxProperties
  ) {
    throw new Error(
      "manifest setting schema minProperties exceeds maxProperties",
    );
  }
  if (
    schema.minimum !== undefined &&
    schema.maximum !== undefined &&
    schema.minimum > schema.maximum
  ) {
    throw new Error("manifest setting schema minimum exceeds maximum");
  }
  return schema;
}

function safeSchema(value: unknown): PackageSettingSchema {
  if (!isRecord(value)) {
    throw new Error("manifest setting schema must be an object");
  }
  validateSchemaJsonValue(value, new Set());
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    invalidSchemaJson("must contain only JSON values");
  }
  if (serialized.length > 50_000) {
    throw new Error("manifest setting schema is too large");
  }
  return decodeSafeSchema(value, 0);
}

/**
 * The one object contract the kernel interprets from a setting value. Keeping
 * this exact prevents a Package from smuggling provider policy into the model
 * seam while still letting ordinary settings use the supported schema subset.
 */
function assertModelBindingSchema(schema: PackageSettingSchema): void {
  const fields = Reflect.ownKeys(schema);
  const properties = schema.properties;
  const required = schema.required;
  if (
    fields.length !== 4 ||
    !fields.every((field) =>
      ["type", "properties", "required", "additionalProperties"].includes(
        String(field),
      ),
    ) ||
    schema.type !== "object" ||
    schema.additionalProperties !== false ||
    !properties ||
    Reflect.ownKeys(properties).length !== 2 ||
    !Object.hasOwn(properties, "connectionId") ||
    !Object.hasOwn(properties, "providerModelId") ||
    Reflect.ownKeys(properties.connectionId ?? {}).length !== 1 ||
    properties.connectionId?.type !== "string" ||
    Reflect.ownKeys(properties.providerModelId ?? {}).length !== 1 ||
    properties.providerModelId?.type !== "string" ||
    !required ||
    required.length !== 2 ||
    new Set(required).size !== 2 ||
    !required.includes("connectionId") ||
    !required.includes("providerModelId")
  ) {
    throw new Error(
      'manifest model setting schema must be exactly an object with required string properties "connectionId" and "providerModelId" and no additional properties',
    );
  }
}

function decodeCapabilityAdmission(value: unknown): {
  turnTypes: TurnTypeV1[];
  subagentRoles?: string[];
} {
  if (!isRecord(value)) {
    throw new Error("manifest capability admission must be an object");
  }
  exactFields(
    value,
    ["turnTypes", "subagentRoles"],
    "manifest capability admission",
  );
  if (!Array.isArray(value.turnTypes)) {
    throw new Error("manifest capability admission turnTypes must be an array");
  }
  if (value.turnTypes.length === 0) {
    throw new Error(
      "manifest capability admission turnTypes must not be empty",
    );
  }
  const turnTypes = value.turnTypes.map((turnType) =>
    decodeTurnTypeV1(turnType),
  );
  if (new Set(turnTypes).size !== turnTypes.length) {
    throw new Error("manifest capability admission turnTypes has duplicates");
  }
  if (value.subagentRoles === undefined) return { turnTypes };
  // The second ceiling dimension. The role names are opaque to the kernel —
  // bounded strings a Package chose — exactly as the kernel treats them at the
  // tool registry: what any of them *means* is the Subagents Package's policy.
  if (
    !Array.isArray(value.subagentRoles) ||
    value.subagentRoles.length === 0 ||
    value.subagentRoles.length > MANIFEST_SUBAGENT_ROLE_LIMIT
  ) {
    throw new Error(
      "manifest capability admission subagentRoles must be a bounded array",
    );
  }
  const subagentRoles = value.subagentRoles.map((role) => {
    if (
      typeof role !== "string" ||
      role.trim().length === 0 ||
      role.length > MANIFEST_SUBAGENT_ROLE_MAX
    ) {
      throw new Error(
        "manifest capability admission subagentRoles entry is invalid",
      );
    }
    return role;
  });
  if (new Set(subagentRoles).size !== subagentRoles.length) {
    throw new Error(
      "manifest capability admission subagentRoles has duplicates",
    );
  }
  return { turnTypes, subagentRoles };
}

/** How many roles a manifest may name, and how long a role name may be. */
const MANIFEST_SUBAGENT_ROLE_LIMIT = 16;
const MANIFEST_SUBAGENT_ROLE_MAX = 64;

/**
 * The setting definitions on one manifest record. A Package's own `settings`
 * are scoped to a User or a Bot; a Connection Type's are scoped to one
 * Connection and carry no `scopes` field at all, because their scope is the
 * record that declares them.
 */
function settingDefinitions(
  owner: Record<string, unknown>,
  scope: "package" | "connection",
): PackageSettingDefinition[] {
  return definitionArray(owner, "settings").map((setting) => {
    // `scopes` is optional on a Connection Type's settings and fixed when it
    // is present: the decoded form carries `["connection"]`, so a manifest
    // that round-trips through this decoder decodes again unchanged.
    exactFields(
      setting,
      [
        "id",
        "schemaVersion",
        "schema",
        "scopes",
        ...(scope === "package" ? ["role"] : []),
      ],
      "manifest setting definition",
    );
    const schemaVersion = setting.schemaVersion;
    if (!Number.isSafeInteger(schemaVersion) || (schemaVersion as number) < 1) {
      throw new Error(
        "manifest setting schemaVersion must be a positive integer",
      );
    }
    if (scope === "connection") {
      const declared = setting.scopes;
      if (
        declared !== undefined &&
        (!Array.isArray(declared) ||
          declared.length !== 1 ||
          declared[0] !== "connection")
      ) {
        throw new Error(
          'manifest Connection Type setting scopes must be ["connection"]',
        );
      }
      return {
        id: definitionId(setting),
        schemaVersion: schemaVersion as number,
        scopes: ["connection"],
        schema: safeSchema(setting.schema),
      };
    }
    const scopes = optionalStringArray(setting, "scopes");
    if (
      scopes.length === 0 ||
      !scopes.every((candidate) => candidate === "user" || candidate === "bot")
    ) {
      throw new Error("manifest setting scopes must contain user or bot");
    }
    if (setting.role !== undefined && setting.role !== "model") {
      throw new Error('manifest setting role must be "model"');
    }
    const schema = safeSchema(setting.schema);
    if (setting.role === "model") assertModelBindingSchema(schema);
    return {
      id: definitionId(setting),
      schemaVersion: schemaVersion as number,
      scopes: scopes as SettingScope[],
      ...(setting.role === undefined ? {} : { role: setting.role }),
      schema,
    };
  });
}

function decodeConfiguration(
  value: unknown,
  allowV4: boolean,
): PackageConfiguration {
  if (value === undefined) {
    return { settings: [], connectionTypes: [], capabilities: [] };
  }
  if (!isRecord(value))
    throw new Error("manifest configuration must be an object");
  exactFields(
    value,
    ["settings", "connectionTypes", "capabilities"],
    "manifest configuration",
  );
  const settings = settingDefinitions(value, "package");
  const connectionTypes = definitionArray(value, "connectionTypes").map(
    (connection) => {
      exactFields(
        connection,
        [
          "id",
          "displayName",
          "allowMultiple",
          "authorization",
          "capabilities",
          ...(allowV4 ? ["settings", "catalogPath"] : []),
        ],
        "manifest connection definition",
      );
      if (!isRecord(connection.authorization)) {
        throw new Error("manifest connection authorization must be an object");
      }
      exactFields(
        connection.authorization,
        [
          "kind",
          ...(Object.hasOwn(connection.authorization, "driverId")
            ? ["driverId"]
            : []),
        ],
        "manifest connection authorization",
      );
      const rawKind = requiredString(connection.authorization, "kind");
      if (
        rawKind !== "none" &&
        rawKind !== "api-key" &&
        rawKind !== "ambient-native" &&
        rawKind !== "grant"
      ) {
        throw new Error(
          "manifest connection authorization kind is unsupported",
        );
      }
      const kind: ConnectionTypeDefinition["authorization"]["kind"] = rawKind;
      const driverId =
        connection.authorization.driverId === undefined
          ? undefined
          : requiredString(connection.authorization, "driverId");
      if (kind !== "ambient-native" && driverId === undefined) {
        throw new Error(
          "manifest connection authorization driverId is required",
        );
      }
      if (kind === "ambient-native" && driverId !== undefined) {
        throw new Error(
          "manifest ambient-native authorization must not name a driver",
        );
      }
      if (typeof connection.allowMultiple !== "boolean") {
        throw new Error("manifest connection allowMultiple must be boolean");
      }
      if (
        connection.catalogPath !== undefined &&
        (typeof connection.catalogPath !== "string" ||
          !/^\/api\/[a-zA-Z0-9/_-]{1,200}$/.test(connection.catalogPath))
      ) {
        throw new Error(
          "manifest Connection catalogPath must be a same-origin API path",
        );
      }
      return {
        ...(typeof connection.catalogPath === "string"
          ? { catalogPath: connection.catalogPath }
          : {}),
        id: definitionId(connection),
        displayName: requiredString(connection, "displayName"),
        allowMultiple: connection.allowMultiple,
        authorization: {
          kind,
          ...(driverId ? { driverId } : {}),
        },
        capabilities: optionalStringArray(connection, "capabilities"),
        ...(allowV4 && connection.settings !== undefined
          ? { settings: settingDefinitions(connection, "connection") }
          : {}),
      };
    },
  );
  const capabilities = definitionArray(value, "capabilities").map(
    (capability) => {
      exactFields(
        capability,
        ["id", "kind", "connectionTypes", ...(allowV4 ? ["admission"] : [])],
        "manifest capability definition",
      );
      const rawKind = requiredString(capability, "kind");
      if (
        rawKind !== "tool" &&
        rawKind !== "model" &&
        rawKind !== "memory" &&
        rawKind !== "notification" &&
        rawKind !== "computer"
      ) {
        throw new Error("manifest capability kind is unsupported");
      }
      const kind: CapabilityDefinition["kind"] = rawKind;
      return {
        id: definitionId(capability),
        kind,
        connectionTypes: optionalStringArray(capability, "connectionTypes"),
        ...(allowV4 && capability.admission !== undefined
          ? { admission: decodeCapabilityAdmission(capability.admission) }
          : {}),
      };
    },
  );
  return { settings, connectionTypes, capabilities };
}

function decodeV3(value: Record<string, unknown>): FrockBotManifest {
  const base = decodeV2(value);
  const tools = decodeManifestTools(value.tools);
  const hooks = decodeManifestHooks(value.hooks);
  const roots = decodeManifestRoots(value.roots);
  const botIsolate = base.contributions.runtime?.host === "bot-isolate";
  if (botIsolate !== (tools !== undefined)) {
    throw new Error(
      "manifest bot-isolate runtime and tools declaration must appear together",
    );
  }
  if (!botIsolate && hooks !== undefined) {
    throw new Error("manifest hooks require a bot-isolate runtime");
  }
  validateIframeClientContribution(base.contributions.client, tools);
  return {
    ...base,
    schemaVersion: 3,
    configuration: decodeConfiguration(value.configuration, false),
    ...(tools ? { tools } : {}),
    ...(hooks ? { hooks } : {}),
    ...(roots ? { roots } : {}),
  };
}

/** v4 is v3 plus the Capability admission ceiling, and nothing else. */
function decodeV4(value: Record<string, unknown>): FrockBotManifest {
  const base = decodeV2(value);
  const tools = decodeManifestTools(value.tools);
  const hooks = decodeManifestHooks(value.hooks);
  const roots = decodeManifestRoots(value.roots);
  const botIsolate = base.contributions.runtime?.host === "bot-isolate";
  if (botIsolate !== (tools !== undefined)) {
    throw new Error(
      "manifest bot-isolate runtime and tools declaration must appear together",
    );
  }
  if (!botIsolate && hooks !== undefined) {
    throw new Error("manifest hooks require a bot-isolate runtime");
  }
  validateIframeClientContribution(base.contributions.client, tools);
  return {
    ...base,
    schemaVersion: 4,
    configuration: decodeConfiguration(value.configuration, true),
    ...(tools ? { tools } : {}),
    ...(hooks ? { hooks } : {}),
    ...(roots ? { roots } : {}),
  };
}

/**
 * v5 is v4 plus the multi-page iframe client, declarative entries, and the
 * Instance Contribution. A v3 or v4 record decodes to the same in-memory
 * shape through the single-page migration in `decodeV2`.
 */
function decodeV5(value: Record<string, unknown>): FrockBotManifest {
  const base = decodeV2(value);
  const tools = decodeManifestTools(value.tools);
  const hooks = decodeManifestHooks(value.hooks);
  // Declared roots are v3 onward, so a v5 manifest carries them too. Dropping
  // them here would silently unmount the durable root a v5 Package declares —
  // for the Applets Package, the directory its source lives in.
  const roots = decodeManifestRoots(value.roots);
  const botIsolate = base.contributions.runtime?.host === "bot-isolate";
  if (botIsolate !== (tools !== undefined)) {
    throw new Error(
      "manifest bot-isolate runtime and tools declaration must appear together",
    );
  }
  if (!botIsolate && hooks !== undefined) {
    throw new Error("manifest hooks require a bot-isolate runtime");
  }
  validateIframeClientContribution(base.contributions.client, tools);
  return {
    ...base,
    schemaVersion: 5,
    configuration: decodeConfiguration(value.configuration, true),
    ...(tools ? { tools } : {}),
    ...(hooks ? { hooks } : {}),
    ...(roots ? { roots } : {}),
  };
}

function validateIframeClientContribution(
  client: ClientContribution | undefined,
  tools: ManifestToolDeclaration[] | undefined,
): void {
  if (!client || !isClientIframeContribution(client)) return;
  const declaredTools = (tools ?? []).map((tool) => tool.name);
  const pageIds = client.pages.map((page) => page.id);
  for (const page of client.pages) {
    if (page.mounts.length === 0 || page.mounts.length > 64) {
      throw new Error(
        `manifest iframe client page "${page.id}" mounts must be a non-empty bounded array`,
      );
    }
    for (const mount of page.mounts) {
      if (!iframePageSlotAllowedV1(mount.slot, { declaredTools, pageIds })) {
        const toolResult = "frockbot.tool-result:";
        throw new Error(
          mount.slot.startsWith(toolResult)
            ? `manifest iframe client tool-result slot names undeclared tool "${mount.slot.slice(toolResult.length)}"`
            : `manifest iframe client slot "${mount.slot}" is not iframe-safe`,
        );
      }
    }
  }
  for (const entry of client.entries ?? []) {
    const target = client.pages.find((page) => page.id === entry.opens.page);
    if (
      !target ||
      !target.mounts.some(
        (mount) => mount.slot === `frockbot.surface:${entry.opens.page}`,
      )
    ) {
      throw new Error(
        `manifest iframe client entry "${entry.id}" opens page "${entry.opens.page}", which declares no surface mount`,
      );
    }
  }
}

export function decodeFrockBotManifest(value: unknown): FrockBotManifest {
  if (!isRecord(value)) throw new Error("manifest must be an object");
  if (value.schemaVersion === 1) {
    exactFields(
      value,
      [
        "schemaVersion",
        "id",
        "displayName",
        "version",
        "permissions",
        "contributions",
      ],
      "manifest",
    );
    return decodeV1(value);
  }
  if (
    value.schemaVersion === 2 ||
    value.schemaVersion === 3 ||
    value.schemaVersion === 4 ||
    value.schemaVersion === 5
  ) {
    exactFields(
      value,
      [
        "schemaVersion",
        "id",
        "displayName",
        "version",
        "permissions",
        "compatibility",
        "dependencies",
        "defaultEnablement",
        "contributions",
        ...(isV3OrLater(value) ? ["configuration"] : []),
        ...(isV3OrLater(value) ? ["tools"] : []),
        ...(isV3OrLater(value) ? ["hooks"] : []),
        ...(isV3OrLater(value) ? ["roots"] : []),
      ],
      "manifest",
    );
    if (value.schemaVersion === 2) return decodeV2(value);
    if (value.schemaVersion === 3) return decodeV3(value);
    if (value.schemaVersion === 4) return decodeV4(value);
    return decodeV5(value);
  }
  throw new Error("unsupported FrockBot manifest version");
}

export function declaredContributionKinds(
  manifest: FrockBotManifest,
): ManifestContributionKind[] {
  const kinds: ManifestContributionKind[] = [];
  if (manifest.contributions.backend) kinds.push("backend");
  if (manifest.contributions.runtime) kinds.push("runtime");
  if (manifest.contributions.client) kinds.push("client");
  if (manifest.contributions.desktop) kinds.push("desktop");
  if (manifest.contributions.mobile) kinds.push("mobile");
  return kinds;
}

/**
 * The Package setting schema decoder, exported for seams outside a manifest
 * that carry the same shape — a Catalog entry's `setupFields`, for instance.
 * Reuse rather than a second dialect: a field a Package could not declare in
 * its manifest must not become installable through the Catalog.
 */
export function decodePackageSettingSchemaV1(
  value: unknown,
): PackageSettingSchema {
  return safeSchema(value);
}
