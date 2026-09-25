import { describe, expect, test } from "bun:test";
import type {
  PluginBuildRequestV1,
  PluginBuildResponseV1,
} from "@frockbot/applets/build-contract";
import {
  decodePluginDescriptorV1,
  PLUGIN_PAGE_HELPER_JS_V1,
  servedPluginContractVersionsV1,
  type WorkspaceFilesV1,
  type WorkspacePathV1,
} from "@frockbot/core/contracts";
import type {
  CompositionGenerationV1,
  CompositionMemberV1,
} from "@frockbot/core/durable";
import {
  createPluginAuthoringHostV1,
  pluginManifestDisagreementV1,
  pluginScaffoldV1,
  type PluginAuthoringSeamsV1,
} from "./authoring.js";
import {
  decodePluginIntentRecordV1,
  pluginApprovalIdV1,
  pluginIntentKeyV1,
} from "./approval.js";
import {
  THEME_ASSEMBLE_DUE_KEY_V1,
  holdThemePickV1,
  themePickHoldsV1,
} from "@frockbot/app/theme/owed";
import { PLUGIN_ENABLEMENT_KEY_V1 } from "./enablement.js";
import { pluginsSourceRootV1 } from "./root.js";

const NOTES_PUBLISH = {
  pluginId: "notes",
  purpose: "Keep notes for the person.",
  request: "Make me a notes Plugin.",
};

const USER = "user-1";
const ROOT = pluginsSourceRootV1(USER);
const TURN = { sessionId: "user-1:bot-1", runId: "run-9", turnId: "run-9" };

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function workspaceFiles(seed: Record<string, string> = {}): WorkspaceFilesV1 {
  const files = new Map<string, { text: string; generationId: string }>();
  let minted = 0;
  for (const [path, text] of Object.entries(seed)) {
    minted += 1;
    files.set(path, { text, generationId: `g${minted}` });
  }
  const entryFor = (
    path: string,
    held: { text: string; generationId: string },
  ) => ({
    path: { root: ROOT, path } as WorkspacePathV1,
    generation: {
      schemaVersion: 1 as const,
      generationId: held.generationId,
      contentHash: "0".repeat(64),
      size: held.text.length,
      writer: { kind: "unattributed" as const },
      writtenAt: "2026-09-12T00:00:00.000Z",
    },
  });
  return {
    read: (path) => {
      const held = files.get(path.path);
      return Promise.resolve(
        held === undefined
          ? { status: "not-found" as const, reason: "no such file" }
          : {
              status: "ok" as const,
              file: {
                ...entryFor(path.path, held),
                bytes: new TextEncoder().encode(held.text),
              },
            },
      );
    },
    stat: (path) => {
      const held = files.get(path.path);
      return Promise.resolve(
        held === undefined
          ? { status: "not-found" as const, reason: "no such file" }
          : { status: "ok" as const, entry: entryFor(path.path, held) },
      );
    },
    list: (request) => {
      if (request.prefix?.endsWith("/")) {
        return Promise.resolve({
          status: "refused" as const,
          reason: "workspace path has an invalid segment",
        });
      }
      return Promise.resolve({
        status: "ok" as const,
        entries: [...files]
          .filter(([path]) => path.startsWith(request.prefix ?? ""))
          .map(([path, held]) => entryFor(path, held)),
      });
    },
    write: (request) => {
      const held = files.get(request.path.path);
      const seen = held?.generationId ?? null;
      if (seen !== request.expectedGenerationId) {
        return Promise.resolve({
          status: "conflict" as const,
          reason: "the file moved on",
        });
      }
      minted += 1;
      const generation = {
        schemaVersion: 1 as const,
        generationId: `g${minted}`,
        contentHash: "0".repeat(64),
        size: request.bytes.byteLength,
        writer: request.writer,
        writtenAt: "2026-09-12T00:00:00.000Z",
      };
      files.set(request.path.path, {
        text: new TextDecoder().decode(request.bytes),
        generationId: generation.generationId,
      });
      return Promise.resolve({ status: "ok" as const, generation });
    },
    delete: () =>
      Promise.resolve({ status: "not-found" as const, reason: "unused" }),
  };
}

const DESCRIPTOR_JSON = JSON.stringify({
  id: "notes",
  displayName: "Notes",
  version: "1",
  contractVersion: 4,
  tools: [
    { name: "note_count", description: "Count.", inputSchema: {} },
    { name: "note_add", description: "Add.", inputSchema: {} },
  ],
  hooks: [],
  grants: ["storage"],
  contextKeys: ["user", "bot", "session"],
});

