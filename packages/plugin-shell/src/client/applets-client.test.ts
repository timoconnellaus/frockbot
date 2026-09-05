import { describe, expect, test } from "bun:test";
import {
  appletCanvasIsFirstReadV1,
  appletSourceFilesV1,
  appletViewerStillCurrentV1,
  appletSourceFingerprintV1,
  mostRecentlyChangedFileV1,
  readAppletList,
  readAppletSource,
  readFocusedAppletId,
  writeFocusedAppletId,
  type AppletsHostedRequest,
} from "./applets-client.js";
import { appletsAvailableV1, appletsBridgeStateV2 } from "./applets-state.js";
import type { FrockBotWebData } from "../shared.js";

const summary = {
  appletId: "u1abc.todo",
  displayName: "Todo",
  status: "published" as const,
  currentGenerationId: "generation-2",
  tools: ["add_todo"],
  createdAt: "2026-09-03T00:00:00.000Z",
};

/** A fake transport, so the client is proven without a backend on the branch. */
function transportOf(
  answers: Record<string, unknown>,
  recorded: Array<{ path: string; method?: string; body?: string }> = [],
): AppletsHostedRequest {
  return (path, method, body) => {
    recorded.push({
      path,
      ...(method ? { method } : {}),
      ...(body ? { body } : {}),
    });
    if (!(path in answers))
      return Promise.reject(new Error(`no route ${path}`));
    return Promise.resolve(answers[path]);
  };
}

describe("Applet routes", () => {
  test("reads the User's Applets through the strict decoder", async () => {
    const request = transportOf({
      "/api/applets": { schemaVersion: 1, applets: [summary] },
    });
    expect(await readAppletList(request)).toEqual([summary]);
  });

  test("refuses a list the decoder does not accept", () => {
    const request = transportOf({ "/api/applets": { applets: [summary] } });
    expect(readAppletList(request)).rejects.toThrow();
  });

  test("the focus write reads back what the backend recorded", async () => {
    const recorded: Array<{ path: string; method?: string; body?: string }> =
      [];
    const request = transportOf(
      { "/api/bots/bot-1/applets/focus": { appletId: "u1abc.todo" } },
      recorded,
    );
    // The click asked for one Applet; the answer is the one that was recorded.
    expect(await writeFocusedAppletId(request, "bot-1", "u1abc.other")).toBe(
      "u1abc.todo",
    );
    expect(recorded[0]).toEqual({
      path: "/api/bots/bot-1/applets/focus",
      method: "POST",
      body: JSON.stringify({ schemaVersion: 1, appletId: "u1abc.other" }),
    });
    expect(await readFocusedAppletId(request, "bot-1")).toBe("u1abc.todo");
  });

  test("no focus is a value, not a missing read", async () => {
    const request = transportOf({
      "/api/bots/bot-1/applets/focus": { appletId: null },
    });
    expect(await readFocusedAppletId(request, "bot-1")).toBeNull();
  });

  test("the source read is bot-scoped and decoded", async () => {
    const view = {
      appletId: "u1abc.todo",
      files: [
        {
          path: "server.ts",
          text: "export class A {}",
          generationId: "w-1",
          changedAt: "2026-09-03T00:01:00.000Z",
        },
      ],
      truncated: false,
    };
    const request = transportOf({
      "/api/bots/bot-1/applets/u1abc.todo/source": view,
    });
    expect(await readAppletSource(request, "bot-1", "u1abc.todo")).toEqual(
      view,
    );
  });

  test("the code view follows the most recently changed file", () => {
    expect(mostRecentlyChangedFileV1(undefined)).toBeUndefined();
    expect(
      mostRecentlyChangedFileV1({
        appletId: "u1abc.todo",
        truncated: false,
        files: [
          {
            path: "server.ts",
            text: "",
            generationId: "w-1",
            changedAt: "2026-09-03T00:01:00.000Z",
          },
          {
            path: "ui.tsx",
            text: "",
            generationId: "w-2",
            changedAt: "2026-09-03T00:05:00.000Z",
          },
        ],
      }),
    ).toBe("ui.tsx");
  });

  test("the source fingerprint is the same for a re-read of the same files", () => {
    // The canvas moves the User to the code when a Turn *writes* source. It
    // re-reads the source on every poll and gets a fresh view object each
    // time, so the identity that decides has to be the files themselves —
    // otherwise a Turn that only called an Applet's own tool throws the User
    // off the live Applet.
    const file = {
      path: "server.ts",
      text: "export default class {}",
      generationId: "w-1",
      changedAt: "2026-09-03T00:01:00.000Z",
    };
    const view = {
      appletId: "u1abc.todo",
      truncated: false,
      files: [file, { ...file, path: "ui.tsx", generationId: "w-2" }],
    };
    expect(appletSourceFingerprintV1(view)).toBe(
      appletSourceFingerprintV1(structuredClone(view)),
    );
    // Order is not a change either: two reads may sort the store differently.
    expect(
      appletSourceFingerprintV1({ ...view, files: view.files.toReversed() }),
    ).toBe(appletSourceFingerprintV1(view));
    expect(appletSourceFingerprintV1(undefined)).toBe("");
  });

  test("the source fingerprint changes when a Turn writes a file", () => {
    const view = {
      appletId: "u1abc.todo",
      truncated: false,
      files: [
        {
          path: "server.ts",
          text: "",
          generationId: "w-1",
          changedAt: "2026-09-03T00:01:00.000Z",
        },
      ],
    };
    expect(
      appletSourceFingerprintV1({
        ...view,
        files: [
          {
            ...view.files[0]!,
            generationId: "w-2",
            changedAt: "2026-09-03T00:02:00.000Z",
          },
        ],
      }),
    ).not.toBe(appletSourceFingerprintV1(view));
    // A new file is a write too.
    expect(
      appletSourceFingerprintV1({
        ...view,
        files: [...view.files, { ...view.files[0]!, path: "ui.tsx" }],
      }),
    ).not.toBe(appletSourceFingerprintV1(view));
  });
});

