// The Plugin worker boundary: every DTO that crosses between a Bot's Durable
// Object and the one Dynamic Worker that holds every Plugin its User installed.
//
// The worker is layer two (ADR 0026). The loop stays in the Durable Object and
// calls the worker once per open hook per Turn with the Bot's enabled list;
// the worker's generated index fans out to the enabled Plugins in order and
// answers with one patch. A Plugin that throws is skipped and named in the
// answer, so the Durable Object can count it toward quarantine without the
// Turn failing.
//
// Everything decoded here is untrusted: Plugin code produces the results and
// the health report.
import { canonicalJson, sha256 } from "./canonical-json.js";
import {
  decodeIsolateContractVersionV1,
  decodeIsolateHealthV1,
  decodeIsolateHookInvocationV1,
  decodeIsolateHookResultV1,
  decodeIsolateToolInvocationV1,
  ISOLATE_MAX_DEADLINE_MS,
  type IsolateContractVersion,
  type IsolateHealthV1,
  type IsolateHookInvocationV1,
  type IsolateHookResultV1,
  type IsolateToolDescriptorV1,
  type IsolateToolInvocationV1,
  type IsolateToolResultV1,
} from "./isolate.js";
import type { BotIsolateHookEventNameV1 } from "./loop-events.js";
import type { PluginServiceV1 } from "./plugin-descriptor.js";

const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;
const PLUGIN_TRIGGER_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_PLUGINS_V1 = 64;
const MAX_FAILURE_REASON_V1 = 1_024;
const MAX_TRIGGER_HEADERS_V1 = 64;
const MAX_TRIGGER_HEADER_BYTES_V1 = 8_192;
const MAX_TRIGGER_BODY_BYTES_V1 = 1_000_000;

/** One Plugin's artifact in the worker's module set. */
export interface PluginWorkerMemberV1 {
  pluginId: string;
  contentHash: string;
}

/**
 * The module-set hash the loader id is derived from. A reused loader id
 * silently serves the first code and `env`, so it covers everything the load
 * depends on: the contract the wrapper speaks, the generated index's own
 * version, every artifact by content, and the digest of the bindings baked
 * into `env`. A deploy that changes none of these leaves every User's worker
 * where it is.
 */
export async function pluginWorkerModuleSetHashV1(input: {
  contractVersion: IsolateContractVersion;
  indexVersion: string;
  members: readonly PluginWorkerMemberV1[];
  bindingDigest: string;
}): Promise<string> {
  const members = input.members
    .map((member) => ({
      pluginId: boundedString(member.pluginId, "plugin worker member id", 64),
      contentHash: hex(member.contentHash, "plugin worker member hash"),
    }))
    .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));
  if (
    new Set(members.map((member) => member.pluginId)).size !== members.length
  ) {
    throw new Error("plugin worker members contain duplicate ids");
  }
  return sha256(
    canonicalJson({
      contractVersion: input.contractVersion,
      indexVersion: boundedString(
        input.indexVersion,
        "plugin worker index version",
        64,
      ),
      members,
      bindingDigest: hex(input.bindingDigest, "plugin worker binding digest"),
    }),
  );
}

export function pluginWorkerLoaderIdV1(input: {
  userId: string;
  moduleSetHash: string;
}): string {
  const userId = boundedString(input.userId, "plugin worker userId", 256);
  if (/[:\s]/.test(userId)) {
    throw new Error("plugin worker loader id components are invalid");
  }
  return `plugin-worker:${userId}:${hex(input.moduleSetHash, "plugin worker module set hash")}`;
}

/** What one Plugin reported at mount, as the wrapper saw it. */
export interface PluginWorkerPluginHealthV1 {
  pluginId: string;
  ok: boolean;
  /** Present exactly when `ok` is false. */
  reason?: string;
  tools: IsolateToolDescriptorV1[];
  hooks: BotIsolateHookEventNameV1[];
  provides: PluginServiceV1[];
  consumes: PluginServiceV1[];
  triggers: string[];
}

export interface PluginWorkerHealthV1 {
  schemaVersion: 1;
  contractVersion: IsolateContractVersion;
  plugins: PluginWorkerPluginHealthV1[];
}