const MODULE = "export const tools = [];\nexport const execute = () => 'x';\n";

/** A build service that answers with a real module and honest hashes. */
function buildsCleanly(
  calls: PluginBuildRequestV1[] = [],
  answer?: (request: PluginBuildRequestV1) => Promise<PluginBuildResponseV1>,
) {
  return {
    async build(request: PluginBuildRequestV1): Promise<PluginBuildResponseV1> {
      calls.push(request);
      if (answer) return answer(request);
      if (request.mode === "check") return { status: "built" };
      return {
        status: "built",
        manifest: {
          contract: 1,
          tools: [
            { name: "note_count", description: "Count.", inputSchema: {} },
            { name: "note_add", description: "Add.", inputSchema: {} },
          ],
          hooks: [],
          services: [],
          triggers: [],
          views: [],
          cards: [],
          modelProviders: [],
          modules: [],
          hashes: { module: await sha256Hex(MODULE) },
        },
        module: MODULE,
        modules: [],
      };
    },
  };
}

function generation(
  members: CompositionMemberV1[] = [],
): CompositionGenerationV1 {
  return {
    schemaVersion: 1,
    generationId: "gen-1",
    artifactSetHash: "b".repeat(64),
    createdAt: "2026-09-12T00:00:00.000Z",
    origin: { kind: "bootstrap" },
    members,
    status: "active",
  };
}

function harness(
  options: {
    source?: Record<string, string>;
    build?: ReturnType<typeof buildsCleanly>;
    members?: CompositionMemberV1[];
    catalog?: PluginAuthoringSeamsV1["catalog"];
    fitJudge?: PluginAuthoringSeamsV1["fitJudge"];
  } = {},
) {
  const storage = new Map<string, unknown>();
  const artifacts = new Map<string, string>();
  const settings = new Map<string, Record<string, unknown>>();
  const calls: PluginBuildRequestV1[] = [];
  const host = createPluginAuthoringHostV1({
    userId: USER,
    botId: "bot-1",
    turn: TURN,
    workspace: workspaceFiles(options.source),
    buildService: options.build ?? buildsCleanly(calls),
    artifacts: {
      putPackageArtifact: async (hash, module) => {
        artifacts.set(hash, module);
      },
      putPackageUiArtifact: async (hash, html) => {
        artifacts.set(hash, html);
      },
      putPluginModuleArtifact: async (hash, code) => {
        artifacts.set(hash, code);
      },
    },
    composition: { current: async () => generation(options.members) },
    moduleReports: async () => ({ entries: [], states: [] }),
    storage: {
      get: <T>(key: string) =>
        Promise.resolve(storage.get(key) as T | undefined),
      put: (key: string, value: unknown) => {
        storage.set(key, structuredClone(value));
        return Promise.resolve();
      },
      delete: (key: string) => Promise.resolve(storage.delete(key)),
    },
    settings: {
      read: async (pluginId) => settings.get(pluginId) ?? {},
      write: async (pluginId, values) => {
        settings.set(pluginId, values);
      },
    },
    catalog: options.catalog ?? [],
    ...(options.fitJudge ? { fitJudge: options.fitJudge } : {}),
    now: () => new Date("2026-09-12T01:00:00.000Z"),
  });
  return { host, storage, artifacts, settings, calls };
}

