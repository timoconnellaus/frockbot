// The kernel-generated index module (`index.js`) for a User's Plugin worker.
//
// This is composition, not contract: the kernel *generates* this text and
// content-addresses it with every Plugin artifact it imports, so changing a
// byte of it is a new module set and therefore a new loader identity. Plugin
// code never implements the wrapper; each Plugin exports `tools` and
// `execute`, optionally `hooks`, `services` and `triggers`, and the index
// adapts: it decodes each invocation, enforces the deadline, fans a hook out
// to the enabled Plugins in mount order, and hands each Plugin a narrow `ctx`
// that names only what that Plugin may do.
//
// The wrapper is emitted as plain JavaScript because it is a module in the
// loaded Worker's module map, not a source file this repository compiles.
import {
  BOT_ISOLATE_HOOK_EVENTS_V1,
  ISOLATE_CONTRACT_VERSION,
  type BotPackageContextV1,
} from "@frockbot/core/contracts";

/**
 * The deadline guard, shared verbatim between the generated wrapper and the
 * Bun test that proves it. Kept as source text so the tested function and the
 * shipped function cannot drift.
 */
export const BOT_ISOLATE_DEADLINE_SOURCE = `function withIsolateDeadline(work, deadlineMs) {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 60000) {
    return Promise.reject(new Error("isolate invocation deadline is out of range"));
  }
  let timer;
  const expiry = new Promise(function (_resolve, reject) {
    timer = setTimeout(function () {
      reject(new Error("isolate invocation exceeded its deadline of " + deadlineMs + "ms"));
    }, deadlineMs);
  });
  return Promise.race([Promise.resolve().then(work), expiry]).finally(function () {
    clearTimeout(timer);
  });
}`;

/**
 * The invocation guards. The worker re-decodes what the Durable Object sent:
 * the boundary is crossed in both directions and both sides decode.
 */
export const BOT_ISOLATE_INVOCATION_SOURCE = `var TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
var PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;
var TRIGGER_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
var HOOK_EVENTS = ${JSON.stringify(BOT_ISOLATE_HOOK_EVENTS_V1)};
var IDENTITY_KEYS = ["botId", "sessionId", "runId", "turnId", "generationId"];
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value, keys, label) {
  if (!isRecord(value)) {
    throw new Error(label + " must be an object");
  }
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every(function (key) {
      return Object.hasOwn(value, key);
    })
  ) {
    throw new Error(label + " has invalid fields");
  }
}
function identityFields(value, label) {
  for (const key of IDENTITY_KEYS) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new Error(label + " " + key + " is invalid");
    }
  }
}
var INVOCATION_KEYS = [
  "schemaVersion",
  "pluginId",
  "tool",
  "input",
  "botId",
  "sessionId",
  "runId",
  "turnId",
  "generationId",
  "deadlineMs",
];
function decodeInvocation(value) {
  exactKeys(value, INVOCATION_KEYS, "plugin worker tool invocation");
  if (value.schemaVersion !== 1) {
    throw new Error("plugin worker tool invocation schemaVersion is unsupported");
  }
  if (typeof value.pluginId !== "string" || !PLUGIN_ID.test(value.pluginId)) {
    throw new Error("plugin worker tool invocation pluginId is invalid");
  }
  if (typeof value.tool !== "string" || !TOOL_NAME.test(value.tool)) {
    throw new Error("plugin worker tool invocation tool is invalid");
  }
  identityFields(value, "plugin worker tool invocation");
  return value;
}
var HOOK_INVOCATION_KEYS = [
  "schemaVersion",
  "event",
  "payload",
  "botId",
  "sessionId",
  "runId",
  "turnId",
  "generationId",
  "deadlineMs",
  "enabled",
];
function decodeHookInvocation(value) {
  exactKeys(value, HOOK_INVOCATION_KEYS, "plugin worker hook invocation");
  if (value.schemaVersion !== 1 || !HOOK_EVENTS.includes(value.event)) {
    throw new Error("plugin worker hook invocation is unsupported");
  }
  if (!isRecord(value.payload)) {
    throw new Error("plugin worker hook invocation payload is invalid");
  }
  if (
    !Array.isArray(value.enabled) ||
    !value.enabled.every(function (id) {
      return typeof id === "string" && PLUGIN_ID.test(id);
    })
  ) {
    throw new Error("plugin worker hook invocation enabled is invalid");
  }
  identityFields(value, "plugin worker hook invocation");
  return value;
}
var TRIGGER_INVOCATION_KEYS = [
  "schemaVersion",
  "pluginId",
  "trigger",
  "headers",
  "body",
  "botId",
  "routineId",
  "deadlineMs",
];
function decodeTriggerInvocation(value) {
  exactKeys(value, TRIGGER_INVOCATION_KEYS, "plugin worker trigger invocation");
  if (value.schemaVersion !== 1) {
    throw new Error("plugin worker trigger invocation schemaVersion is unsupported");
  }
  if (typeof value.pluginId !== "string" || !PLUGIN_ID.test(value.pluginId)) {
    throw new Error("plugin worker trigger invocation pluginId is invalid");
  }
  if (typeof value.trigger !== "string" || !TRIGGER_NAME.test(value.trigger)) {
    throw new Error("plugin worker trigger invocation trigger is invalid");
  }
  if (!isRecord(value.headers) || typeof value.body !== "string") {
    throw new Error("plugin worker trigger invocation event is invalid");
  }
  for (const key of ["botId", "routineId"]) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new Error("plugin worker trigger invocation " + key + " is invalid");
    }
  }
  return value;
}`;

