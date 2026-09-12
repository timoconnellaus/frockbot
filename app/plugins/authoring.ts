// A Bot writing a Plugin (ADR 0026): the authority behind the `plugin_*`
// tools, pure over the seams the Bot Durable Object hands it.
//
// Source lives in the User's Workspace, builds go through the Applet build
// service in its Plugin mode, and a publish ends in an *intent* and an
// approval card rather than in a running Plugin: nothing here widens what
// the Bot may do. What the User approves is applied by `bot.ts`, after the
// decision commits.
import {
  APPLET_BUILD_LIMITS,
  APPLET_BUILD_PROTOCOL_VERSION,
  decodeAppletSourcePathV1,
  isPluginBuiltResponseV1,
  type AppletBuildRequestV1,
  type AppletBuildResponseV1,
  type AppletBuildSourceFileV1,
  type PluginBuildManifestV1,
} from "@frockbot/applets/build-contract";
import {
  decodePluginDescriptorV1,
  type PluginDescriptorV1,
  type SendToUserApprovalRiskV1,
  type WorkspaceFilesV1,
} from "@frockbot/core/contracts";
import type {
  CompositionGenerationV1,
  CompositionMemberV1,
} from "@frockbot/core/durable";
import type { AppletBuildServiceV1 } from "@frockbot/app/applets-host/records";
import {
  pluginApprovalActionV1,
  pluginApprovalIdV1,
  pluginApprovalRiskV1,
  pluginIntentKeyV1,
  type PluginIntentRecordV1,
  type PluginIntentStorageV1,
} from "./approval.js";
import {
  FIRST_PARTY_TOGGLEABLE_PLUGINS_V1,
  pluginRunsForBotV1,
  type SeededPluginV1,
} from "./catalog.js";
import {
  PluginEnablementConflictError,
  readPluginEnablementV1,
  setPluginEnabledV1,
  type PluginEnablementStorageV1,
} from "./enablement.js";
import {
  PLUGIN_SOURCE_FILES_V1,
  assertPluginIdV1,
  pluginIdFromDisplayNameV1,
  pluginSourceFilePathV1,
  pluginSourcePathV1,
  pluginsSourceRootV1,
} from "./root.js";
import { PLUGIN_TEMPLATE_FILES_V1 } from "./template.generated.js";

/** What the artifact ref records as the bundler that produced a Plugin. */
export const PLUGIN_BUNDLER_VERSION_V1 = "applet-build/plugin@1";

/** The Session, run and Turn one authoring effect is attributed to. */
export interface PluginAuthoringTurnV1 {
  sessionId: string;
  runId: string;
  turnId: string;
}

/** One Plugin as `plugin_list` names it. */
export interface PluginAuthoringRowV1 {
  pluginId: string;
  displayName: string;
  version: string;
  /** Written by one of this User's Bots, or shipped by the deployment. */
  authored: boolean;
  /** Running on this Bot. */
  on: boolean;
  /** Always on; the switch is not this Bot's to ask for. */
  locked: boolean;
}

export interface PluginSourceFileV1 {
  path: string;
  size: number;
}

/** What `plugin_check` answers. */
export type PluginCheckResultV1 =
  | { status: "checked" }
  | { status: "failed"; reason: string; diagnostics: string[] };

/** The card the feature appends to the Turn's log, and its identity. */
export interface PluginApprovalAskV1 {
  approvalId: string;
  action: string;
  rationale: string;
  risk: SendToUserApprovalRiskV1;
  /** True when this Turn already asked under the same effect: send nothing twice. */
  replayed: boolean;
}

export type PluginPublishResultV1 =
  | { status: "pending-approval"; pluginId: string; ask: PluginApprovalAskV1 }
  | {
      status: "failed";
      pluginId: string;
      reason: string;
      diagnostics: string[];
    };

export type PluginEnableResultV1 =
  | { status: "pending-approval"; pluginId: string; ask: PluginApprovalAskV1 }
  | { status: "already-on"; pluginId: string }
  | { status: "refused"; pluginId: string; reason: string };

