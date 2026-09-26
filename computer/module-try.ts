// `plugin_module_try`: a Plugin's device module, run once on the Bot's own
// Computer before it reaches a desktop (ADR 0037).
//
// The Worker cannot start a process, so everything that runs the module is on
// the Computer: one command fetches the pinned Deno the first time, writes the
// desktop's module runtime and the try's runner beside the module, and runs
// the runner under Node, which prints one JSON line. The runtime and runner
// travel with each try, so they are always this release's.

import {
  decodePluginModuleTryInputV1,
  PLUGIN_MODULE_RUNTIME_JS_BASE64_V1,
  PLUGIN_MODULE_TRY_DENO_V1,
  PLUGIN_MODULE_TRY_RUNNER_JS_BASE64_V1,
  PLUGIN_MODULE_TRY_START_MS_V1,
  type PluginDeviceModuleV1,
  type PluginModuleTryActionV1,
  type PluginModuleTryRequestV1,
  type PluginModuleTryResultV1,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionResult,
} from "@frockbot/core/contracts";
import type { ComputerExecResult } from "@frockbot/computer/core/host";

/**
 * A Plugin's device module as `plugin_publish` would store it, built from its
 * source now. The Plugin authoring host supplies it; absent, and the tool is
 * not offered. It refuses a call or an event the declaration does not name
 * before anything is built.
 */
export interface ComputerPluginModulesSeamV1 {
  moduleToTry(
    input: {
      pluginId: string;
      moduleId?: string;
      action: PluginModuleTryActionV1;
    },
    effectId: string,
  ): Promise<
    | { pluginId: string; module: PluginDeviceModuleV1; code: string }
    | { failure: string }
  >;
}

/** One command on the Computer, with its stdin and environment. */
export type ComputerModuleTryShellV1 = (
  context: ToolExecutionContext,
  command: {
    script: string;
    stdin: Uint8Array;
    env: Record<string, string>;
    timeoutMs: number;
  },
) => Promise<ComputerExecResult>;

/** Where the Computer keeps the Deno it fetched, one directory per version. */
const DENO_HOME = `$HOME/.frockbot/deno/${PLUGIN_MODULE_TRY_DENO_V1.version}`;

/**
 * Fetches the pinned Deno once per Computer and runs the try. `MODULE_TRY_DENO`
 * points it at another binary, for the platform's own tests. The fetch lands
 * beside where it is kept and is renamed into place, so two tries at once
 * never see half a binary.
 */
export const PLUGIN_MODULE_TRY_SCRIPT_V1 = [
  "set -e",
  `DENO="\${MODULE_TRY_DENO:-${DENO_HOME}/deno}"`,
  'if [ ! -x "$DENO" ]; then',
  '  case "$(uname -m)" in',
  `    x86_64) TARGET=x86_64-unknown-linux-gnu; SUM=${PLUGIN_MODULE_TRY_DENO_V1.sha256["x86_64-unknown-linux-gnu"]} ;;`,
  `    aarch64 | arm64) TARGET=aarch64-unknown-linux-gnu; SUM=${PLUGIN_MODULE_TRY_DENO_V1.sha256["aarch64-unknown-linux-gnu"]} ;;`,
  '    *) echo "there is no pinned Deno for $(uname -m)" >&2; exit 3 ;;',
  "  esac",
  '  mkdir -p "$(dirname "$DENO")"',
  '  FETCH=$(mktemp -d "$(dirname "$DENO")/fetch.XXXXXX")',
  `  curl -fsSL --retry 2 -o "$FETCH/deno.zip" "https://dl.deno.land/release/v${PLUGIN_MODULE_TRY_DENO_V1.version}/deno-$TARGET.zip" || { rm -rf "$FETCH"; echo "Deno ${PLUGIN_MODULE_TRY_DENO_V1.version} could not be downloaded to this Computer" >&2; exit 3; }`,
  '  echo "$SUM  $FETCH/deno.zip" | sha256sum -c --status || { rm -rf "$FETCH"; echo "the Deno download did not match its pinned hash" >&2; exit 3; }',
  '  if command -v unzip >/dev/null; then unzip -q -o "$FETCH/deno.zip" deno -d "$FETCH"; else python3 -c \'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extract("deno", sys.argv[2])\' "$FETCH/deno.zip" "$FETCH"; fi',
  '  chmod 755 "$FETCH/deno"',
  '  mv -f "$FETCH/deno" "$DENO"',
  '  rm -rf "$FETCH"',
  "fi",
  'D=$(mktemp -d "${TMPDIR:-/tmp}/module-try.XXXXXX")',
  "trap 'rm -rf \"$D\"' EXIT",
  'printf %s "$FROCKBOT_MODULE_TRY_RUNNER" | base64 -d > "$D/module-try.mjs"',
  'printf %s "$FROCKBOT_MODULE_RUNTIME" | base64 -d > "$D/runtime.js"',
  'cat > "$D/request.json"',
  'node "$D/module-try.mjs" "$D" "$DENO"',
].join("\n");