/** A hook invocation carries the Bot's enabled list; the index skips the rest. */
export interface PluginWorkerHookInvocationV1<
  Event extends BotIsolateHookEventNameV1 = BotIsolateHookEventNameV1,
> extends IsolateHookInvocationV1<Event> {
  enabled: string[];
}

/** One Plugin the index skipped during a hook or a mount. */
export interface PluginWorkerFailureV1 {
  pluginId: string;
  reason: string;
}

export type PluginWorkerHookResultV1 = IsolateHookResultV1 & {
  failures: PluginWorkerFailureV1[];
};

export interface PluginWorkerToolInvocationV1 extends IsolateToolInvocationV1 {
  pluginId: string;
}

/** An event arriving on the app-owned hooks route, handed to one Plugin. */
export interface PluginWorkerTriggerInvocationV1 {
  schemaVersion: 1;
  pluginId: string;
  trigger: string;
  headers: Record<string, string>;
  body: string;
  botId: string;
  routineId: string;
  deadlineMs: number;
}

export type PluginWorkerTriggerResultV1 =
  | { schemaVersion: 1; status: "drop"; reason?: string }
  | { schemaVersion: 1; status: "fire"; text: string };

/**
 * The wrapper `WorkerEntrypoint` the kernel generates over the index. Plugin
 * code never implements this; each Plugin exports `tools`, `execute`, and
 * optionally `hooks`, `provides` and `triggers`, and the index adapts.
 */
export interface PluginWorkerEntrypoint {
  health(): Promise<PluginWorkerHealthV1>;
  hook(
    invocation: PluginWorkerHookInvocationV1,
  ): Promise<PluginWorkerHookResultV1>;
  execute(
    invocation: PluginWorkerToolInvocationV1,
  ): Promise<IsolateToolResultV1>;
  receiveTrigger(
    invocation: PluginWorkerTriggerInvocationV1,
  ): Promise<PluginWorkerTriggerResultV1>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const allowed = new Set<string>([...required, ...optional]);
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    !Object.keys(value).every((key) => allowed.has(key))
  ) {
    throw new Error(`${label} has invalid fields`);
  }
}

function boundedString(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum
  ) {
    throw new Error(`${label} must be a bounded string`);
  }
  return value;
}

function hex(value: unknown, label: string): string {
  const text = boundedString(value, label, 128);
  if (!/^[0-9a-f]+$/.test(text)) throw new Error(`${label} must be hex`);
  return text;
}

function pluginId(value: unknown, label: string): string {
  const id = boundedString(value, label, 64);
  if (!PLUGIN_ID.test(id)) throw new Error(`${label} is invalid`);
  return id;
}

function pluginIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_PLUGINS_V1) {
    throw new Error(`${label} must be a bounded array`);
  }
  const ids = value.map((entry, index) =>
    pluginId(entry, `${label}[${index}]`),
  );
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label} contains duplicates`);
  }
  return ids;
}

function decodeServices(value: unknown, label: string): PluginServiceV1[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error(`${label} must be a bounded array`);
  }
  return value.map((entry, index) => {
    const itemLabel = `${label}[${index}]`;
    const service = record(entry, itemLabel);
    exactKeys(service, ["name", "version"], itemLabel);
    const name = boundedString(service.name, `${itemLabel}.name`, 64);
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
      throw new Error(`${itemLabel}.name is invalid`);
    }
    if (
      !Number.isSafeInteger(service.version) ||
      (service.version as number) < 1
    ) {
      throw new Error(`${itemLabel}.version must be a positive integer`);
    }
    return { name, version: service.version as number };
  });
}

function decodeFailures(
  value: unknown,
  label: string,
): PluginWorkerFailureV1[] {
  if (!Array.isArray(value) || value.length > MAX_PLUGINS_V1) {
    throw new Error(`${label} must be a bounded array`);
  }
  return value.map((entry, index) => {
    const itemLabel = `${label}[${index}]`;
    const failure = record(entry, itemLabel);
    exactKeys(failure, ["pluginId", "reason"], itemLabel);
    return {
      pluginId: pluginId(failure.pluginId, `${itemLabel}.pluginId`),
      reason: boundedString(
        failure.reason,
        `${itemLabel}.reason`,
        MAX_FAILURE_REASON_V1,
      ),
    };
  });
}

export function decodePluginWorkerHealthV1(
  input: unknown,
  label = "plugin worker health",
): PluginWorkerHealthV1 {
  const value = record(input, label);
  exactKeys(value, ["schemaVersion", "contractVersion", "plugins"], label);
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  if (!Array.isArray(value.plugins) || value.plugins.length > MAX_PLUGINS_V1) {
    throw new Error(`${label}.plugins must be a bounded array`);
  }
  const contractVersion = decodeIsolateContractVersionV1(
    value.contractVersion,
    label,
  );
  const plugins = value.plugins.map((entry, index) => {
    const itemLabel = `${label}.plugins[${index}]`;
    const plugin = record(entry, itemLabel);
    exactKeys(
      plugin,
      [
        "pluginId",
        "ok",
        "tools",
        // Hooks are a contract-3 capability; an older worker does not name them.
        ...(contractVersion >= 3 ? ["hooks"] : []),
        "provides",
        "consumes",
        "triggers",
      ],
      itemLabel,
      ["reason"],
    );
    if (typeof plugin.ok !== "boolean") {
      throw new Error(`${itemLabel}.ok must be a boolean`);
    }
    if ((plugin.reason !== undefined) === plugin.ok) {
      throw new Error(`${itemLabel}.reason is present exactly when not ok`);
    }
    // The per-plugin tool and hook lists are the single-isolate health report's
    // shape, decoded by the decoder that already knows its bounds.
    const health: IsolateHealthV1 = decodeIsolateHealthV1(
      {
        schemaVersion: 1,
        ok: plugin.ok,
        packageId: plugin.pluginId,
        contractVersion,
        tools: plugin.tools,
        ...(contractVersion >= 3 ? { hooks: plugin.hooks } : {}),
      },
      itemLabel,
    );
    if (!Array.isArray(plugin.triggers) || plugin.triggers.length > 16) {
      throw new Error(`${itemLabel}.triggers must be a bounded array`);
    }
    const triggers = plugin.triggers.map((trigger, triggerIndex) => {
      const name = boundedString(
        trigger,
        `${itemLabel}.triggers[${triggerIndex}]`,
        64,
      );
      if (!PLUGIN_TRIGGER_NAME.test(name)) {
        throw new Error(`${itemLabel}.triggers[${triggerIndex}] is invalid`);
      }
      return name;
    });
    if (new Set(triggers).size !== triggers.length) {
      throw new Error(`${itemLabel}.triggers contains duplicates`);
    }
    return {
      pluginId: pluginId(plugin.pluginId, `${itemLabel}.pluginId`),
      ok: plugin.ok,
      ...(plugin.reason === undefined
        ? {}
        : {
            reason: boundedString(
              plugin.reason,
              `${itemLabel}.reason`,
              MAX_FAILURE_REASON_V1,
            ),
          }),
      tools: health.tools,
      hooks: health.hooks ?? [],
      provides: decodeServices(plugin.provides, `${itemLabel}.provides`),
      consumes: decodeServices(plugin.consumes, `${itemLabel}.consumes`),
      triggers,
    };
  });
  if (
    new Set(plugins.map((plugin) => plugin.pluginId)).size !== plugins.length
  ) {
    throw new Error(`${label}.plugins contains duplicate ids`);
  }
  return { schemaVersion: 1, contractVersion, plugins };
}

export function decodePluginWorkerHookInvocationV1(
  input: unknown,
  label = "plugin worker hook invocation",
): PluginWorkerHookInvocationV1 {
  const value = record(input, label);
  if (!Object.hasOwn(value, "enabled")) {
    throw new Error(`${label} has invalid fields`);
  }
  const { enabled, ...rest } = value;
  return {
    ...decodeIsolateHookInvocationV1(rest, label),
    enabled: pluginIds(enabled, `${label}.enabled`),
  };
}

export function decodePluginWorkerHookResultV1(
  input: unknown,
  label = "plugin worker hook result",
): PluginWorkerHookResultV1 {
  const value = record(input, label);
  if (!Object.hasOwn(value, "failures")) {
    throw new Error(`${label} has invalid fields`);
  }
  const { failures, ...rest } = value;
  return {
    ...decodeIsolateHookResultV1(rest, label),
    failures: decodeFailures(failures, `${label}.failures`),
  };
}

export function decodePluginWorkerToolInvocationV1(
  input: unknown,
  label = "plugin worker tool invocation",
): PluginWorkerToolInvocationV1 {
  const value = record(input, label);
  if (!Object.hasOwn(value, "pluginId")) {
    throw new Error(`${label} has invalid fields`);
  }
  const { pluginId: id, ...rest } = value;
  return {
    ...decodeIsolateToolInvocationV1(rest, label),
    pluginId: pluginId(id, `${label}.pluginId`),
  };
}

export function decodePluginWorkerTriggerInvocationV1(
  input: unknown,
  label = "plugin worker trigger invocation",
): PluginWorkerTriggerInvocationV1 {
  const value = record(input, label);
  exactKeys(
    value,
    [
      "schemaVersion",
      "pluginId",
      "trigger",
      "headers",
      "body",
      "botId",
      "routineId",
      "deadlineMs",
    ],
    label,
  );
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  const trigger = boundedString(value.trigger, `${label}.trigger`, 64);
  if (!PLUGIN_TRIGGER_NAME.test(trigger)) {
    throw new Error(`${label}.trigger is invalid`);
  }
  const headerEntries = Object.entries(
    record(value.headers, `${label}.headers`),
  );
  if (headerEntries.length > MAX_TRIGGER_HEADERS_V1) {
    throw new Error(`${label}.headers exceeds its bound`);
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of headerEntries) {
    // Lowercased on the way in: the provider's casing is not a signal, and a
    // plugin comparing names should not have to guess.
    const lowered = boundedString(name, `${label}.headers`, 256).toLowerCase();
    if (Object.hasOwn(headers, lowered)) {
      throw new Error(`${label}.headers contains duplicate names`);
    }
    headers[lowered] = boundedString(
      headerValue,
      `${label}.headers.${name}`,
      MAX_TRIGGER_HEADER_BYTES_V1,
      true,
    );
  }
  const deadlineMs = value.deadlineMs;
  if (
    !Number.isSafeInteger(deadlineMs) ||
    (deadlineMs as number) <= 0 ||
    (deadlineMs as number) > ISOLATE_MAX_DEADLINE_MS
  ) {
    throw new Error(`${label}.deadlineMs is out of range`);
  }
  return {
    schemaVersion: 1,
    pluginId: pluginId(value.pluginId, `${label}.pluginId`),
    trigger,
    headers,
    body: boundedString(
      value.body,
      `${label}.body`,
      MAX_TRIGGER_BODY_BYTES_V1,
      true,
    ),
    botId: boundedString(value.botId, `${label}.botId`, 256),
    routineId: boundedString(value.routineId, `${label}.routineId`, 256),
    deadlineMs: deadlineMs as number,
  };
}

export function decodePluginWorkerTriggerResultV1(
  input: unknown,
  label = "plugin worker trigger result",
): PluginWorkerTriggerResultV1 {
  const value = record(input, label);
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  if (value.status === "drop") {
    exactKeys(value, ["schemaVersion", "status"], label, ["reason"]);
    return {
      schemaVersion: 1,
      status: "drop",
      ...(value.reason === undefined
        ? {}
        : {
            reason: boundedString(
              value.reason,
              `${label}.reason`,
              MAX_FAILURE_REASON_V1,
            ),
          }),
    };
  }
  exactKeys(value, ["schemaVersion", "status", "text"], label);
  if (value.status !== "fire") throw new Error(`${label}.status is invalid`);
  return {
    schemaVersion: 1,
    status: "fire",
    text: boundedString(value.text, `${label}.text`, MAX_TRIGGER_BODY_BYTES_V1),
  };
}