/** Decodes one NDJSON line of the `invokeModel` byte stream inside the isolate. */
export const BOT_ISOLATE_MODEL_SOURCE = `async function* modelEvents(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline = buffer.indexOf("\\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) yield JSON.parse(line);
        newline = buffer.indexOf("\\n");
      }
    }
    const tail = buffer.trim();
    if (tail.length > 0) yield JSON.parse(tail);
  } finally {
    reader.releaseLock();
  }
}`;

/**
 * The `ctx` members that are always present: the identity of the call, the
 * three context keys, and the services the Plugin consumes. Nothing here is
 * authority.
 */
const BOT_ISOLATE_CONTEXT_PROPERTY_SOURCE_V1 = {
  tool: "invocation.tool",
  event: "invocation.event",
  user: "{ userId: env.IDENTITY.userId }",
  bot: "{ botId: invocation.botId }",
  session: `{
      sessionId: invocation.sessionId,
      runId: invocation.runId,
      turnId: invocation.turnId,
      generationId: invocation.generationId,
    }`,
  packageId: "plugin.pluginId",
  deadlineMs: "invocation.deadlineMs",
  bindings: "Object.keys(env).sort()",
  capabilities: `{
      list: function () {
        return capabilities.list();
      },
    }`,
  services: "plugin.services",
} satisfies Partial<Record<keyof BotPackageContextV1, string>>;

/**
 * One `ctx` member per grant. A grant the Plugin did not declare is never
 * built, so `ctx.workspace` on a Plugin without the Workspace grant is
 * `undefined` rather than a call that reaches the authority and is refused.
 */
