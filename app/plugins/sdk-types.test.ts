/**
 * `@frockbot/applet-sdk/plugin` is types only and imports nothing from the
 * kernel, so nothing but this file keeps its `PluginContext`, hook events,
 * grants and hook payloads in step with what the wrapper really builds. The
 * declarations are imported as types here and pinned to the kernel's own
 * types by the compiler: a drift is a type error, not a missing string.
 *
 * The pin is identity, not mutual assignability: an `any` — which is what a
 * name the `.d.ts` failed to resolve becomes under `skipLibCheck` — a
 * `readonly` or an optional member that differs from the kernel's all fail.
 *
 * The build contract carries a second hand copy of the hook events — the
 * container image copies `applets/` alone, so `build-contract.ts` cannot
 * import core — and it is pinned to the same list below.
 */
import { describe, expect, test } from "bun:test";
import {
  BOT_ISOLATE_CONTEXT_KEYS_V1,
  BOT_ISOLATE_HOOK_EVENTS_V1,
  decodeBotIsolateHookReplacementV1,
  PLUGIN_GRANTS_V1,
  type BotIsolateHookEventNameV1,
  type LoopEventPayloadMapV1,
  type LoopEventReturnMapV1,
  type PluginGrantV1,
} from "@frockbot/core/contracts";
import type { BotLookV1, ThemeDocumentV1 } from "@frockbot/core/theme";
import { PLUGIN_BUILD_HOOK_EVENTS_V1 } from "@frockbot/applets/build-contract";
import type {
  BotLook,
  PluginContext,
  PluginGrant,
  PluginHookEvent,
  PluginHookPayloads,
  PluginHookReplacements,
  ThemeDocument,
} from "../../applets/sdk/plugin";

type BotIsolateContextKeyV1 = (typeof BOT_ISOLATE_CONTEXT_KEYS_V1)[number];

/** True only when the compiler holds the two types identical. */
type Exact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** Compiles only when the two types are identical. */
function exact<T extends true>(_assertion: T): void {}

/** Every hook event a Plugin may replace a value for. */
type ReplaceableHookEventV1 = Exclude<
  BotIsolateHookEventNameV1,
  "agent/turn-stopping"
>;

describe("the Plugin SDK declarations", () => {
  test("PluginContext names exactly the ctx members the wrapper builds", () => {
    exact<Exact<keyof PluginContext, BotIsolateContextKeyV1>>(true);
    expect(BOT_ISOLATE_CONTEXT_KEYS_V1.length).toBeGreaterThan(0);
  });

  test("the hook events and grants are the kernel's", () => {
    exact<Exact<PluginHookEvent, BotIsolateHookEventNameV1>>(true);
    exact<Exact<PluginGrant, PluginGrantV1>>(true);
    expect(PLUGIN_GRANTS_V1.length).toBeGreaterThan(0);
  });

  test("PluginHookPayloads covers every hook event once", () => {
    exact<Exact<keyof PluginHookPayloads, BotIsolateHookEventNameV1>>(true);
    exact<Exact<keyof PluginHookReplacements, BotIsolateHookEventNameV1>>(true);
  });

  test("the theme document is the kernel's ThemeDocumentV1", () => {
    exact<Exact<ThemeDocument, ThemeDocumentV1>>(true);
    exact<Exact<BotLook, BotLookV1>>(true);
  });

  test("every hook payload is the one the kernel hands the isolate", () => {
    exact<
      Exact<
        PluginHookPayloads["system-prompt/assemble"],
        LoopEventPayloadMapV1["system-prompt/assemble"]
      >
    >(true);
    exact<
      Exact<
        PluginHookPayloads["agent/tool-exposure"],
        LoopEventPayloadMapV1["agent/tool-exposure"]
      >
    >(true);
    exact<
      Exact<
        PluginHookPayloads["agent/request"],
        LoopEventPayloadMapV1["agent/request"]
      >
    >(true);
    exact<
      Exact<
        PluginHookPayloads["tools/pre-execute"],
        LoopEventPayloadMapV1["tools/pre-execute"]
      >
    >(true);
    exact<
      Exact<
        PluginHookPayloads["tools/post-execute"],
        LoopEventPayloadMapV1["tools/post-execute"]
      >
    >(true);
    exact<
      Exact<
        PluginHookPayloads["agent/turn-stopping"],
        LoopEventPayloadMapV1["agent/turn-stopping"]
      >
    >(true);
    exact<
      Exact<
        PluginHookPayloads["theme/assemble"],
        LoopEventPayloadMapV1["theme/assemble"]
      >
    >(true);
    // The list above is every event: one added to the kernel fails here.
    exact<
      Exact<
        {
          [Event in BotIsolateHookEventNameV1]: Exact<
            PluginHookPayloads[Event],
            LoopEventPayloadMapV1[Event]
          >;
        },
        { [Event in BotIsolateHookEventNameV1]: true }
      >
    >(true);
  });

  test("every replacement is the value the kernel decodes it back into", () => {
    exact<
      Exact<
        {
          [Event in ReplaceableHookEventV1]: Exact<
            PluginHookReplacements[Event],
            LoopEventReturnMapV1[Event]
          >;
        },
        { [Event in ReplaceableHookEventV1]: true }
      >
    >(true);
    // A notification replaces nothing: the SDK says so with `never`, and the
    // kernel refuses any value a Plugin offers anyway.
    exact<Exact<PluginHookReplacements["agent/turn-stopping"], never>>(true);
    expect(() =>
      decodeBotIsolateHookReplacementV1("agent/turn-stopping", {}, undefined),
    ).toThrow(/cannot replace a notification/);
  });
});

describe("the Plugin build contract", () => {
  test("serves exactly the kernel's hook events, in the kernel's order", () => {
    expect([...PLUGIN_BUILD_HOOK_EVENTS_V1]).toEqual([
      ...BOT_ISOLATE_HOOK_EVENTS_V1,
    ]);
  });
});