describe("creating a Plugin", () => {
  test("scaffolds the template under the Plugin's own directory", async () => {
    const { host } = harness();
    const created = await host.create({ displayName: "Weather Alerts!" });
    expect(created).toEqual({
      pluginId: "weather-alerts",
      files: ["plugin.json", "plugin.ts"],
    });
    const files = await host.files({ pluginId: "weather-alerts" });
    expect(files.map((file) => file.path)).toEqual([
      "plugin.json",
      "plugin.ts",
    ]);
    const descriptor = JSON.parse(
      await host.readFile({ pluginId: "weather-alerts", path: "plugin.json" }),
    ) as { id: string; displayName: string };
    expect(descriptor).toMatchObject({
      id: "weather-alerts",
      displayName: "Weather Alerts!",
    });
    // The scaffold is a real descriptor, not a placeholder.
    expect(() => decodePluginDescriptorV1(descriptor)).not.toThrow();
    expect(servedPluginContractVersionsV1()).toContain(
      decodePluginDescriptorV1(descriptor).contractVersion,
    );
  });

  test("refuses a built-in feature's name, a shipped Plugin's, and a taken one", async () => {
    const { host } = harness({
      catalog: [
        {
          pluginId: "audit-log",
          displayName: "Audit log",
          description: "Keeps a record.",
          seed: "locked",
          artifact: {
            contentHash: "c".repeat(64),
            size: 1,
            mediaType: "application/javascript",
            bundlerVersion: "seed",
          },
          descriptor: decodePluginDescriptorV1({
            ...JSON.parse(DESCRIPTOR_JSON),
            id: "audit-log",
          }),
        },
      ],
    });
    await expect(host.create({ displayName: "Web" })).rejects.toThrow(
      /built-in feature/,
    );
    await expect(host.create({ displayName: "Audit Log" })).rejects.toThrow(
      /shipped by this deployment/,
    );
    await host.create({ displayName: "Notes" });
    await expect(host.create({ displayName: "Notes" })).rejects.toThrow(
      /already has source/,
    );
  });

  test("the scaffold names the id and the display name", () => {
    const files = pluginScaffoldV1("notes", 'My "Notes"');
    expect(files.find((file) => file.path === "plugin.json")?.text).toContain(
      '"id": "notes"',
    );
    expect(files.find((file) => file.path === "plugin.ts")?.text).toContain(
      "My 'Notes'",
    );
  });
});