const BOT_ISOLATE_GRANT_PROPERTY_SOURCE_V1 = {
  ai: [
    "model",
    `{
      invoke: async function (request) {
        const outcome = await capabilities.invokeModel(request);
        if (!outcome || outcome.status !== "streaming") return outcome;
        return {
          status: "streaming",
          requestId: outcome.requestId,
          events: modelEvents(outcome.events),
        };
      },
    }`,
  ],
  memory: [
    "memory",
    `{
      read: function (request) {
        return capabilities.memoryRead(request);
      },
      write: function (request) {
        return capabilities.memoryWrite(request);
      },
      forget: function (request) {
        return capabilities.memoryForget(request);
      },
    }`,
  ],
  workspace: [
    "workspace",
    `{
      read: function (path) {
        return capabilities.workspaceRead(path);
      },
      list: function (request) {
        return capabilities.workspaceList(request);
      },
      stat: function (path) {
        return capabilities.workspaceStat(path);
      },
      write: function (request) {
        return capabilities.workspaceWrite(request);
      },
      delete: function (request) {
        return capabilities.workspaceDelete(request);
      },
    }`,
  ],
  http: [
    "connection",
    "function (connectionId) { return capabilities.connection(connectionId); }",
  ],
  schedule: [
    "schedule",
    "function (request) { return capabilities.schedule(request); }",
  ],
} satisfies Record<string, [keyof BotPackageContextV1, string]>;

/** The keys the generated wrapper places on `ctx` when every grant is held. */
export const BOT_ISOLATE_NARROW_CONTEXT_KEYS_V1 = [
  ...Object.keys(BOT_ISOLATE_CONTEXT_PROPERTY_SOURCE_V1),
  ...Object.values(BOT_ISOLATE_GRANT_PROPERTY_SOURCE_V1).map(([key]) => key),
] as Array<keyof BotPackageContextV1>;

export const BOT_ISOLATE_NARROW_CONTEXT_SOURCE_V1 = `function narrowContext(env, invocation, plugin) {
  const capabilities = env.CAPABILITIES;
  const grants = plugin.grants || [];
  const context = {
${Object.entries(BOT_ISOLATE_CONTEXT_PROPERTY_SOURCE_V1)
  .map(([key, source]) => `    ${JSON.stringify(key)}: ${source},`)
  .join("\n")}
  };
${Object.entries(BOT_ISOLATE_GRANT_PROPERTY_SOURCE_V1)
  .map(
    ([grant, [key, source]]) =>
      `  if (grants.includes(${JSON.stringify(grant)})) {\n    context[${JSON.stringify(key)}] = ${source};\n  }`,
  )
  .join("\n")}
  return context;
}`;

/**
 * Which key of a hook's payload carries the value the hook may replace, so a
 * later Plugin sees an earlier Plugin's change. A notification carries none.
 */
export const BOT_ISOLATE_HOOK_VALUE_KEYS_V1 = {
  "system-prompt/assemble": "assembly",
  "agent/tool-exposure": "tools",
  "agent/request": "request",
  "tools/pre-execute": "preparation",
  "tools/post-execute": "result",
  "agent/turn-stopping": null,
} as const satisfies Record<
  (typeof BOT_ISOLATE_HOOK_EVENTS_V1)[number],
  string | null
>;

/** How an error anywhere in the index is reduced to text for the kernel. */
export const BOT_ISOLATE_ERROR_TEXT_SOURCE = `function errorText(error) {
  return String((error && error.message) || error);
}`;

/**
 * The hook chain, shared verbatim between the generated wrapper and the Bun
 * test that proves it. The invocation's deadline is the budget for the whole
 * chain, because the Durable Object races the single `hook()` call against
 * that same number: each Plugin is given only what is left of it, and a
 * Plugin the chain reaches with nothing left is skipped and named rather
 * than started on borrowed time the kernel would charge to everyone.
 */