describe("the applets feed a page receives", () => {
  const web = {
    applets: [summary],
    focusedAppletId: "u1abc.todo",
    appletViewer: {
      appletId: "u1abc.todo",
      token: "signed",
      expiresAt: "2026-09-03T00:15:00.000Z",
      socketUrl: "wss://bot.example.com/api/applets/u1abc.todo/socket",
      uiUrl: "https://ui.example.com/packages/aa.html",
      generationId: "generation-2",
    },
    appletSource: undefined,
    appletBuild: undefined,
  } satisfies Pick<
    FrockBotWebData,
    | "applets"
    | "focusedAppletId"
    | "appletViewer"
    | "appletSource"
    | "appletBuild"
  >;

  test("carries the focused Applet, the list, and the viewer", () => {
    const state = appletsBridgeStateV2(web);
    expect(state.focused).toEqual(summary);
    expect(state.list).toEqual([summary]);
    expect(state.viewer?.generationId).toBe("generation-2");
    expect(state.viewer).not.toHaveProperty("expiresAt");
  });

  test("a viewer credential minted for another Applet is not handed over", () => {
    const state = appletsBridgeStateV2({
      ...web,
      focusedAppletId: "u1abc.other",
    });
    expect(state.viewer).toBeNull();
    expect(state.focused).toBeNull();
  });

  test("Applets are available only when a Package declares the focus tool", () => {
    const page = {
      id: "canvas",
      artifact: {
        contentHash: "a".repeat(64),
        size: 1,
        mediaType: "text/html" as const,
        bundlerVersion: "frockbot-inline-html@1",
      },
      mounts: [{ slot: "frockbot.right-panel" }],
    };
    const catalog = (declaredTools: string[]) => ({
      schemaVersion: 1 as const,
      botId: "bot-1",
      generationId: "generation-1",
      artifactOrigin: "https://ui.example.com",
      contributions: [
        {
          packageId: "applets",
          displayName: "Applets",
          provenance: "Bot-authored" as const,
          pages: [page],
          entries: [],
          declaredTools,
        },
      ],
    });
    // Derived from a manifest fact, never from a Package id: a deployment
    // without Applets asks for no Applet route at all.
    expect(appletsAvailableV1(catalog(["applet_focus"]))).toBe(true);
    expect(appletsAvailableV1(catalog(["weather_lookup"]))).toBe(false);
    expect(appletsAvailableV1(undefined)).toBe(false);
  });

  test("no focus is null rather than an absent field", () => {
    const state = appletsBridgeStateV2({ ...web, focusedAppletId: null });
    expect(state.focused).toBeNull();
    expect(state.viewer).toBeNull();
    expect(state.list).toEqual([summary]);
  });
});

