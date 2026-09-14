import { describe, expect, test } from "bun:test";
import {
  appletImpactFingerprintV1,
  appletSourceArtefactPathV1,
  decodeBotAppletImpactViewV1,
  decodeAppletDirectoryEntryV1,
  decodeAppletGenerationSummaryV1,
  decodeAppletGenerationV1,
  decodeAppletPublishResultV1,
  decodeAppletBuildViewV1,
  decodeAppletListViewV1,
  decodeAppletOpenFocusV1,
  decodeAppletOpenViewV1,
  decodeAppletSourceViewV1,
  decodeAppletSummaryV1,
  decodeAppletUiViewV1,
  decodeAppletViewerTokenV1,
} from "./applets.js";

const tool = {
  name: "add_todo",
  description: "Add a todo",
  inputSchema: { type: "object" },
};

const server = {
  contentHash: "a".repeat(64),
  size: 128,
  mediaType: "application/javascript",
  bundlerVersion: "frockbot-esbuild@1",
};

const ui = {
  contentHash: "b".repeat(64),
  size: 64,
  mediaType: "text/html",
  bundlerVersion: "frockbot-inline-html@1",
};

describe("Applet directory entry v1", () => {
  const entry = {
    schemaVersion: 1,
    appletId: "u1abc.todo",
    displayName: "Todo",
    currentGenerationId: "generation-2",
    tools: [tool],
    provenance: {
      kind: "bot",
      botId: "bot-1",
      sessionId: "session-1",
      turnId: "turn-1",
    },
    createdAt: "2026-09-03T00:00:00.000Z",
    status: "published",
    ownerBotId: "bot-1",
    sharedWithBotIds: ["bot-2"],
    available: true,
  };

  test("round-trips the exact record", () => {
    expect(decodeAppletDirectoryEntryV1(entry)).toEqual(entry as never);
  });

  test("an entry names exactly one owner, apart from the Bots it is shared with", () => {
    // Written before Applets had an owner: there is none to infer, so the
    // record does not decode and the disposable cleanup removes it.
    const {
      ownerBotId: _owner,
      sharedWithBotIds: _shared,
      available: _available,
      ...legacy
    } = entry;
    expect(() => decodeAppletDirectoryEntryV1(legacy)).toThrow(
      "invalid fields",
    );
    expect(() =>
      decodeAppletDirectoryEntryV1({ ...entry, sharedWithBotIds: ["bot-1"] }),
    ).toThrow("names the owner");
    expect(() =>
      decodeAppletDirectoryEntryV1({
        ...entry,
        sharedWithBotIds: ["bot-2", "bot-2"],
      }),
    ).toThrow("duplicate Bots");
    expect(() =>
      decodeAppletDirectoryEntryV1({ ...entry, ownerBotId: "bot#task:1" }),
    ).toThrow("ownerBotId is invalid");
    expect(() =>
      decodeAppletDirectoryEntryV1({ ...entry, available: "yes" }),
    ).toThrow("available must be a boolean");
  });

  test("accepts a draft with no current generation and User provenance", () => {
    const { currentGenerationId: _unused, ...draft } = entry;
    const decoded = decodeAppletDirectoryEntryV1({
      ...draft,
      provenance: { kind: "user" },
      status: "draft",
    });
    expect(Object.hasOwn(decoded, "currentGenerationId")).toBe(false);
    expect(decoded.provenance).toEqual({ kind: "user" });
  });

  test("fails closed on an unknown field, id, status, or provenance", () => {
    expect(() =>
      decodeAppletDirectoryEntryV1({ ...entry, userId: "u1" }),
    ).toThrow("invalid fields");
    expect(() =>
      decodeAppletDirectoryEntryV1({ ...entry, appletId: "todo" }),
    ).toThrow("appletId is invalid");
    // The owner half is a real User id, which Better Auth mints in mixed case.
    expect(
      decodeAppletDirectoryEntryV1({
        ...entry,
        appletId: "vgpqfaCcwnPlzjYdb2mIfNcOW1YV0SkG.todo",
      }).appletId,
    ).toBe("vgpqfaCcwnPlzjYdb2mIfNcOW1YV0SkG.todo");
    expect(() =>
      decodeAppletDirectoryEntryV1({ ...entry, status: "archived" }),
    ).toThrow("status is invalid");
    expect(() =>
      decodeAppletDirectoryEntryV1({
        ...entry,
        provenance: { kind: "catalog" },
      }),
    ).toThrow("provenance.kind is invalid");
    expect(() =>
      decodeAppletDirectoryEntryV1({ ...entry, schemaVersion: 2 }),
    ).toThrow("schemaVersion is unsupported");
  });
});