const TEXT = new TextDecoder();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPluginModuleTryToolV1(
  modules: ComputerPluginModulesSeamV1,
  shell: ComputerModuleTryShellV1,
): ToolDefinition {
  return {
    name: "plugin_module_try",
    namespace: "frockbot",
    admission: {
      turnTypes: ["chat", "agent", "automation", "subagent"],
      subagentRoles: ["executor"],
    },
    // Each try starts the module afresh with only what it is handed, so a
    // repeat is another try, not a second effect anywhere but the Computer.
    idempotent: true,
    description: [
      "Run one of your Plugin's device modules on your Computer before a desktop runs it: the module exactly as plugin_publish would store it, under Deno with the permissions its declaration generates, through the same runtime the Mac uses.",
      "Name a `call` (with its `input`) to invoke one call, or an `event` to start the module and wait for its `start` to emit that event. Your Computer has no Beeper and no Messages: start your own stand-in first — a mock server on the port the module declares in `net`, a database at the path it declares in `read` (`~/` is your Computer's home) — and point the module at it.",
      "You get back the call's value or error, every event it emitted (event, key, payload; none is sent anywhere), its log lines, and each access Deno refused — a read or a host outside the declaration fails here as it will on the Mac. `lastKey` answers from `lastKeys`, the store starts as `store`, and Apple Events refuse: they run only on the Mac.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        pluginId: { type: "string", description: "The Plugin's id." },
        moduleId: {
          type: "string",
          description:
            "Which device module, when the Plugin declares more than one.",
        },
        call: {
          type: "string",
          description: "A call the module declares. Give this or `event`.",
        },
        input: { description: "The call's input, as its caller would pass." },
        event: {
          type: "string",
          description:
            "An event the module declares: start it and wait until its `start` emits this.",
        },
        waitMs: {
          type: "number",
          description:
            "How long the call may take, or the event may take to come: 100 to 30000, default 10000 (what a real device.call waits).",
        },
        lastKeys: {
          type: "object",
          description: "What `lastKey(event)` answers, by event.",
        },
        store: {
          type: "object",
          description: "What the module's store holds when it starts.",
        },
      },
      required: ["pluginId"],
      additionalProperties: false,
    },
    execute: async (input, context): Promise<ToolExecutionResult> => {
      let tried: ReturnType<typeof decodePluginModuleTryInputV1>;
      try {
        tried = decodePluginModuleTryInputV1(input);
      } catch (error) {
        return { content: errorMessage(error), isError: true };
      }
      const found = await modules.moduleToTry(
        {
          pluginId: tried.pluginId,
          ...(tried.moduleId === undefined ? {} : { moduleId: tried.moduleId }),
          action: tried.action,
        },
        context.effectId,
      );
      if ("failure" in found) return { content: found.failure, isError: true };
      const request: PluginModuleTryRequestV1 = {
        module: {
          id: found.module.id,
          read: found.module.read,
          net: found.module.net,
          appleEvents: found.module.appleEvents,
          calls: found.module.calls,
          events: found.module.events,
        },
        code: found.code,
        action: tried.action,
        waitMs: tried.waitMs,
        startMs: PLUGIN_MODULE_TRY_START_MS_V1,
        lastKeys: tried.lastKeys,
        store: tried.store,
      };
      const ran = await shell(context, {
        script: PLUGIN_MODULE_TRY_SCRIPT_V1,
        stdin: new TextEncoder().encode(JSON.stringify(request)),
        env: {
          FROCKBOT_MODULE_TRY_RUNNER: PLUGIN_MODULE_TRY_RUNNER_JS_BASE64_V1,
          FROCKBOT_MODULE_RUNTIME: PLUGIN_MODULE_RUNTIME_JS_BASE64_V1,
        },
        // A first try on a Computer also fetches Deno.
        timeoutMs: 120_000,
      });
      const line = TEXT.decode(ran.stdout).trim().split("\n").at(-1) ?? "";
      let result: PluginModuleTryResultV1;
      try {
        if (ran.exitCode !== 0) throw new Error("the runner failed");
        result = JSON.parse(line) as PluginModuleTryResultV1;
      } catch {
        return {
          content: `The module could not be tried: ${
            TEXT.decode(ran.stderr).trim().slice(-1_500) ||
            `the runner exited ${ran.exitCode ?? ran.signal ?? "without a code"}`
          }`,
          isError: true,
        };
      }
      return {
        content: JSON.stringify({
          module: `${found.pluginId}/${found.module.id}`,
          ...result,
        }),
        isError: false,
      };
    },
  };
}