export const BOT_ISOLATE_HOOK_CHAIN_SOURCE = `var HOOK_MIN_SLICE_MS = 25;
async function runHookChain(plugins, invocation, contextFor) {
  const startedAt = Date.now();
  const valueKey = HOOK_VALUE_KEYS[invocation.event];
  const failures = [];
  let replacement;
  let replaced = false;
  for (const plugin of plugins) {
    if (!plugin.ok || !invocation.enabled.includes(plugin.pluginId)) continue;
    if (!plugin.hooks.includes(invocation.event)) continue;
    const remaining = invocation.deadlineMs - (Date.now() - startedAt);
    if (remaining < HOOK_MIN_SLICE_MS) {
      failures.push({
        pluginId: plugin.pluginId,
        reason: "the hook chain exhausted its deadline of " + invocation.deadlineMs + "ms before this plugin ran",
      });
      continue;
    }
    const payload =
      replaced && valueKey
        ? Object.assign({}, invocation.payload, { [valueKey]: replacement })
        : invocation.payload;
    const context = contextFor(plugin);
    try {
      const value = await withIsolateDeadline(function () {
        return plugin.module.hooks[invocation.event](payload, context);
      }, remaining);
      if (value !== undefined) {
        if (!valueKey) {
          throw new Error("a notification hook cannot replace a value");
        }
        replacement = value;
        replaced = true;
      }
    } catch (error) {
      failures.push({ pluginId: plugin.pluginId, reason: errorText(error) });
    }
  }
  return replaced
    ? { schemaVersion: 1, status: "replaced", replacement: replacement, failures: failures }
    : { schemaVersion: 1, status: "unchanged", failures: failures };
}`;

/** What one Plugin's module must export, checked once at mount. */
export const BOT_ISOLATE_DECLARATION_SOURCE = `function declaredTools(module, pluginId) {
  const declared = Array.isArray(module.tools) ? module.tools : [];
  if (declared.length === 0) {
    throw new Error('plugin "' + pluginId + '" must export a non-empty "tools" array');
  }
  if (typeof module.execute !== "function") {
    throw new Error('plugin "' + pluginId + '" must export an "execute" function');
  }
  return declared.map(function (tool) {
    if (!tool || typeof tool.name !== "string" || !TOOL_NAME.test(tool.name)) {
      throw new Error('plugin "' + pluginId + '" declared a tool with an invalid name');
    }
    const schema =
      tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
        ? tool.inputSchema
        : {};
    const admission =
      tool.admission && typeof tool.admission === "object"
        ? {
            turnTypes: tool.admission.turnTypes,
            ...(tool.admission.subagentRoles
              ? { subagentRoles: tool.admission.subagentRoles }
              : {}),
          }
        : undefined;
    return Object.assign(
      {
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        inputSchema: schema,
        idempotent: tool.idempotent === true,
      },
      admission ? { admission: admission } : {},
    );
  });
}

function declaredHooks(module, pluginId) {
  if (module.hooks === undefined) return [];
  if (!isRecord(module.hooks)) {
    throw new Error('plugin "' + pluginId + '" "hooks" must be an object');
  }
  return Object.keys(module.hooks).map(function (event) {
    if (!HOOK_EVENTS.includes(event)) {
      throw new Error('plugin "' + pluginId + '" declared an unsupported hook "' + event + '"');
    }
    if (typeof module.hooks[event] !== "function") {
      throw new Error('plugin "' + pluginId + '" hook "' + event + '" must be a function');
    }
    return event;
  });
}

function declaredServices(module, pluginId) {
  if (module.services === undefined) return {};
  if (!isRecord(module.services)) {
    throw new Error('plugin "' + pluginId + '" "services" must be an object');
  }
  return module.services;
}

function declaredTriggers(module, pluginId) {
  if (module.triggers === undefined) return [];
  if (!isRecord(module.triggers)) {
    throw new Error('plugin "' + pluginId + '" "triggers" must be an object');
  }
  return Object.keys(module.triggers).map(function (name) {
    if (!TRIGGER_NAME.test(name)) {
      throw new Error('plugin "' + pluginId + '" declared a trigger with an invalid name');
    }
    if (typeof module.triggers[name] !== "function") {
      throw new Error('plugin "' + pluginId + '" trigger "' + name + '" must be a function');
    }
    return name;
  });
}`;

/** The path a Plugin's artifact is mounted at inside the worker's module map. */
export function pluginWorkerModulePathV1(pluginId: string): string {
  return `plugins/${pluginId}.js`;
}

export const PLUGIN_WORKER_MAIN_MODULE = "index.js";