describe("checking and publishing", () => {
  const source = {
    "notes/plugin.json": DESCRIPTOR_JSON,
    "notes/plugin.ts": MODULE,
  };

  test("a check posts the source in check mode and answers in words", async () => {
    const { host, calls } = harness({ source });
    expect(await host.check({ pluginId: "notes" }, "tool:1:1:0")).toEqual({
      status: "checked",
      findings: [],
    });
    expect(calls[0]).toMatchObject({
      id: "notes",
      mode: "check",
      effectId: "tool:1:1:0",
    });
    expect(calls[0]?.files.map((file) => file.path)).toEqual([
      "plugin.json",
      "plugin.ts",
    ]);
  });

  test("a publish stores the artifact, writes the intent first, and asks", async () => {
    const { host, storage, artifacts } = harness({ source });
    const result = await host.publish(NOTES_PUBLISH, "tool:1:2:0");
    expect(result.status).toBe("pending-approval");
    if (result.status !== "pending-approval") return;
    const approvalId = await pluginApprovalIdV1(TURN.runId, "tool:1:2:0");
    expect(result.ask.approvalId).toBe(approvalId);
    expect(result.ask.replayed).toBe(false);
    expect(result.ask.risk).toBe("low");
    expect(result.ask.action).toContain('Run the Plugin "Notes"');
    expect([...artifacts.keys()]).toEqual([await sha256Hex(MODULE)]);
    const intent = decodePluginIntentRecordV1(
      storage.get(pluginIntentKeyV1(approvalId)),
    );
    expect(intent.action.kind).toBe("publish");
    if (intent.action.kind !== "publish") return;
    expect(intent.action.member).toMatchObject({
      packageId: "notes",
      version: "1",
      provenance: { kind: "bot", botId: "bot-1", runId: "run-9" },
      artifact: { contentHash: await sha256Hex(MODULE), size: MODULE.length },
    });
    // Nothing switched: the Plugin runs nowhere until the User answers.
    expect(storage.get(PLUGIN_ENABLEMENT_KEY_V1)).toBeUndefined();

    // The same effect asked again is the same card, sent nowhere twice.
    const again = await host.publish(NOTES_PUBLISH, "tool:1:2:0");
    expect(again.status === "pending-approval" && again.ask.replayed).toBe(
      true,
    );
  });

  test("a publish is checked against what was asked, once, and the card warns", async () => {
    const judged: string[] = [];
    const { host } = harness({
      source,
      fitJudge: {
        async judge(evidence) {
          judged.push(`${evidence.request} | ${evidence.purpose}`);
          return { fits: "unlikely", unneeded: [] };
        },
      },
    });
    const result = await host.publish(NOTES_PUBLISH, "tool:1:4:0");
    if (result.status !== "pending-approval") throw new Error(result.reason);
    expect(judged).toEqual([
      "Make me a notes Plugin. | Keep notes for the person.",
    ]);
    expect(result.ask.check).toBe(
      "**Before you approve**\n- It may not do what you asked for.",
    );
    expect(result.ask.rationale).toEndWith(`\n\n${result.ask.check}`);
    // A replayed publish is neither sent nor judged again.
    await host.publish(NOTES_PUBLISH, "tool:1:4:0");
    expect(judged).toHaveLength(1);
  });

  test("a descriptor that disagrees with the module is refused before anything is stored", async () => {
    const { host, storage, artifacts } = harness({
      source: {
        ...source,
        "notes/plugin.json": JSON.stringify({
          ...JSON.parse(DESCRIPTOR_JSON),
          tools: [{ name: "note_add", description: "Add.", inputSchema: {} }],
        }),
      },
    });
    const result = await host.publish(NOTES_PUBLISH, "tool:1:3:0");
    expect(result).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("plugin.json and plugin.ts disagree"),
    });
    expect(artifacts.size).toBe(0);
    expect(storage.size).toBe(0);
  });

  test("a descriptor naming another Plugin, or none, is refused", async () => {
    const other = harness({
      source: {
        ...source,
        "notes/plugin.json": JSON.stringify({
          ...JSON.parse(DESCRIPTOR_JSON),
          id: "weather",
        }),
      },
    });
    expect(
      await other.host.check({ pluginId: "notes" }, "tool:1:4:0"),
    ).toMatchObject({
      status: "failed",
      reason: expect.stringContaining('names "weather"'),
    });
    const none = harness({ source: { "notes/plugin.ts": MODULE } });
    expect(
      await none.host.check({ pluginId: "notes" }, "tool:1:5:0"),
    ).toMatchObject({ status: "failed", reason: "plugin.json is missing" });
  });

  test("a manifest whose hash lies about the module is refused", async () => {
    const { host, artifacts } = harness({
      source,
      build: buildsCleanly([], async () => ({
        status: "built",
        manifest: {
          contract: 1,
          tools: [
            { name: "note_count", description: "Count.", inputSchema: {} },
            { name: "note_add", description: "Add.", inputSchema: {} },
          ],
          hooks: [],
          services: [],
          triggers: [],
          views: [],
          cards: [],
          modelProviders: [],
          modules: [],
          hashes: { module: "f".repeat(64) },
        },
        module: MODULE,
        modules: [],
      })),
    });
    expect(await host.publish(NOTES_PUBLISH, "tool:1:6:0")).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("does not match the module"),
    });
    expect(artifacts.size).toBe(0);
  });

  test("build diagnostics come back line by line", async () => {
    const { host } = harness({
      source,
      build: buildsCleanly([], async () => ({
        status: "failed",
        stage: "typecheck",
        diagnostics: [
          {
            file: "plugin.ts",
            line: 3,
            column: 7,
            message: "Type 'number' is not assignable to type 'string'.",
            severity: "error",
          },
        ],
      })),
    });
    expect(await host.check({ pluginId: "notes" }, "tool:1:7:0")).toEqual({
      status: "failed",
      reason: "the build failed at the typecheck stage",
      diagnostics: [
        "plugin.ts:3:7 error: Type 'number' is not assignable to type 'string'.",
      ],
    });
  });

  test("without a build service, a check says so and nothing is stored", async () => {
    const storage = new Map<string, unknown>();
    const host = createPluginAuthoringHostV1({
      userId: USER,
      botId: "bot-1",
      turn: TURN,
      workspace: workspaceFiles(source),
      artifacts: {
        putPackageArtifact: async () => {},
        putPackageUiArtifact: async () => {},
        putPluginModuleArtifact: async () => {},
      },
      composition: { current: async () => generation() },
      moduleReports: async () => ({ entries: [], states: [] }),
      storage: {
        get: <T>(key: string) =>
          Promise.resolve(storage.get(key) as T | undefined),
        put: async (key, value) => {
          storage.set(key, value);
        },
        delete: async (key) => storage.delete(key),
      },
      settings: { read: async () => ({}), write: async () => {} },
      catalog: [],
    });
    expect(await host.publish(NOTES_PUBLISH, "tool:1:8:0")).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("build service is unavailable"),
    });
    expect(storage.size).toBe(0);
  });
});

