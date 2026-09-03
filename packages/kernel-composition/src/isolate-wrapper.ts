// The kernel-generated wrapper module (`index.js`) for a Bot isolate.
//
// This is composition, not contract: the kernel *generates* this text and
// content-addresses it together with `package.js`, so changing a byte of it is
// a new artifact set and therefore a new loader identity. Bot code never
// implements the wrapper; it exports `tools` and `execute` and the wrapper
// adapts, decodes the invocation, enforces the deadline, and hands user code a
// narrow `ctx` that names only what the isolate may do.
//
// The wrapper is emitted as plain JavaScript because it is a module in the
// loaded Worker's module map, not a source file this repository compiles.
import {
  BOT_ISOLATE_HOOK_EVENTS_V1,
  type BotPackageContextV1,
} from "@frockbot/kernel-contracts";

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
 * The invocation guard. The isolate re-decodes what the Durable Object sent:
 * the boundary is crossed in both directions and both sides decode.
 */
export const BOT_ISOLATE_INVOCATION_SOURCE = `var TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
var HOOK_EVENTS = ${JSON.stringify(BOT_ISOLATE_HOOK_EVENTS_V1)};
var INVOCATION_KEYS = [
  "schemaVersion",
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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("isolate tool invocation must be an object");
  }
  // Exact keys, like the outbound twin: an invocation carrying a field this
  // contract does not declare is not this contract's invocation.
  if (
    Object.keys(value).length !== INVOCATION_KEYS.length ||
    !INVOCATION_KEYS.every(function (key) {
      return Object.hasOwn(value, key);
    })
  ) {
    throw new Error("isolate tool invocation has invalid fields");
  }
  if (value.schemaVersion !== 1) {
    throw new Error("isolate tool invocation schemaVersion is unsupported");
  }
  if (typeof value.tool !== "string" || !TOOL_NAME.test(value.tool)) {
    throw new Error("isolate tool invocation tool is invalid");
  }
  for (const key of ["botId", "sessionId", "runId", "turnId", "generationId"]) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new Error("isolate tool invocation " + key + " is invalid");
    }
  }
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
];
function decodeHookInvocation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("isolate hook invocation must be an object");
  }
  if (
    Object.keys(value).length !== HOOK_INVOCATION_KEYS.length ||
    !HOOK_INVOCATION_KEYS.every(function (key) {
      return Object.hasOwn(value, key);
    })
  ) {
    throw new Error("isolate hook invocation has invalid fields");
  }
  if (value.schemaVersion !== 1 || !HOOK_EVENTS.includes(value.event)) {
    throw new Error("isolate hook invocation is unsupported");
  }
  if (!value.payload || typeof value.payload !== "object" || Array.isArray(value.payload)) {
    throw new Error("isolate hook invocation payload is invalid");
  }
  for (const key of ["botId", "sessionId", "runId", "turnId", "generationId"]) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new Error("isolate hook invocation " + key + " is invalid");
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

const BOT_ISOLATE_CONTEXT_PROPERTY_SOURCE_V1 = {
  tool: "invocation.tool",
  event: "invocation.event",
  botId: "invocation.botId",
  sessionId: "invocation.sessionId",
  runId: "invocation.runId",
  turnId: "invocation.turnId",
  generationId: "invocation.generationId",
  packageId: "env.IDENTITY.packageId",
  deadlineMs: "invocation.deadlineMs",
  bindings: "Object.keys(env).sort()",
  capabilities: `{
      list: function () {
        return capabilities.list();
      },
    }`,
  model: `{
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
  tools: `{
      invoke: function (request) {
        return capabilities.invokeTool(request);
      },
    }`,
  memory: `{
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
  workspace: `{
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
  applets: `{
      list: function () {
        return capabilities.applets({ op: "list" });
      },
      create: function (input) {
        return capabilities.applets({ op: "create", displayName: input.displayName });
      },
      publish: function (input) {
        return capabilities.applets({ op: "publish", appletId: input.appletId });
      },
      revert: function (input) {
        return capabilities.applets({
          op: "revert",
          appletId: input.appletId,
          generationId: input.generationId,
        });
      },
      delete: function (input) {
        return capabilities.applets({ op: "delete", appletId: input.appletId });
      },
      focus: function (input) {
        return capabilities.applets({ op: "focus", appletId: input.appletId });
      },
      generations: function (input) {
        return capabilities.applets({ op: "generations", appletId: input.appletId });
      },
    }`,
  connection:
    "function (connectionId) { return capabilities.connection(connectionId); }",
  notify: "function (request) { return capabilities.notify(request); }",
  schedule: "function (request) { return capabilities.schedule(request); }",
} satisfies Record<keyof BotPackageContextV1, string>;

/** The keys the generated wrapper actually places on `ctx`. */
export const BOT_ISOLATE_NARROW_CONTEXT_KEYS_V1 = Object.keys(
  BOT_ISOLATE_CONTEXT_PROPERTY_SOURCE_V1,
) as Array<keyof BotPackageContextV1>;

export const BOT_ISOLATE_NARROW_CONTEXT_SOURCE_V1 = `function narrowContext(env, invocation) {
  const capabilities = env.CAPABILITIES;
  return {
${Object.entries(BOT_ISOLATE_CONTEXT_PROPERTY_SOURCE_V1)
  .map(([key, source]) => `    ${JSON.stringify(key)}: ${source},`)
  .join("\n")}
  };
}`;

/**
 * The wrapper module text. Content-addressed with `package.js`; bump
 * `BOT_ISOLATE_WRAPPER_VERSION` whenever this string changes so the mounted
 * module set — and therefore the loader id — changes with it.
 */
export const BOT_ISOLATE_WRAPPER_SOURCE = `// Generated by @frockbot/kernel-composition. Do not edit inside the isolate.
import { WorkerEntrypoint } from "cloudflare:workers";
import * as botPackage from "./package.js";

const CONTRACT_VERSION = 3;

${BOT_ISOLATE_DEADLINE_SOURCE}

${BOT_ISOLATE_INVOCATION_SOURCE}

${BOT_ISOLATE_MODEL_SOURCE}

function declaredTools() {
  const declared = Array.isArray(botPackage.tools) ? botPackage.tools : [];
  if (declared.length === 0) {
    throw new Error('package.js must export a non-empty "tools" array');
  }
  if (typeof botPackage.execute !== "function") {
    throw new Error('package.js must export an "execute" function');
  }
  return declared.map(function (tool) {
    if (!tool || typeof tool.name !== "string" || !TOOL_NAME.test(tool.name)) {
      throw new Error("package.js declared a tool with an invalid name");
    }
    const schema =
      tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
        ? tool.inputSchema
        : {};
    // Contract version 2: a tool may name the turn types it is offered on.
    // The kernel decodes and bounds it; the wrapper only carries it across.
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

function declaredHooks() {
  if (botPackage.hooks === undefined) return [];
  if (!botPackage.hooks || typeof botPackage.hooks !== "object" || Array.isArray(botPackage.hooks)) {
    throw new Error('package.js "hooks" must be an object');
  }
  return Object.keys(botPackage.hooks).map(function (event) {
    if (!HOOK_EVENTS.includes(event)) {
      throw new Error('package.js declared an unsupported hook "' + event + '"');
    }
    if (typeof botPackage.hooks[event] !== "function") {
      throw new Error('package.js hook "' + event + '" must be a function');
    }
    return event;
  });
}

${BOT_ISOLATE_NARROW_CONTEXT_SOURCE_V1}

export default class extends WorkerEntrypoint {
  async health() {
    return {
      schemaVersion: 1,
      ok: true,
      packageId: this.env.IDENTITY.packageId,
      contractVersion: CONTRACT_VERSION,
      tools: declaredTools(),
      hooks: declaredHooks(),
    };
  }

  async execute(rawInvocation) {
    let invocation;
    try {
      invocation = decodeInvocation(rawInvocation);
    } catch (error) {
      return {
        schemaVersion: 1,
        content: String((error && error.message) || error),
        isError: true,
      };
    }
    try {
      const context = narrowContext(this.env, invocation);
      const value = await withIsolateDeadline(function () {
        return botPackage.execute(invocation.tool, invocation.input, context);
      }, invocation.deadlineMs);
      return {
        schemaVersion: 1,
        content: typeof value === "string" ? value : JSON.stringify(value ?? null),
        isError: false,
      };
    } catch (error) {
      return {
        schemaVersion: 1,
        content: String((error && error.message) || error),
        isError: true,
      };
    }
  }

  async hook(rawInvocation) {
    const invocation = decodeHookInvocation(rawInvocation);
    const hooks = declaredHooks();
    if (!hooks.includes(invocation.event)) {
      throw new Error('package.js did not declare hook "' + invocation.event + '"');
    }
    const context = narrowContext(this.env, invocation);
    const replacement = await withIsolateDeadline(function () {
      return botPackage.hooks[invocation.event](invocation.payload, context);
    }, invocation.deadlineMs);
    return replacement === undefined
      ? { schemaVersion: 1, status: "unchanged" }
      : { schemaVersion: 1, status: "replaced", replacement: replacement };
  }
}
`;

/** Bumped with any change to the wrapper text; folded into the loader id. */
export const BOT_ISOLATE_WRAPPER_VERSION = "wrapper-v5";

export const BOT_ISOLATE_MAIN_MODULE = "index.js";
export const BOT_ISOLATE_PACKAGE_MODULE = "package.js";

/** The exactly-two-entry module map a Bot isolate mounts. */
export function botIsolateModuleMap(packageSource: string): {
  [path: string]: { js: string };
} {
  return {
    [BOT_ISOLATE_MAIN_MODULE]: { js: BOT_ISOLATE_WRAPPER_SOURCE },
    [BOT_ISOLATE_PACKAGE_MODULE]: { js: packageSource },
  };
}