/**
 * The index module text for one set of Plugins, in mount order. The order is
 * the host's: providers before the Plugins that consume them.
 */
export function pluginWorkerIndexSourceV1(
  pluginIds: readonly string[],
): string {
  const imports = pluginIds
    .map(
      (pluginId, index) =>
        `import * as plugin_${index} from ${JSON.stringify(`./${pluginWorkerModulePathV1(pluginId)}`)};`,
    )
    .join("\n");
  const modules = pluginIds
    .map((pluginId, index) => `  ${JSON.stringify(pluginId)}: plugin_${index},`)
    .join("\n");
  return `// Generated by @frockbot/frock-compose. Do not edit inside the isolate.
import { WorkerEntrypoint } from "cloudflare:workers";
${imports}

const CONTRACT_VERSION = ${ISOLATE_CONTRACT_VERSION};
const PLUGIN_MODULES = {
${modules}
};
const HOOK_VALUE_KEYS = ${JSON.stringify(BOT_ISOLATE_HOOK_VALUE_KEYS_V1)};

${BOT_ISOLATE_DEADLINE_SOURCE}

${BOT_ISOLATE_INVOCATION_SOURCE}

${BOT_ISOLATE_MODEL_SOURCE}

${BOT_ISOLATE_DECLARATION_SOURCE}

${BOT_ISOLATE_NARROW_CONTEXT_SOURCE_V1}

${BOT_ISOLATE_ERROR_TEXT_SOURCE}

${BOT_ISOLATE_HOOK_CHAIN_SOURCE}

/**
 * Every Plugin the identity names, mounted once in identity order. A Plugin
 * whose module does not declare itself correctly is carried as not ok and
 * never invoked; the others still mount. A service a Plugin provides is read
 * from its module once here and handed to the Plugins mounted after it that
 * consume it, so a provider is always mounted before its consumers.
 */
let mountedPlugins;
function mountAll(env) {
  if (mountedPlugins) return mountedPlugins;
  const provided = {};
  mountedPlugins = (env.IDENTITY.plugins || []).map(function (identity) {
    const pluginId = identity.pluginId;
    const module = PLUGIN_MODULES[pluginId];
    const plugin = {
      pluginId: pluginId,
      grants: identity.grants || [],
      consumes: identity.consumes || [],
      module: module,
      ok: false,
      reason: undefined,
      tools: [],
      hooks: [],
      provides: [],
      triggers: [],
      services: {},
    };
    try {
      if (!module) throw new Error('plugin "' + pluginId + '" has no module');
      plugin.tools = declaredTools(module, pluginId);
      plugin.hooks = declaredHooks(module, pluginId);
      plugin.triggers = declaredTriggers(module, pluginId);
      const services = declaredServices(module, pluginId);
      plugin.provides = Object.keys(services);
      for (const name of plugin.consumes) {
        if (!Object.hasOwn(provided, name)) {
          throw new Error('plugin "' + pluginId + '" consumes "' + name + '", which no earlier plugin provides');
        }
        plugin.services[name] = provided[name];
      }
      for (const name of plugin.provides) provided[name] = services[name];
      plugin.ok = true;
    } catch (error) {
      plugin.reason = errorText(error);
    }
    return plugin;
  });
  return mountedPlugins;
}

function findPlugin(env, pluginId) {
  const plugin = mountAll(env).find(function (candidate) {
    return candidate.pluginId === pluginId;
  });
  if (!plugin) throw new Error('plugin "' + pluginId + '" is not mounted');
  if (!plugin.ok) throw new Error('plugin "' + pluginId + '" failed to mount: ' + plugin.reason);
  return plugin;
}

export default class extends WorkerEntrypoint {
  async health() {
    return {
      schemaVersion: 1,
      contractVersion: CONTRACT_VERSION,
      plugins: mountAll(this.env).map(function (plugin) {
        return Object.assign(
          {
            pluginId: plugin.pluginId,
            ok: plugin.ok,
            tools: plugin.tools,
            hooks: plugin.hooks,
            provides: plugin.provides.map(function (name) {
              return { name: name, version: 1 };
            }),
            consumes: plugin.consumes.map(function (name) {
              return { name: name, version: 1 };
            }),
            triggers: plugin.triggers,
          },
          plugin.ok ? {} : { reason: plugin.reason },
        );
      }),
    };
  }

  async execute(rawInvocation) {
    let invocation;
    try {
      invocation = decodeInvocation(rawInvocation);
    } catch (error) {
      return { schemaVersion: 1, content: errorText(error), isError: true };
    }
    try {
      const plugin = findPlugin(this.env, invocation.pluginId);
      const context = narrowContext(this.env, invocation, plugin);
      const value = await withIsolateDeadline(function () {
        return plugin.module.execute(invocation.tool, invocation.input, context);
      }, invocation.deadlineMs);
      return {
        schemaVersion: 1,
        content: typeof value === "string" ? value : JSON.stringify(value ?? null),
        isError: false,
      };
    } catch (error) {
      return { schemaVersion: 1, content: errorText(error), isError: true };
    }
  }

  /**
   * One call per open hook per Turn. The enabled Plugins that declared the
   * event run in mount order; each sees the value the one before it left,
   * and a Plugin that throws, times out or answers with something that is
   * not a value is skipped and named, never allowed to stop the chain.
   */
  async hook(rawInvocation) {
    const invocation = decodeHookInvocation(rawInvocation);
    const env = this.env;
    return runHookChain(mountAll(env), invocation, function (plugin) {
      return narrowContext(env, invocation, plugin);
    });
  }

  async receiveTrigger(rawInvocation) {
    const invocation = decodeTriggerInvocation(rawInvocation);
    try {
      const plugin = findPlugin(this.env, invocation.pluginId);
      if (!plugin.triggers.includes(invocation.trigger)) {
        throw new Error('plugin "' + invocation.pluginId + '" did not declare trigger "' + invocation.trigger + '"');
      }
      const context = narrowContext(
        this.env,
        {
          botId: invocation.botId,
          sessionId: "trigger:" + invocation.routineId,
          runId: "trigger:" + invocation.routineId,
          turnId: "trigger:" + invocation.routineId,
          generationId: "trigger",
          deadlineMs: invocation.deadlineMs,
        },
        plugin,
      );
      const value = await withIsolateDeadline(function () {
        return plugin.module.triggers[invocation.trigger](
          { headers: invocation.headers, body: invocation.body },
          context,
        );
      }, invocation.deadlineMs);
      if (typeof value === "string" && value.length > 0) {
        return { schemaVersion: 1, status: "fire", text: value };
      }
      if (value && typeof value === "object" && value.drop === true) {
        return Object.assign(
          { schemaVersion: 1, status: "drop" },
          typeof value.reason === "string" ? { reason: value.reason } : {},
        );
      }
      return { schemaVersion: 1, status: "drop", reason: "the trigger returned no text" };
    } catch (error) {
      return { schemaVersion: 1, status: "drop", reason: errorText(error) };
    }
  }
}
`;
}

/**
 * Bumped with any change to the generated text; folded into the module-set
 * hash beside the contract version, so a wrapper change is a new worker.
 */
export const PLUGIN_WORKER_INDEX_VERSION = "index-v1";

/** The module map a Plugin worker mounts: the index and one module per Plugin. */
export function pluginWorkerModuleMap(
  plugins: readonly { pluginId: string; source: string }[],
): Record<string, { js: string }> {
  const modules: Record<string, { js: string }> = {
    [PLUGIN_WORKER_MAIN_MODULE]: {
      js: pluginWorkerIndexSourceV1(plugins.map((plugin) => plugin.pluginId)),
    },
  };
  for (const plugin of plugins) {
    modules[pluginWorkerModulePathV1(plugin.pluginId)] = { js: plugin.source };
  }
  return modules;
}