describe("the manifest against the descriptor", () => {
  const descriptor = decodePluginDescriptorV1({
    ...JSON.parse(DESCRIPTOR_JSON),
    hooks: ["agent/request"],
    provides: [{ name: "lookup", version: 1 }],
    triggers: [{ name: "alert", description: "An alert." }],
  });
  const manifest = {
    contract: 1 as const,
    tools: [
      { name: "note_add", description: "Add.", inputSchema: {} },
      { name: "note_count", description: "Count.", inputSchema: {} },
    ],
    hooks: ["agent/request" as const],
    services: ["lookup"],
    triggers: ["alert"],
    views: [],
    cards: [],
    modelProviders: [],
    modules: [],
    hashes: { module: "a".repeat(64) },
  };

  test("order does not matter; a missing or extra name does", () => {
    expect(pluginManifestDisagreementV1(descriptor, manifest)).toBeUndefined();
    expect(
      pluginManifestDisagreementV1(descriptor, { ...manifest, hooks: [] }),
    ).toMatch(/declares hooks \[agent\/request\] but plugin.ts exports \[\]/);
    expect(
      pluginManifestDisagreementV1(descriptor, { ...manifest, services: [] }),
    ).toMatch(/provides \[lookup\]/);
    expect(
      pluginManifestDisagreementV1(descriptor, {
        ...manifest,
        triggers: ["alert", "other"],
      }),
    ).toMatch(/triggers \[alert\] but plugin.ts exports \[alert, other\]/);
    expect(
      pluginManifestDisagreementV1(descriptor, {
        ...manifest,
        views: ["weather.settings"],
      }),
    ).toMatch(
      /declares views \[\] but plugin.ts exports views \[weather.settings\]/,
    );
  });
});

describe("enabling, disabling and settings", () => {
  const member: CompositionMemberV1 = {
    packageId: "notes",
    version: "1",
    provenance: {
      kind: "bot",
      packageId: "notes",
      version: "1",
      botId: "bot-2",
      sessionId: "user-1:bot-2",
      turnId: "run-1",
      runId: "run-1",
      authoredAt: "2026-09-12T00:00:00.000Z",
    },
    artifact: {
      contentHash: "a".repeat(64),
      size: 10,
      mediaType: "application/javascript",
      bundlerVersion: "applet-build/plugin@1",
    },
    descriptor: decodePluginDescriptorV1({
      ...JSON.parse(DESCRIPTOR_JSON),
      settingsSchema: {
        type: "object",
        properties: { tone: { type: "string" } },
      },
    }),
  };

  test("a sibling Bot's Plugin is off here until asked for, and the ask is an intent", async () => {
    const { host, storage } = harness({ members: [member] });
    expect(await host.list()).toEqual([
      {
        pluginId: "notes",
        displayName: "Notes",
        version: "1",
        authored: true,
        on: false,
        locked: false,
      },
    ]);
    const asked = await host.enable({ pluginId: "notes" }, "tool:2:1:0");
    const approvalId = await pluginApprovalIdV1(TURN.runId, "tool:2:1:0");
    expect(asked).toMatchObject({
      status: "pending-approval",
      ask: { approvalId, replayed: false },
    });
    expect(
      decodePluginIntentRecordV1(storage.get(pluginIntentKeyV1(approvalId)))
        .action,
    ).toEqual({ kind: "enable", pluginId: "notes" });
    expect(
      await host.enable({ pluginId: "weather" }, "tool:2:2:0"),
    ).toMatchObject({ status: "refused" });
  });

  test("disabling is immediate; a locked Plugin cannot be", async () => {
    const { host, storage } = harness({ members: [member] });
    expect(await host.disable({ pluginId: "notes" })).toEqual({
      status: "off",
    });
    expect(storage.get(PLUGIN_ENABLEMENT_KEY_V1)).toMatchObject({
      enabled: { notes: false },
    });
    // The Plugin may have been wrapping the look: the Bot re-assembles now,
    // not at the next hour.
    expect(storage.get(THEME_ASSEMBLE_DUE_KEY_V1)).toBeLessThanOrEqual(
      Date.now(),
    );
    // Only a Plugin this Bot could run has a switch: an id nothing installed
    // and a first-party feature are both refused, so the map cannot grow past
    // what it can hold.
    expect(await host.disable({ pluginId: "weather" })).toMatchObject({
      status: "refused",
    });
    expect(await host.disable({ pluginId: "routines" })).toMatchObject({
      status: "refused",
    });
    expect(storage.get(PLUGIN_ENABLEMENT_KEY_V1)).toMatchObject({
      enabled: { notes: false },
    });
    const locked = harness({
      catalog: [
        {
          pluginId: "audit-log",
          displayName: "Audit log",
          description: "Keeps a record.",
          seed: "locked",
          artifact: member.artifact,
          descriptor: decodePluginDescriptorV1({
            ...JSON.parse(DESCRIPTOR_JSON),
            id: "audit-log",
          }),
        },
      ],
    });
    expect(await locked.host.disable({ pluginId: "audit-log" })).toMatchObject({
      status: "refused",
    });
  });

  test("settings follow the descriptor's schema", async () => {
    const { host, settings, storage } = harness({ members: [member] });
    expect(await host.readSettings({ pluginId: "notes" })).toEqual({
      schema: member.descriptor.settingsSchema,
      values: {},
    });
    expect(
      await host.writeSettings({ pluginId: "notes", values: { tone: "dry" } }),
    ).toEqual({ status: "written" });
    expect(settings.get("notes")).toEqual({ tone: "dry" });
    expect(
      await host.writeSettings({ pluginId: "weather", values: {} }),
    ).toMatchObject({ status: "refused" });
    expect(storage.has(THEME_ASSEMBLE_DUE_KEY_V1)).toBe(false);
  });

  test("setting a theme Plugin's settings ends the person's pick and re-assembles now", async () => {
    const theme: CompositionMemberV1 = {
      ...member,
      descriptor: decodePluginDescriptorV1({
        ...JSON.parse(DESCRIPTOR_JSON),
        hooks: ["theme/assemble"],
        settingsSchema: member.descriptor.settingsSchema,
      }),
    };
    const { host, storage } = harness({ members: [theme] });
    const view = {
      get: <T>(key: string) =>
        Promise.resolve(storage.get(key) as T | undefined),
      put: async (key: string, value: unknown) => {
        storage.set(key, value);
      },
    };
    await holdThemePickV1(view);
    expect(
      await host.writeSettings({ pluginId: "notes", values: { tone: "dry" } }),
    ).toEqual({ status: "written" });
    expect(await themePickHoldsV1(view)).toBe(false);
    expect(storage.get(THEME_ASSEMBLE_DUE_KEY_V1)).toBe(
      Date.parse("2026-09-12T01:00:00.000Z"),
    );
  });
});

