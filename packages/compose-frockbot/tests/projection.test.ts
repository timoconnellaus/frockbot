import { describe, expect, test } from "bun:test";
import {
  adaptFrockBotAuthorityV1,
  adaptFrockBotGenerationV1,
  adaptFrockBotManifestV1,
} from "../src/index.js";

const artifact = (content: string, mediaType = "application/javascript") => ({
  contentHash: content.repeat(64),
  size: 42,
  mediaType,
  bundlerVersion: "frockbot-esbuild@1",
});

function appletManifest() {
  return {
    schemaVersion: 5,
    id: "notes",
    displayName: "Notes",
    version: "1.2.3",
    compatibility: { frockbot: "*" },
    dependencies: {},
    contributions: {
      runtime: { entry: "./package.js", host: "bot-isolate" },
      client: {
        kind: "iframe",
        pages: [
          {
            id: "main",
            artifact: artifact("a", "text/html"),
            mounts: [{ slot: "frockbot.surface:main", order: 2 }],
          },
        ],
        entries: [
          {
            id: "open-notes",
            slot: "frockbot.sidebar-actions",
            label: "Notes",
            icon: "notes",
            opens: { kind: "surface", page: "main" },
          },
        ],
      },
      instance: {
        contract: 1,
        server: artifact("b"),
        ui: artifact("c", "text/html"),
        tools: [
          { name: "note_add", description: "Add a note", inputSchema: {} },
        ],
      },
    },
    tools: [{ name: "notes_list", description: "List notes", inputSchema: {} }],
    hooks: ["agent/pre-step"],
    permissions: ["notes:read"],
    configuration: {
      settings: [],
      connectionTypes: [
        {
          id: "notes-api",
          displayName: "Notes API",
          allowMultiple: false,
          authorization: { kind: "api-key", driverId: "api-key" },
          capabilities: ["notes"],
        },
      ],
      capabilities: [
        {
          id: "notes",
          kind: "tool",
          connectionTypes: ["notes-api"],
          admission: { turnTypes: ["chat"] },
        },
      ],
    },
  };
}

describe("adaptFrockBotManifestV1", () => {
  test("maps manifest kinds to slots, actions, keys, and structural grants", () => {
    const projected = adaptFrockBotManifestV1(appletManifest());

    expect(projected.slots).toEqual({
      declares: [],
      fills: [
        {
          slot: "frockbot.surface:main",
          order: 2,
          source: {
            kind: "sandboxed-iframe-page",
            pageId: "main",
            artifactHash: "a".repeat(64),
          },
        },
      ],
    });
    expect(
      projected.actions.map(({ kind, name, owner }) => [kind, name, owner]),
    ).toEqual([
      ["tool", "notes_list", "bot-isolate"],
      ["tool", "note_add", "applet-facet"],
      ["loop-hook", "agent/pre-step", "bot-isolate"],
      ["client-entry", "open-notes", "hosted-shell"],
    ]);
    expect(projected.keys).toEqual(
      expect.arrayContaining([
        {
          name: "botId",
          readonly: true,
          source: "turn-invocation",
        },
        {
          name: "packageId",
          readonly: true,
          source: "isolate-environment",
        },
        {
          name: "bindings",
          readonly: true,
          source: "isolate-environment",
        },
        {
          name: "schedule",
          readonly: true,
          source: "kernel-capability",
        },
      ]),
    );
    expect(projected.grants).toEqual([
      {
        name: "storage",
        kind: "applet-facet-storage",
        durableOwner: "applet-durable-object",
        scope: "declared-instance",
      },
      {
        name: "schedule",
        kind: "durable-command",
        durableOwner: "bot-durable-object",
        scope: "turn",
      },
    ]);
    expect(projected.execution).toEqual({
      compile: "outside-durable-objects",
      activate: "next-admitted-turn",
      runtime: "cloudflare-dynamic-worker",
      backend: [],
      instance: "cloudflare-applet-facet",
      ambientState: false,
      ambientTimers: false,
    });
    expect(projected.requirements.connectionTypes[0]).toEqual({
      id: "notes-api",
      authorization: "api-key",
      capabilities: ["notes"],
    });
  });

  test("maps a first-party module's outlets without inventing grants", () => {
    const projected = adaptFrockBotManifestV1({
      schemaVersion: 3,
      id: "shell-panel",
      displayName: "Shell panel",
      version: "1.0.0",
      compatibility: { frockbot: "*" },
      dependencies: {},
      contributions: {
        runtime: { entry: "./runtime" },
        client: {
          entry: "./client",
          outlets: ["frockbot.panel.body"],
          mounts: [{ slot: "frockbot.right-panel" }],
        },
      },
      permissions: [],
    });

    expect(projected.slots.declares).toEqual(["frockbot.panel.body"]);
    expect(projected.slots.fills[0]?.source).toEqual({
      kind: "first-party-client-module",
      entry: "./client",
    });
    expect(projected.keys).toEqual([]);
    expect(projected.grants).toEqual([]);
    expect(projected.execution.runtime).toBe("first-party-backend-runtime");
  });

  test("projects backend Contributions with their Durable Object hosts", () => {
    const projected = adaptFrockBotManifestV1({
      schemaVersion: 3,
      id: "records",
      displayName: "Records",
      version: "2.0.0",
      compatibility: { frockbot: "*" },
      dependencies: {},
      contributions: {
        backend: [
          { entry: "./server.js", host: "bot" },
          { entry: "./edge.js", host: "gateway" },
          { entry: "./user.js", host: "user" },
        ],
      },
      permissions: [],
    });

    expect(projected.execution.backend).toEqual([
      { entry: "./server.js", host: "bot" },
      { entry: "./edge.js", host: "gateway" },
      { entry: "./user.js", host: "user" },
    ]);
    expect(projected.execution.runtime).toBe("none");
    expect(projected.execution.instance).toBe("none");
    expect(projected.actions).toEqual([]);
    expect(projected.grants).toEqual([]);
  });

  test("uses the Package manifest decoder at the boundary", () => {
    expect(() =>
      adaptFrockBotManifestV1({ ...appletManifest(), surprise: true }),
    ).toThrow('unknown field "surprise"');
  });
});