/** The seams the Bot Durable Object supplies for one admitted Turn. */
export interface PluginAuthoringSeamsV1 {
  userId: string;
  botId: string;
  turn: PluginAuthoringTurnV1;
  workspace: WorkspaceFilesV1;
  /** Absent in a deployment with no build service; checks and publishes say so. */
  buildService?: AppletBuildServiceV1;
  artifacts: {
    putPackageArtifact(contentHash: string, module: string): Promise<void>;
  };
  composition: { current(): Promise<CompositionGenerationV1> };
  /** The Bot's own storage: its enable map and its intents. */
  storage: PluginEnablementStorageV1 & PluginIntentStorageV1;
  /** This Bot's settings values for one Plugin, under the isolate's own key. */
  settings: {
    read(pluginId: string): Promise<Record<string, unknown>>;
    write(pluginId: string, values: Record<string, unknown>): Promise<void>;
  };
  catalog: readonly SeededPluginV1[];
  now?: () => Date;
}

/** The authority, as the tools call it. */
export interface PluginAuthoringHostV1 {
  list(): Promise<PluginAuthoringRowV1[]>;
  create(input: { displayName: string }): Promise<{
    pluginId: string;
    files: string[];
  }>;
  files(input: { pluginId: string }): Promise<PluginSourceFileV1[]>;
  readFile(input: { pluginId: string; path: string }): Promise<string>;
  writeFile(input: {
    pluginId: string;
    path: string;
    text: string;
  }): Promise<void>;
  check(
    input: { pluginId: string },
    effectId: string,
  ): Promise<PluginCheckResultV1>;
  publish(
    input: { pluginId: string },
    effectId: string,
  ): Promise<PluginPublishResultV1>;
  enable(
    input: { pluginId: string },
    effectId: string,
  ): Promise<PluginEnableResultV1>;
  disable(input: {
    pluginId: string;
  }): Promise<{ status: "off" | "refused"; reason?: string }>;
  readSettings(input: { pluginId: string }): Promise<{
    schema?: Record<string, unknown>;
    values: Record<string, unknown>;
  }>;
  writeSettings(input: {
    pluginId: string;
    values: Record<string, unknown>;
  }): Promise<{ status: "written" | "refused"; reason?: string }>;
}

const TEXT = new TextDecoder("utf-8", { fatal: true });
const MAX_SETTINGS_BYTES = 16 * 1_024;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function decodeTemplate(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return TEXT.decode(bytes);
}

/** The scaffold, with the template's two placeholders filled in. */
export function pluginScaffoldV1(
  pluginId: string,
  displayName: string,
): Array<{ path: string; text: string }> {
  return PLUGIN_TEMPLATE_FILES_V1.map((file) => ({
    path: file.path,
    text: decodeTemplate(file.base64)
      .split("__PLUGIN_ID__")
      .join(pluginId)
      .split("__PLUGIN_NAME__")
      .join(displayName.replaceAll('"', "'")),
  }));
}

function sourceMediaType(path: string): string {
  return path.endsWith(".json") ? "application/json" : "text/typescript";
}