describe("a Plugin with a page", () => {
  const PAGE =
    "<!doctype html><html><head><title>Tuner</title></head><body>tune</body></html>";
  const withPage = {
    "notes/plugin.json": JSON.stringify({
      ...JSON.parse(DESCRIPTOR_JSON),
      views: [
        { slot: "conversation.panel", surfaceId: "tuner", page: "tuner.html" },
      ],
    }),
    "notes/plugin.ts": MODULE,
    "notes/tuner.html": PAGE,
  };
  const buildsTheView = () =>
    buildsCleanly([], async (request) =>
      request.mode === "check"
        ? { status: "built" }
        : {
            status: "built",
            manifest: {
              contract: 1,
              tools: [
                { name: "note_count", description: "Count.", inputSchema: {} },
                { name: "note_add", description: "Add.", inputSchema: {} },
              ],
              hooks: [],
              services: [],
              triggers: [],
              views: ["tuner"],
              cards: [],
              modelProviders: [],
              modules: [],
              hashes: { module: await sha256Hex(MODULE) },
            },
            module: MODULE,
            modules: [],
          },
    );

  test("a publish stores the page with its bridge and names it on the member", async () => {
    const { host, storage, artifacts } = harness({
      source: withPage,
      build: buildsTheView(),
    });
    const result = await host.publish(NOTES_PUBLISH, "tool:9:1:0");
    expect(result.status).toBe("pending-approval");
    if (result.status !== "pending-approval") return;
    const stored = [...artifacts].find(([, text]) => text.includes("tune"));
    expect(stored).toBeDefined();
    const [hash, html] = stored!;
    // The bytes the hash names are the bytes that run, bridge first in <head>.
    expect(hash).toBe(await sha256Hex(html));
    expect(html).toBe(
      `<!doctype html><html><head><script>${PLUGIN_PAGE_HELPER_JS_V1}</script><title>Tuner</title></head><body>tune</body></html>`,
    );
    const intent = decodePluginIntentRecordV1(
      storage.get(pluginIntentKeyV1(result.ask.approvalId)),
    );
    if (intent.action.kind !== "publish") throw new Error("not a publish");
    expect(intent.action.member.pages).toEqual([
      {
        path: "tuner.html",
        contentHash: hash,
        size: new TextEncoder().encode(html).byteLength,
      },
    ]);
    // A page is the Plugin's code on the person's devices: the card says so.
    expect(result.ask.action).toContain("draws its own web page");
    expect(result.ask.risk).toBe("medium");
  });

  test("a check and a publish refuse a page the source does not have", async () => {
    const { ["notes/tuner.html"]: _page, ...missing } = withPage;
    const { host, artifacts, storage } = harness({
      source: missing,
      build: buildsTheView(),
    });
    expect(await host.check({ pluginId: "notes" }, "tool:9:2:0")).toMatchObject(
      {
        status: "failed",
        reason: expect.stringContaining('names the page "tuner.html"'),
      },
    );
    expect(await host.publish(NOTES_PUBLISH, "tool:9:3:0")).toMatchObject({
      status: "failed",
      reason: expect.stringContaining('names the page "tuner.html"'),
    });
    expect(artifacts.size).toBe(0);
    expect(storage.size).toBe(0);
  });
});