describe("Applet generation v1", () => {
  const generation = {
    schemaVersion: 1,
    generationId: "generation-2",
    parentGenerationId: "generation-1",
    server,
    ui,
    tools: [tool],
    contract: 1,
    origin: "publish",
    provenance: {
      botId: "bot-1",
      sessionId: "session-1",
      turnId: "turn-1",
      runId: "run-1",
    },
    createdAt: "2026-09-03T00:00:00.000Z",
    status: "active",
  };

  test("round-trips the exact record", () => {
    expect(decodeAppletGenerationV1(generation)).toEqual(generation as never);
  });

  test("fails closed on the artifact shapes and the contract", () => {
    expect(() =>
      decodeAppletGenerationV1({ ...generation, contract: 2 }),
    ).toThrow("contract is unsupported");
    expect(() =>
      decodeAppletGenerationV1({
        ...generation,
        server: { ...server, mediaType: "text/html" },
      }),
    ).toThrow("server.mediaType is invalid");
    expect(() =>
      decodeAppletGenerationV1({
        ...generation,
        ui: { ...ui, size: 4 * 1024 * 1024 + 1 },
      }),
    ).toThrow("4 MB quota");
    expect(() =>
      decodeAppletGenerationV1({ ...generation, origin: "rollback" }),
    ).toThrow("origin is invalid");
    expect(() =>
      decodeAppletGenerationV1({ ...generation, tools: [tool, tool] }),
    ).toThrow("duplicate names");
  });
});

describe("Applet views and viewer tokens", () => {
  test("decodes a summary and a generation summary", () => {
    const summary = {
      appletId: "u1abc.todo",
      displayName: "Todo",
      status: "published",
      currentGenerationId: "generation-2",
      tools: ["add_todo"],
      createdAt: "2026-09-03T00:00:00.000Z",
      ownerBotId: "bot-1",
      access: "shared",
      sharedWithBotIds: [],
    };
    expect(decodeAppletSummaryV1(summary)).toEqual(summary as never);
    expect(() =>
      decodeAppletSummaryV1({ ...summary, access: "viewer" }),
    ).toThrow("access is invalid");
    const generationSummary = {
      generationId: "generation-2",
      parentGenerationId: "generation-1",
      origin: "revert",
      status: "superseded",
      tools: ["add_todo"],
      createdAt: "2026-09-03T00:00:00.000Z",
      isCurrent: false,
    };
    expect(decodeAppletGenerationSummaryV1(generationSummary)).toEqual(
      generationSummary as never,
    );
    expect(() =>
      decodeAppletGenerationSummaryV1({
        ...generationSummary,
        isCurrent: "no",
      }),
    ).toThrow("isCurrent must be a boolean");
  });

  test("decodes both publish outcomes and refuses a third", () => {
    expect(
      decodeAppletPublishResultV1({
        status: "published",
        appletId: "u1abc.todo",
        generationId: "generation-3",
        tools: ["add_todo"],
      }),
    ).toMatchObject({ status: "published", generationId: "generation-3" });
    expect(
      decodeAppletPublishResultV1({
        status: "failed",
        appletId: "u1abc.todo",
        generationId: "generation-3",
        reason: "health check failed",
        diagnostics: ["tool list did not match the declaration"],
      }),
    ).toMatchObject({ status: "failed" });
    expect(() =>
      decodeAppletPublishResultV1({
        status: "pending",
        appletId: "u1abc.todo",
      }),
    ).toThrow("status is invalid");
  });

  test("bounds a viewer token and its socket URL", () => {
    const token = {
      token: "signed.token.value",
      expiresAt: "2026-09-03T00:15:00.000Z",
      socketUrl: "wss://bot.frockbot.com/api/applets/u1abc.todo/socket",
    };
    expect(decodeAppletViewerTokenV1(token)).toEqual(token);
    expect(() =>
      decodeAppletViewerTokenV1({ ...token, socketUrl: "ftp://example.com" }),
    ).toThrow("socketUrl is invalid");
    expect(() => decodeAppletViewerTokenV1({ ...token, userId: "u1" })).toThrow(
      "invalid fields",
    );
    expect(() =>
      decodeAppletViewerTokenV1({ ...token, expiresAt: "soon" }),
    ).toThrow("ISO timestamp");
  });
});