/** A source path the build service will accept, or a thrown sentence. */
export function requirePluginSourcePathV1(input: unknown): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("path is required");
  }
  try {
    return decodeAppletSourcePathV1(input);
  } catch (error) {
    throw new Error(
      `path is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** `path:line:col message`, the one line a Bot acts on. */
function diagnosticText(diagnostic: {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: string;
}): string {
  return `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.severity}: ${diagnostic.message}`;
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

/**
 * The descriptor against the manifest: every promise the descriptor makes
 * about the module is checked against what the module was seen to export.
 * Answers the first disagreement in words a Bot can act on.
 */
export function pluginManifestDisagreementV1(
  descriptor: PluginDescriptorV1,
  manifest: PluginBuildManifestV1,
): string | undefined {
  const declaredTools = descriptor.tools.map((tool) => tool.name);
  const exportedTools = manifest.tools.map((tool) => tool.name);
  if (!sameNames(declaredTools, exportedTools)) {
    return `plugin.json declares tools [${declaredTools.join(", ")}] but plugin.ts exports [${exportedTools.join(", ")}]`;
  }
  if (!sameNames(descriptor.hooks, manifest.hooks)) {
    return `plugin.json declares hooks [${descriptor.hooks.join(", ")}] but plugin.ts exports [${manifest.hooks.join(", ")}]`;
  }
  const provides = (descriptor.provides ?? []).map((service) => service.name);
  if (!sameNames(provides, manifest.services)) {
    return `plugin.json provides [${provides.join(", ")}] but plugin.ts exports services [${manifest.services.join(", ")}]`;
  }
  const triggers = (descriptor.triggers ?? []).map((trigger) => trigger.name);
  if (!sameNames(triggers, manifest.triggers)) {
    return `plugin.json declares triggers [${triggers.join(", ")}] but plugin.ts exports [${manifest.triggers.join(", ")}]`;
  }
  return undefined;
}

/**
 * The Bot's own switch: a disable the Bot decided, or an approval the User
 * gave, is not a stale page, so it is fenced on the revision read just
 * before it and a lost race is re-read rather than refused. Three losses in
 * a row is a real contention problem, and is thrown as one.
 */
export async function switchPluginForBotV1(
  storage: Parameters<typeof setPluginEnabledV1>[0],
  pluginId: string,
  enabled: boolean,
  now: Date,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    const current = await readPluginEnablementV1(storage);
    try {
      await setPluginEnabledV1(storage, {
        pluginId,
        enabled,
        expectedRevision: current.revision,
        now,
      });
      return;
    } catch (error) {
      if (error instanceof PluginEnablementConflictError && attempt < 2) {
        continue;
      }
      throw error;
    }
  }
}

export function createPluginAuthoringHostV1(
  seams: PluginAuthoringSeamsV1,
): PluginAuthoringHostV1 {
  const now = seams.now ?? (() => new Date());
  const root = pluginsSourceRootV1(seams.userId);
  const writer = {
    kind: "bot" as const,
    botId: seams.botId,
    sessionId: seams.turn.sessionId,
    turnId: seams.turn.turnId,
    runId: seams.turn.runId,
  };

  function reserved(pluginId: string): string | undefined {
    if (
      FIRST_PARTY_TOGGLEABLE_PLUGINS_V1.some(
        (feature) => feature.packageId === pluginId,
      )
    ) {
      return `"${pluginId}" is a built-in feature, not a Plugin you can write`;
    }
    if (seams.catalog.some((plugin) => plugin.pluginId === pluginId)) {
      return `"${pluginId}" is shipped by this deployment; write yours under another name`;
    }
    return undefined;
  }

  async function listSource(
    pluginId: string,
  ): Promise<{ entries: PluginSourceFileV1[] } | { failure: string }> {
    const prefix = pluginSourcePathV1(pluginId);
    const listed = await seams.workspace.list({
      root,
      prefix: prefix.slice(0, -1),
      limit: APPLET_BUILD_LIMITS.files + 1,
    });
    if (listed.status !== "ok") {
      return {
        failure: `the Plugin's source could not be listed: ${listed.status}${
          listed.reason ? ` — ${listed.reason}` : ""
        }`,
      };
    }
    return {
      entries: listed.entries
        .filter((entry) => entry.path.path.startsWith(prefix))
        .map((entry) => ({
          path: entry.path.path.slice(prefix.length),
          size: entry.generation.size,
        }))
        .filter((entry) => entry.path.length > 0)
        .sort((left, right) => left.path.localeCompare(right.path)),
    };
  }

  async function readSource(
    pluginId: string,
  ): Promise<{ files: AppletBuildSourceFileV1[] } | { failure: string }> {
    const listed = await listSource(pluginId);
    if ("failure" in listed) return listed;
    if (listed.entries.length === 0) {
      return {
        failure: `${pluginId} has no source. Call plugin_create, or write plugin.ts and plugin.json with plugin_write_file.`,
      };
    }
    if (listed.entries.length > APPLET_BUILD_LIMITS.files) {
      return {
        failure: `${pluginId} has more than ${APPLET_BUILD_LIMITS.files} source files; the build service takes no more.`,
      };
    }
    const files: AppletBuildSourceFileV1[] = [];
    let total = 0;
    for (const entry of listed.entries) {
      const outcome = await seams.workspace.read(
        pluginSourceFilePathV1(seams.userId, pluginId, entry.path),
      );
      if (outcome.status !== "ok") {
        return { failure: `"${entry.path}" is ${outcome.status}` };
      }
      const text = TEXT.decode(outcome.file.bytes);
      total += text.length;
      if (
        text.length > APPLET_BUILD_LIMITS.fileText ||
        total > APPLET_BUILD_LIMITS.sourceBytes
      ) {
        return {
          failure: `${pluginId}'s source is over the ${APPLET_BUILD_LIMITS.sourceBytes}-byte ceiling the build service accepts.`,
        };
      }
      files.push({ path: entry.path, text });
    }
    return { files };
  }

  async function build(
    pluginId: string,
    mode: "check" | "build",
    effectId: string,
  ): Promise<
    | { response: AppletBuildResponseV1; files: AppletBuildSourceFileV1[] }
    | { failure: string; diagnostics?: string[] }
  > {
    const service = seams.buildService;
    if (!service) {
      return {
        failure:
          "the build service is unavailable in this deployment, so nothing can be checked or published",
      };
    }
    const source = await readSource(pluginId);
    if ("failure" in source) return source;
    const request: AppletBuildRequestV1 = {
      version: APPLET_BUILD_PROTOCOL_VERSION,
      effectId,
      kind: "plugin",
      id: pluginId,
      mode,
      files: source.files,
    };
    let response: AppletBuildResponseV1;
    try {
      response = await service.build(request);
    } catch (error) {
      return {
        failure: `the build service could not be reached: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (response.status === "failed") {
      return {
        failure: `the build failed at the ${response.stage} stage`,
        diagnostics: response.diagnostics.map(diagnosticText),
      };
    }
    return { response, files: source.files };
  }

  function descriptorOf(
    pluginId: string,
    files: readonly AppletBuildSourceFileV1[],
  ): PluginDescriptorV1 | { failure: string } {
    const file = files.find((candidate) => candidate.path === "plugin.json");
    if (!file) return { failure: "plugin.json is missing" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.text);
    } catch (error) {
      return {
        failure: `plugin.json is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    let descriptor: PluginDescriptorV1;
    try {
      descriptor = decodePluginDescriptorV1(parsed, "plugin.json");
    } catch (error) {
      return {
        failure: `plugin.json is not a valid descriptor: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (descriptor.id !== pluginId) {
      return {
        failure: `plugin.json names "${descriptor.id}" but this Plugin is "${pluginId}"`,
      };
    }
    return descriptor;
  }

  async function ask(
    effectId: string,
    action: PluginIntentRecordV1["action"],
    member: Pick<CompositionMemberV1, "descriptor">,
    verb: "Run" | "Turn on",
  ): Promise<PluginApprovalAskV1> {
    const approvalId = pluginApprovalIdV1(effectId);
    const key = pluginIntentKeyV1(approvalId);
    const existing = await seams.storage.get<unknown>(key);
    const rationale =
      verb === "Run"
        ? "The Bot built this Plugin and asks to run it. Nothing runs until you approve; approving turns it on for this Bot only."
        : "The Bot asks to turn this Plugin on for itself. Approving turns it on for this Bot only.";
    const card = {
      approvalId,
      action: pluginApprovalActionV1(member, verb),
      rationale,
      risk: pluginApprovalRiskV1(member),
    };
    if (existing !== undefined) return { ...card, replayed: true };
    // Intent first, and durable before anybody is asked.
    const intent: PluginIntentRecordV1 = {
      schemaVersion: 1,
      approvalId,
      botId: seams.botId,
      sessionId: seams.turn.sessionId,
      runId: seams.turn.runId,
      turnId: seams.turn.turnId,
      createdAt: now().toISOString(),
      action,
    };
    await seams.storage.put(key, intent);
    return { ...card, replayed: false };
  }

  return {
    async list() {
      const [current, enablement] = await Promise.all([
        seams.composition.current(),
        readPluginEnablementV1(seams.storage),
      ]);
      return current.members.map((member) => {
        const seeded = seams.catalog.find(
          (plugin) => plugin.pluginId === member.packageId,
        );
        return {
          pluginId: member.packageId,
          displayName: seeded?.displayName ?? member.descriptor.displayName,
          version: member.version,
          authored: member.provenance.kind === "bot",
          on: pluginRunsForBotV1(seeded?.seed, member.packageId, enablement),
          locked: seeded?.seed === "locked",
        };
      });
    },

    async create(input) {
      const displayName = input.displayName.trim();
      if (displayName.length === 0 || displayName.length > 128) {
        throw new Error("displayName must be 1-128 characters");
      }
      const pluginId = pluginIdFromDisplayNameV1(displayName);
      const taken = reserved(pluginId);
      if (taken) throw new Error(taken);
      const listed = await listSource(pluginId);
      if ("failure" in listed) throw new Error(listed.failure);
      if (listed.entries.length > 0) {
        throw new Error(
          `"${pluginId}" already has source: plugin_files to see it, or choose another name`,
        );
      }
      const files: string[] = [];
      for (const file of pluginScaffoldV1(pluginId, displayName)) {
        await this.writeFile({ pluginId, path: file.path, text: file.text });
        files.push(file.path);
      }
      return { pluginId, files };
    },

    async files(input) {
      const listed = await listSource(assertPluginIdV1(input.pluginId));
      if ("failure" in listed) throw new Error(listed.failure);
      return listed.entries;
    },

    async readFile(input) {
      const outcome = await seams.workspace.read(
        pluginSourceFilePathV1(
          seams.userId,
          assertPluginIdV1(input.pluginId),
          input.path,
        ),
      );
      if (outcome.status !== "ok") {
        throw new Error(`"${input.path}" is ${outcome.status}`);
      }
      return TEXT.decode(outcome.file.bytes);
    },

    async writeFile(input) {
      const pluginId = assertPluginIdV1(input.pluginId);
      const taken = reserved(pluginId);
      if (taken) throw new Error(taken);
      const path = pluginSourceFilePathV1(seams.userId, pluginId, input.path);
      const existing = await seams.workspace.stat(path);
      const outcome = await seams.workspace.write({
        path,
        bytes: new TextEncoder().encode(input.text),
        writer,
        expectedGenerationId:
          existing.status === "ok"
            ? existing.entry.generation.generationId
            : null,
        mediaType: sourceMediaType(input.path),
      });
      if (outcome.status !== "ok") {
        throw new Error(
          `"${input.path}" could not be written: ${outcome.status}${
            outcome.reason ? ` — ${outcome.reason}` : ""
          }`,
        );
      }
    },

    async check(input, effectId) {
      const pluginId = assertPluginIdV1(input.pluginId);
      const built = await build(pluginId, "check", effectId);
      if ("failure" in built) {
        return {
          status: "failed",
          reason: built.failure,
          diagnostics: built.diagnostics ?? [],
        };
      }
      const descriptor = descriptorOf(pluginId, built.files);
      if ("failure" in descriptor) {
        return {
          status: "failed",
          reason: descriptor.failure,
          diagnostics: [],
        };
      }
      return { status: "checked" };
    },

    async publish(input, effectId) {
      const pluginId = assertPluginIdV1(input.pluginId);
      const fail = (reason: string, diagnostics: string[] = []) =>
        ({ status: "failed", pluginId, reason, diagnostics }) as const;
      const taken = reserved(pluginId);
      if (taken) return fail(taken);
      const built = await build(pluginId, "build", effectId);
      if ("failure" in built) return fail(built.failure, built.diagnostics);
      if (!isPluginBuiltResponseV1(built.response)) {
        return fail("the build returned no module");
      }
      const descriptor = descriptorOf(pluginId, built.files);
      if ("failure" in descriptor) return fail(descriptor.failure);
      const { manifest, module } = built.response;
      const disagreement = pluginManifestDisagreementV1(descriptor, manifest);
      if (disagreement) {
        return fail(
          `plugin.json and plugin.ts disagree: ${disagreement}. Make them match and publish again.`,
        );
      }
      // The service is handed bytes and returns bytes; the hash it declares
      // is checked here, in the authority that stores them.
      const contentHash = await sha256Hex(module);
      if (contentHash !== manifest.hashes.module) {
        return fail(
          "the build service's manifest does not match the module it returned",
        );
      }
      await seams.artifacts.putPackageArtifact(contentHash, module);
      const authoredAt = now().toISOString();
      const member: CompositionMemberV1 = {
        packageId: pluginId,
        version: descriptor.version,
        provenance: {
          kind: "bot",
          packageId: pluginId,
          version: descriptor.version,
          botId: seams.botId,
          sessionId: seams.turn.sessionId,
          turnId: seams.turn.turnId,
          runId: seams.turn.runId,
          authoredAt,
        },
        artifact: {
          contentHash,
          size: module.length,
          mediaType: "application/javascript",
          bundlerVersion: PLUGIN_BUNDLER_VERSION_V1,
        },
        descriptor,
      };
      const asked = await ask(
        effectId,
        { kind: "publish", member },
        member,
        "Run",
      );
      return { status: "pending-approval", pluginId, ask: asked };
    },

    async enable(input, effectId) {
      const pluginId = assertPluginIdV1(input.pluginId);
      const taken = reserved(pluginId);
      if (taken) return { status: "refused", pluginId, reason: taken };
      const [current, enablement] = await Promise.all([
        seams.composition.current(),
        readPluginEnablementV1(seams.storage),
      ]);
      const member = current.members.find(
        (candidate) => candidate.packageId === pluginId,
      );
      if (!member) {
        return {
          status: "refused",
          pluginId,
          reason: `"${pluginId}" is not in this account's Composition; publish it first`,
        };
      }
      const seeded = seams.catalog.find(
        (plugin) => plugin.pluginId === pluginId,
      );
      if (pluginRunsForBotV1(seeded?.seed, pluginId, enablement)) {
        return { status: "already-on", pluginId };
      }
      const asked = await ask(
        effectId,
        { kind: "enable", pluginId },
        member,
        "Turn on",
      );
      return { status: "pending-approval", pluginId, ask: asked };
    },

    async disable(input) {
      const pluginId = assertPluginIdV1(input.pluginId);
      const seeded = seams.catalog.find(
        (plugin) => plugin.pluginId === pluginId,
      );
      if (seeded?.seed === "locked") {
        return {
          status: "refused",
          reason: `"${seeded.displayName}" is always on`,
        };
      }
      await switchPluginForBotV1(seams.storage, pluginId, false, now());
      return { status: "off" };
    },

    async readSettings(input) {
      const pluginId = assertPluginIdV1(input.pluginId);
      const current = await seams.composition.current();
      const member = current.members.find(
        (candidate) => candidate.packageId === pluginId,
      );
      return {
        ...(member?.descriptor.settingsSchema
          ? { schema: member.descriptor.settingsSchema }
          : {}),
        values: await seams.settings.read(pluginId),
      };
    },

    async writeSettings(input) {
      const pluginId = assertPluginIdV1(input.pluginId);
      const current = await seams.composition.current();
      const member = current.members.find(
        (candidate) => candidate.packageId === pluginId,
      );
      if (!member) {
        return {
          status: "refused",
          reason: `"${pluginId}" is not in this account's Composition`,
        };
      }
      if (!member.descriptor.settingsSchema) {
        return {
          status: "refused",
          reason: `"${pluginId}" declares no settingsSchema, so it has no settings`,
        };
      }
      let serialized: string;
      try {
        serialized = JSON.stringify(input.values);
      } catch {
        return { status: "refused", reason: "settings values must be JSON" };
      }
      if (serialized === undefined || serialized.length > MAX_SETTINGS_BYTES) {
        return {
          status: "refused",
          reason: `settings values must be a JSON object under ${MAX_SETTINGS_BYTES} bytes`,
        };
      }
      await seams.settings.write(
        pluginId,
        JSON.parse(serialized) as Record<string, unknown>,
      );
      return { status: "written" };
    },
  };
}

/** The two source files every Plugin is, for the tools' words. */
export const PLUGIN_SOURCE_FILE_NAMES_V1 = PLUGIN_SOURCE_FILES_V1.join(" and ");