describe("a Plugin with a device module", () => {
  const CODE = "export const calls = { search: () => [] };\n";
  const withModule = {
    "notes/plugin.json": JSON.stringify({
      ...JSON.parse(DESCRIPTOR_JSON),
      grants: [...JSON.parse(DESCRIPTOR_JSON).grants, "device"],
      device: {
        abilities: [],
        modules: [
          {
            id: "bridge",
            platforms: ["macos"],
            read: [],
            net: ["localhost:23373"],
            appleEvents: [],
            calls: ["search"],
            events: [],
          },
        ],
      },
    }),
    "notes/plugin.ts": MODULE,
    "notes/modules/bridge.ts": CODE,
  };
  const buildsTheModule = (calls: string[], hash?: string) =>
    buildsCleanly([], async (request) =>
      request.mode === "check"
        ? { status: "built" }
        : {
            status: "built",
            manifest: {
              contract: 1,
              tools: [
                { name: "note_count", description: "Count.", inputSchema: {} },
                { name: "note_add", description: "Add.", inputSchema: {} },
              ],
              hooks: [],
              services: [],
              triggers: [],
              views: [],
              cards: [],
              modelProviders: [],
              modules: [
                { id: "bridge", calls, hash: hash ?? (await sha256Hex(CODE)) },
              ],
              hashes: { module: await sha256Hex(MODULE) },
            },
            module: MODULE,
            modules: [{ id: "bridge", code: CODE }],
          },
    );

  test("a publish stores the module and names it on the member", async () => {
    const { host, storage, artifacts } = harness({
      source: withModule,
      build: buildsTheModule(["search"]),
    });
    const result = await host.publish(NOTES_PUBLISH, "tool:9:1:0");
    if (result.status !== "pending-approval") {
      throw new Error(`expected an approval: ${JSON.stringify(result)}`);
    }
    const hash = await sha256Hex(CODE);
    expect(artifacts.get(hash)).toBe(CODE);
    const intent = decodePluginIntentRecordV1(
      storage.get(pluginIntentKeyV1(result.ask.approvalId)),
    );
    if (intent.action.kind !== "publish") throw new Error("not a publish");
    expect(intent.action.member.modules).toEqual([
      { id: "bridge", contentHash: hash, size: CODE.length },
    ]);
    // Code on the person's computer: the card names what it reaches there.
    expect(result.ask.action).toContain(
      "runs code on your computer while the FrockBot app is open that connects to localhost:23373",
    );
    expect(result.ask.risk).toBe("high");
  });

  test("refuses a module whose calls are not the ones it declares", async () => {
    const { host, artifacts } = harness({
      source: withModule,
      build: buildsTheModule(["search", "send"]),
    });
    const result = await host.publish(NOTES_PUBLISH, "tool:9:1:0");
    expect(result).toMatchObject({ status: "failed" });
    if (result.status === "failed") {
      expect(result.reason).toContain(
        "modules/bridge.ts exports calls [search, send]",
      );
    }
    expect(artifacts.size).toBe(0);
  });

  test("refuses a module whose code is not what the manifest hashed", async () => {
    const { host, artifacts } = harness({
      source: withModule,
      build: buildsTheModule(["search"], "d".repeat(64)),
    });
    const result = await host.publish(NOTES_PUBLISH, "tool:9:1:0");
    expect(result).toMatchObject({ status: "failed" });
    expect(artifacts.size).toBe(0);
  });
});