describe("Applet canvas projections", () => {
  const summary = {
    appletId: "u1abc.todo",
    displayName: "Todo",
    status: "published" as const,
    currentGenerationId: "generation-2",
    tools: ["add_todo"],
    createdAt: "2026-09-03T00:00:00.000Z",
    ownerBotId: "bot-1",
    access: "owner" as const,
    sharedWithBotIds: ["bot-2"],
  };

  test("decodes the Applet list a canvas reads", () => {
    expect(
      decodeAppletListViewV1({ schemaVersion: 1, applets: [summary] }),
    ).toEqual({ schemaVersion: 1, applets: [summary] });
    expect(() =>
      decodeAppletListViewV1({ schemaVersion: 1, applets: [summary, summary] }),
    ).toThrow("duplicate Applets");
    expect(() =>
      decodeAppletListViewV1({ schemaVersion: 2, applets: [] }),
    ).toThrow("unsupported");
  });

  test("bounds the source read the building canvas draws", () => {
    const view = {
      appletId: "u1abc.todo",
      files: [
        {
          path: "src/server.ts",
          text: "export class TodoApplet {}",
          generationId: "w-1",
          changedAt: "2026-09-03T00:01:00.000Z",
        },
      ],
      truncated: false,
    };
    expect(decodeAppletSourceViewV1(view)).toEqual(view);
    expect(() =>
      decodeAppletSourceViewV1({
        ...view,
        files: [{ ...view.files[0]!, path: "../escape.ts" }],
      }),
    ).toThrow("path is invalid");
    expect(() =>
      decodeAppletSourceViewV1({
        ...view,
        files: [
          { path: "big.ts", text: "x".repeat(600 * 1024), generationId: "w-1" },
        ],
      }),
    ).toThrow("source read limit");
    expect(() =>
      decodeAppletSourceViewV1({
        ...view,
        files: [...view.files, ...view.files],
      }),
    ).toThrow("duplicate paths");
  });

  test("an unrecorded build outcome is unknown rather than a failure", () => {
    expect(decodeAppletBuildViewV1({ status: "unknown" })).toEqual({
      status: "unknown",
    });
    const failed = {
      status: "failed" as const,
      command: "check" as const,
      at: "2026-09-03T00:02:00.000Z",
      summary: "2 type errors",
      diagnostics: ["src/server.ts:3:1 - error TS2339"],
    };
    expect(decodeAppletBuildViewV1(failed)).toEqual(failed);
    expect(() => decodeAppletBuildViewV1({ status: "broken" })).toThrow(
      "status is invalid",
    );
  });

  test("the open route is the directory plus the focused viewer, or less", () => {
    const viewer = {
      appletId: summary.appletId,
      generationId: "generation-2",
      uiUrl: "https://ui.bot.frockbot.com/packages/aa.html",
      token: "signed.token",
      socketUrl: "wss://bot.frockbot.com/api/applets/u1abc.todo/socket",
      expiresAt: "2026-09-03T00:15:00.000Z",
    };
    const open = {
      schemaVersion: 1 as const,
      applets: [summary],
      focused: viewer,
    };
    expect(decodeAppletOpenViewV1(open)).toEqual(open);
    // Nothing focused: the canvas is closed, and the directory still lists.
    expect(decodeAppletOpenViewV1({ schemaVersion: 1, applets: [] })).toEqual({
      schemaVersion: 1,
      applets: [],
    });
    // Focused and unpublished: the building state is the id alone.
    const building = {
      schemaVersion: 1,
      applets: [
        { ...summary, status: "draft", currentGenerationId: undefined },
      ],
      focused: { appletId: summary.appletId },
    };
    expect(decodeAppletOpenViewV1(building).focused).toEqual({
      appletId: summary.appletId,
    });
    // Half a viewer is neither state.
    expect(() =>
      decodeAppletOpenFocusV1({ appletId: summary.appletId, token: "x" }),
    ).toThrow("invalid fields");
    // A focus the directory does not list is not an open Applet.
    expect(() =>
      decodeAppletOpenViewV1({
        schemaVersion: 1,
        applets: [],
        focused: viewer,
      }),
    ).toThrow("directory does not");
    expect(() =>
      decodeAppletOpenViewV1({
        ...open,
        focused: { ...viewer, socketUrl: "javascript:alert(1)" },
      }),
    ).toThrow("socketUrl is invalid");
    expect(() =>
      decodeAppletOpenViewV1({
        ...open,
        focused: { ...viewer, uiUrl: "ftp://ui.example/x" },
      }),
    ).toThrow("uiUrl is invalid");
  });

  test("the UI route names an http origin and a generation", () => {
    const ui = {
      uiUrl: "https://ui.bot.frockbot.com/packages/aa.html",
      generationId: "generation-2",
    };
    expect(decodeAppletUiViewV1(ui)).toEqual(ui);
    expect(() =>
      decodeAppletUiViewV1({ ...ui, uiUrl: "ftp://example.com/x" }),
    ).toThrow("uiUrl is invalid");
  });
});