describe("adaptFrockBotAuthorityV1", () => {
  test("projects only named, credential-free grants", () => {
    const projected = adaptFrockBotAuthorityV1({
      status: "available",
      connections: [
        {
          connectionId: "notes-1",
          packageId: "notes-provider",
          connectionTypeId: "notes-api",
          displayName: "Personal notes",
          generation: "generation-7",
          safeMetadata: { region: "au" },
        },
      ],
      model: {
        connectionId: "model-1",
        packageId: "model-provider",
        provider: "provider",
        providerModelId: "model-v1",
        connectionGeneration: "generation-2",
      },
      tools: true,
      memory: true,
      workspace: false,
      notify: true,
      schedule: true,
    });

    expect(projected.status).toBe("available");
    if (projected.status !== "available") throw new Error("unreachable");
    expect(projected.grants.map((grant) => grant.name)).toEqual([
      "tools",
      "applets",
      "notifications",
      "schedule",
      "model",
      "memory",
      "connection:notes-1",
    ]);
    expect(projected.grants).not.toContainEqual(
      expect.objectContaining({ credential: expect.anything() }),
    );
  });

  test("preserves an unavailable authority outcome without partial grants", () => {
    expect(
      adaptFrockBotAuthorityV1({
        status: "unavailable",
        reason: "connection revoked",
      }),
    ).toEqual({
      schemaVersion: 1,
      status: "unavailable",
      reason: "connection revoked",
      grants: [],
    });
  });
});

describe("adaptFrockBotGenerationV1", () => {
  const generation = (member: Record<string, unknown>) => ({
    schemaVersion: 1,
    generationId: "generation-8",
    artifactSetHash: "d".repeat(64),
    parentGenerationId: "generation-7",
    createdAt: "2026-09-05T00:00:00.000Z",
    origin: {
      kind: "revert",
      revertsTo: "generation-3",
      userId: "user-1",
    },
    members: [member],
    applets: [
      {
        kind: "applet",
        appletId: "notes:1",
        generationId: "applet-generation-2",
        tools: [],
        provenance: {
          kind: "user",
          packageId: "notes",
          version: "1.0.0",
          userId: "user-1",
          authoredAt: "2026-09-04T00:00:00.000Z",
        },
      },
    ],
    status: "pending",
  });

  test("keeps immutable artifacts and Applet storage under their hosts", () => {
    const projected = adaptFrockBotGenerationV1(
      generation({
        packageId: "notes",
        specifier: "@frockbot/notes",
        version: "1.0.0",
        manifestHash: "e".repeat(64),
        provenance: {
          kind: "bot",
          packageId: "notes",
          version: "1.0.0",
          botId: "bot-1",
          sessionId: "session-1",
          turnId: "turn-1",
          runId: "run-1",
          authoredAt: "2026-09-04T00:00:00.000Z",
        },
        artifact: artifact("f"),
      }),
    );

    expect(projected.packages[0]).toEqual(
      expect.objectContaining({
        host: "cloudflare-dynamic-worker",
        artifact: artifact("f"),
      }),
    );
    expect(projected.applets).toEqual([
      {
        appletId: "notes:1",
        generationId: "applet-generation-2",
        host: "cloudflare-applet-facet",
        storage: "applet-durable-object",
      },
    ]);
    expect(projected.revertsTo).toBe("generation-3");
    expect(projected.lifecycle).toEqual({
      compile: "outside-durable-objects",
      activate: "next-admitted-turn",
      immutableArtifacts: true,
      revertCreatesGeneration: true,
    });
  });

  test("fails closed for non-first-party code without an artifact", () => {
    expect(() =>
      adaptFrockBotGenerationV1(
        generation({
          packageId: "notes",
          specifier: "@frockbot/notes",
          version: "1.0.0",
          manifestHash: "e".repeat(64),
          provenance: {
            kind: "user",
            packageId: "notes",
            version: "1.0.0",
            userId: "user-1",
            authoredAt: "2026-09-04T00:00:00.000Z",
          },
        }),
      ),
    ).toThrow("non-first-party provenance without an immutable artifact");
  });
});
