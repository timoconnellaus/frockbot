/**
 * `@frockbot/applet-sdk/plugin` is types only and imports nothing from the
 * kernel, so nothing but this file keeps its `PluginContext`, hook events and
 * grants in step with what the wrapper really builds. The declarations are
 * imported as types here and pinned to the kernel's own lists by the compiler:
 * a drift is a type error, not a missing string.
 *
 * The build contract carries a second hand copy of the hook events — the
 * container image copies `applets/` alone, so `build-contract.ts` cannot
 * import core — and it is pinned to the same list below.
 */
import { describe, expect, test } from "bun:test";
import {
  BOT_ISOLATE_CONTEXT_KEYS_V1,
  BOT_ISOLATE_HOOK_EVENTS_V1,
  PLUGIN_GRANTS_V1,
  type BotIsolateHookEventNameV1,
  type PluginGrantV1,
} from "@frockbot/core/contracts";
import { PLUGIN_BUILD_HOOK_EVENTS_V1 } from "@frockbot/applets/build-contract";
import type {
  PluginContext,
  PluginGrant,
  PluginHookEvent,
  PluginHookPayloads,
  PluginHookReplacements,
} from "../../applets/sdk/plugin";

type BotIsolateContextKeyV1 = (typeof BOT_ISOLATE_CONTEXT_KEYS_V1)[number];

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Compiles only when the two unions name each other exactly. */
function exact<T extends true>(_assertion: T): void {}

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
});

describe("the Applet build contract", () => {
  test("serves exactly the kernel's hook events, in the kernel's order", () => {
    expect([...PLUGIN_BUILD_HOOK_EVENTS_V1]).toEqual([
      ...BOT_ISOLATE_HOOK_EVENTS_V1,
    ]);
  });
});
