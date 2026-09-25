import { expect, test } from "bun:test";
import type { PluginDescriptorV1 } from "@frockbot/core/contracts";
import {
  checkPluginAuthoringV1,
  lintPluginSourceV1,
  pluginCheckRationaleV1,
  pluginPartsV1,
  type PluginFitEvidenceV1,
} from "./authoring-check.js";

const base: PluginDescriptorV1 = {
  id: "tuner",
  displayName: "Tuner",
  version: "1.0.0",
  contractVersion: 4,
  tools: [{ name: "tune", description: "Tunes a string", inputSchema: {} }],
  hooks: [],
  grants: [],
  views: [
    {
      slot: "conversation.panel",
      surfaceId: "tuner",
      label: "Tuner",
      page: "pages/tuner.html",
    } as NonNullable<PluginDescriptorV1["views"]>[number],
  ],
  contextKeys: ["user", "bot", "session"],
};

const page = (html: string) => ({ path: "pages/tuner.html", text: html });

test("a page that writes colours out is told to use the theme variables", () => {
  const findings = lintPluginSourceV1(base, [
    page(
      '<style>body { color: #1a1a1a; background: rgb(255, 255, 255) }</style><p style="border-color: #ccc">',
    ),
  ]);
  expect(findings).toHaveLength(1);
  expect(findings[0]).toContain("#1a1a1a, rgb(255, 255, 255), #ccc");
  expect(findings[0]).toContain("--frockbot-*");
});

test("the theme's variables, with or without a fallback, are clean", () => {
  expect(
    lintPluginSourceV1(base, [
      page(
        "<style>body { color: var(--frockbot-text, #111); background: var(--frockbot-surface) }</style><script>document.querySelector('#ace')</script>",
      ),
    ]),
  ).toEqual([]);
});

test("a page that loads from the network is told the frame blocks it", () => {
  const findings = lintPluginSourceV1(base, [
    page('<script src="https://cdn.example.com/lib.js"></script>'),
  ]);
  expect(findings).toEqual([expect.stringContaining("loads from the network")]);
});

test("code reaching a host plugin.json does not declare is named", () => {
  const descriptor: PluginDescriptorV1 = {
    ...base,
    grants: ["http"],
    network: { hosts: ["api.example.com"] },
  };
  const findings = lintPluginSourceV1(descriptor, [
    {
      path: "plugin.ts",
      text: 'await fetch("https://api.example.com/a"); await fetch(`https://tracker.example.net/b`);',
    },
  ]);
  expect(findings).toEqual([expect.stringContaining("tracker.example.net")]);
  expect(findings[0]).not.toContain("api.example.com");
  // Open network access declares every host.
  expect(
    lintPluginSourceV1({ ...descriptor, network: { open: true } }, [
      { path: "plugin.ts", text: 'fetch("https://tracker.example.net")' },
    ]),
  ).toEqual([]);
});

test("the parts a judge is asked about are what the card lists", () => {
  expect(
    pluginPartsV1({
      ...base,
      hooks: ["agent/request"],
      grants: ["http", "memory"],
      network: { hosts: ["api.example.com"] },
    }).map((part) => part.label),
  ).toEqual([
    "tool tune: Tunes a string",
    "hook agent/request: sees and can change each model request",
    "grant memory",
    "network host api.example.com",
  ]);
});

test("a publish is checked by the judge, and the card says what it found", async () => {
  const seen: PluginFitEvidenceV1[] = [];
  const check = await checkPluginAuthoringV1({
    descriptor: { ...base, grants: ["memory"] },
    files: [
      { path: "plugin.json", text: "{}" },
      { path: "plugin.ts", text: "export const tools = [];" },
      page("<style>body{color:#000}</style>"),
    ],
    request: "Make me a guitar tuner.",
    purpose: "Tune a guitar by ear.",
    judge: {
      async judge(evidence) {
        seen.push(evidence);
        return {
          fits: "unclear",
          unneeded: evidence.parts.filter((part) => part.kind === "grant"),
        };
      },
    },
  });
  expect(seen[0]).toMatchObject({
    request: "Make me a guitar tuner.",
    purpose: "Tune a guitar by ear.",
    displayName: "Tuner",
  });
  // plugin.ts first; plugin.json is already the parts.
  expect(seen[0]?.code.startsWith("// plugin.ts\n")).toBe(true);
  expect(seen[0]?.code).not.toContain("plugin.json");
  expect(pluginCheckRationaleV1(check)).toBe(
    [
      "**Before you approve**",
      "- It is unclear whether it does what you asked for.",
      "- What you asked for gives no reason for: grant memory.",
      `- ${check.findings[0]}`,
    ].join("\n"),
  );
});

test("a clean Plugin that fits adds nothing to the card", async () => {
  const check = await checkPluginAuthoringV1({
    descriptor: base,
    files: [page("<style>body{color:var(--frockbot-text)}</style>")],
    request: "",
    purpose: "Tune a guitar.",
    judge: { judge: async () => ({ fits: "likely", unneeded: [] }) },
  });
  expect(pluginCheckRationaleV1(check)).toBeUndefined();
});
