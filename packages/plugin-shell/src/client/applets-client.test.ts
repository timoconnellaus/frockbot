import { describe, expect, test } from "bun:test";
import {
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