describe("Bot Applet impact", () => {
  const applets = [
    {
      appletId: "u1abc.todo",
      displayName: "Todo",
      status: "published" as const,
      sharedWithBotIds: ["bot-2", "bot-3"],
    },
    {
      appletId: "u1abc.notes",
      displayName: "Notes",
      status: "draft" as const,
      sharedWithBotIds: [],
    },
  ];

  test("the fingerprint names which Applets and who shares them, in no order", () => {
    const fingerprint = appletImpactFingerprintV1(applets);
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(
      appletImpactFingerprintV1([
        applets[1]!,
        { ...applets[0]!, sharedWithBotIds: ["bot-3", "bot-2"] },
      ]),
    ).toBe(fingerprint);
    // A share gained, a share lost, an Applet more or fewer: a different set.
    expect(
      appletImpactFingerprintV1([
        applets[0]!,
        { ...applets[1]!, sharedWithBotIds: ["bot-2"] },
      ]),
    ).not.toBe(fingerprint);
    expect(appletImpactFingerprintV1([applets[0]!])).not.toBe(fingerprint);
    expect(appletImpactFingerprintV1([])).not.toBe(fingerprint);
    // The display name is not what a deletion destroys.
    expect(
      appletImpactFingerprintV1([
        { ...applets[0]!, displayName: "Renamed" },
        applets[1]!,
      ]),
    ).toBe(fingerprint);
  });

  test("decodes the confirmation's read exactly", () => {
    const view = {
      schemaVersion: 1,
      botId: "bot-1",
      fingerprint: appletImpactFingerprintV1(applets),
      applets,
    };
    expect(decodeBotAppletImpactViewV1(view)).toEqual(view as never);
    expect(() =>
      decodeBotAppletImpactViewV1({ ...view, fingerprint: "stale" }),
    ).toThrow("fingerprint is invalid");
    expect(() =>
      decodeBotAppletImpactViewV1({
        ...view,
        applets: [{ ...applets[0]!, status: "deleted" }],
      }),
    ).toThrow("status is invalid");
    expect(() =>
      decodeBotAppletImpactViewV1({ ...view, applets: [...applets, applets[0]] }),
    ).toThrow("duplicate Applets");
  });
});

describe("what counts as an Applet's source", () => {
  test("machine output is not source, at any depth", () => {
    for (const path of [
      "dist/manifest.json",
      ".wrangler/cache/cf.json",
      "node_modules/left-pad/index.js",
      ".frockbot-generations/server.ts.json",
      "packages/web/node_modules/x/index.js",
      "coverage/lcov.info",
    ]) {
      expect(appletSourceArtefactPathV1(path)).toBe(true);
    }
  });

  test("what the Bot wrote is", () => {
    for (const path of [
      "applet.json",
      "server.ts",
      "ui.tsx",
      "README.md",
      "src/todos.ts",
      // A file named after a build directory is still a file.
      "dist",
      "src/dist.ts",
    ]) {
      expect(appletSourceArtefactPathV1(path)).toBe(false);
    }
  });
});