describe("the Applet's own files", () => {
  const sourceWith = (paths: string[]) => ({
    appletId: "u1abc.todo",
    truncated: false,
    files: paths.map((path, index) => ({
      path,
      text: "{}",
      generationId: `w-${index}`,
      // The cache is the most recently written thing in the tree, which is
      // exactly why it used to win the "open on this" contest.
      changedAt: `2026-09-05T00:0${index}:00.000Z`,
    })),
  });

  test("leaves out build output, caches and dependency trees", () => {
    const source = sourceWith([
      "applet.json",
      "server.ts",
      ".wrangler/cache/cf.json",
      "node_modules/left-pad/index.js",
      "dist/manifest.json",
      ".frockbot-generations/server.ts.json",
    ]);
    expect(appletSourceFilesV1(source).map((file) => file.path)).toEqual([
      "applet.json",
      "server.ts",
    ]);
  });

  test("never opens on a cache file", () => {
    // The panel listed `.wrangler/cache/cf.json` first, selected it, and drew
    // one unwrapped line of minified JSON as the Applet (2026-09-05).
    expect(
      mostRecentlyChangedFileV1(
        sourceWith(["server.ts", ".wrangler/cache/cf.json"]),
      ),
    ).toBe("server.ts");
  });

  test("opens on the Applet's manifest when nothing has been written yet", () => {
    const scaffold = {
      appletId: "u1abc.todo",
      truncated: false,
      files: ["README.md", "applet.json"].map((path) => ({
        path,
        text: "",
        generationId: "w-1",
        changedAt: "2026-09-05T00:00:00.000Z",
      })),
    };
    expect(mostRecentlyChangedFileV1(scaffold)).toBe("applet.json");
  });

  test("a cache write does not change the source fingerprint", () => {
    // The fingerprint decides whether a Turn wrote source. A toolchain
    // rewriting its own cache is not the Bot writing code, and must not pull
    // the User off a live Applet.
    const before = appletSourceFingerprintV1(sourceWith(["server.ts"]));
    const after = appletSourceFingerprintV1(
      sourceWith(["server.ts", ".wrangler/cache/cf.json"]),
    );
    expect(after).toBe(before);
  });
});

describe("what a re-read of the Applet canvas does", () => {
  test("only the first read of an Applet draws a skeleton", () => {
    // The panel reset to four grey bars on every Turn: the cadence that
    // follows a running Turn re-read the source, and the re-read claimed the
    // loading state each time (2026-09-05).
    expect(appletCanvasIsFirstReadV1({ appletId: "u1abc.todo" })).toBe(true);
    expect(
      appletCanvasIsFirstReadV1({
        appletId: "u1abc.todo",
        sourceAppletId: "u1abc.todo",
      }),
    ).toBe(false);
    expect(
      appletCanvasIsFirstReadV1({
        appletId: "u1abc.todo",
        viewerAppletId: "u1abc.todo",
      }),
    ).toBe(false);
    // Focusing a different Applet is a first read again.
    expect(
      appletCanvasIsFirstReadV1({
        appletId: "u1abc.notes",
        viewerAppletId: "u1abc.todo",
        sourceAppletId: "u1abc.todo",
      }),
    ).toBe(true);
  });

  test("a running Applet is only reloaded when its generation changes", () => {
    const now = Date.parse("2026-09-05T00:00:00.000Z");
    const held = {
      appletId: "u1abc.todo",
      generationId: "generation-2",
      expiresAt: "2026-09-05T00:15:00.000Z",
    };
    const current = (
      overrides: Partial<Parameters<typeof appletViewerStillCurrentV1>[0]> = {},
    ) =>
      appletViewerStillCurrentV1({
        held,
        appletId: "u1abc.todo",
        generationId: "generation-2",
        now,
        ...overrides,
      });
    expect(current()).toBe(true);
    // A publish is the one thing that has to replace the frame.
    expect(current({ generationId: "generation-3" })).toBe(false);
    expect(current({ appletId: "u1abc.notes" })).toBe(false);
    expect(current({ held: undefined })).toBe(false);
    // A credential about to expire is renewed before it stops working.
    expect(current({ now: Date.parse("2026-09-05T00:13:00.000Z") })).toBe(
      false,
    );
  });
});
