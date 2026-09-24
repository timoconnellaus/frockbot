import { describe, expect, spyOn, test } from "bun:test";
import { isProtocolValue } from "@frockbot/core/protocol-schemas";
import type { CompositionMemberV1 } from "@frockbot/core/durable";
import {
  focusedPanelPageV1,
  panelDocumentIdV1,
  surfaceDocumentV1,
} from "./panels-bot.js";
import { pluginPageV1 } from "./views.js";

// The tree a Bot wrote for its first panel, which the wire used to refuse.
const helloPage = {
  root: {
    type: "group",
    orientation: "column",
    title: "Hello",
    children: [
      { type: "text", text: "Hello world", style: "heading" },
      { type: "text", text: "1 hello(s) kept.", style: "status" },
      {
        type: "group",
        orientation: "row",
        children: [
          {
            type: "action",
            actionId: "say_hello",
            label: "Say hello",
            style: "primary",
            input: { name: "World" },
          },
          {
            type: "action",
            actionId: "clear_greetings",
            label: "Clear",
            style: "secondary",
          },
        ],
      },
      {
        type: "list",
        rows: [
          { id: "hello-0", node: { type: "text", text: "1. Hello, World!" } },
        ],
      },
    ],
  },
};

function drawn(pluginId: string, surfaceId: string) {
  return pluginPageV1(
    { pluginId, surfaceId, tools: ["say_hello", "clear_greetings"] },
    { schemaVersion: 1, status: "rendered", document: helloPage },
  );
}

describe("a conversation panel's document", () => {
  test("reaches the client for a focused page and a nav door", () => {
    for (const kind of ["panel", "nav"] as const) {
      const id = panelDocumentIdV1(kind, "hello-panel", "hello");
      const { document, failure } = surfaceDocumentV1(
        id,
        drawn("hello-panel", "hello"),
        Date.parse("2026-09-23T06:14:30.000Z"),
      );
      expect(failure).toBeUndefined();
      expect(document?.surfaceId).toBe(id);
      expect(document?.root.type).toBe("group");
    }
  });

  test("still reaches the client at the longest ids a descriptor allows", () => {
    const pluginId = `p${"a".repeat(63)}`;
    const surfaceId = `s${"b".repeat(127)}`;
    const id = panelDocumentIdV1("panel", pluginId, surfaceId);
    expect(id.length).toBe(128);
    const { document } = surfaceDocumentV1(id, drawn(pluginId, surfaceId), 1);
    expect(document?.surfaceId).toBe(id);
  });

  test("is that surface's failure, and logged, when the wire refuses it", () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { document, failure } = surfaceDocumentV1(
        "panel.hello-panel.hello",
        { surfaceId: "hello", nodes: 1, root: { type: "text", text: "" } },
        1,
      );
      expect(document).toBeUndefined();
      expect(failure).toBe("This plugin's view could not be shown.");
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });

  test("carries a dropped Plugin's longest reason within the wire's cap", () => {
    const dropped = pluginPageV1(
      { pluginId: "hello-panel", surfaceId: "hello", tools: [] },
      { schemaVersion: 1, status: "drop", reason: "x".repeat(500) },
    );
    const { failure } = surfaceDocumentV1(
      panelDocumentIdV1("panel", "hello-panel", "hello"),
      dropped,
      1,
    );
    expect(dropped.failure!.length).toBeGreaterThan(500);
    expect(
      isProtocolValue("PanelDoor", {
        pluginId: "hello-panel",
        label: "Hello",
        failure,
      }),
    ).toBe(true);
  });
});

describe("a conversation panel that is a page", () => {
  const PAGE_HASH = "b".repeat(64);
  const tuner = {
    packageId: "tuner",
    version: "1",
    descriptor: {
      id: "tuner",
      displayName: "Tuner",
      version: "1",
      contractVersion: 7,
      tools: [],
      hooks: [],
      grants: [],
      contextKeys: ["user", "bot", "session"],
      views: [
        { slot: "conversation.panel", surfaceId: "tuner", page: "tuner.html" },
        { slot: "conversation.panel", surfaceId: "notes", label: "Notes" },
      ],
    },
    pages: [{ path: "tuner.html", contentHash: PAGE_HASH, size: 10 }],
  } as unknown as CompositionMemberV1;
  const roster = {
    generationId: "gen-1",
    members: [tuner],
    enabled: ["tuner"],
  };
  const focused = { pluginId: "tuner", surfaceId: "tuner" };
  const rendered = {
    schemaVersion: 1 as const,
    status: "rendered" as const,
    document: { a4: 440 },
  };

  test("reaches the client as the page's URL and its state", () => {
    const answer = focusedPanelPageV1(
      roster,
      focused,
      rendered,
      "https://bot.example.com",
    );
    expect(answer).toEqual({
      page: {
        url: `https://bot.example.com/plugin-pages/${PAGE_HASH}.html`,
        state: { a4: 440 },
      },
    });
    expect(
      isProtocolValue("PanelOpenView", {
        schemaVersion: 1,
        bag: [],
        focus: focused,
        page: answer?.page,
        doors: [],
      }),
    ).toBe(true);
  });

  test("names the device abilities the User approved for it, and no others", () => {
    const hearing = {
      ...tuner,
      descriptor: {
        ...tuner.descriptor,
        grants: ["device"],
        device: { abilities: ["microphone"] },
      },
    } as unknown as CompositionMemberV1;
    expect(
      focusedPanelPageV1(
        { ...roster, members: [hearing] },
        focused,
        rendered,
        "https://bot.example.com",
      )?.page?.abilities,
    ).toEqual(["microphone"]);
    expect(
      focusedPanelPageV1(roster, focused, rendered, "https://bot.example.com")
        ?.page,
    ).not.toHaveProperty("abilities");
  });

  test("is not a page when the focused view names none", () => {
    expect(
      focusedPanelPageV1(
        roster,
        { pluginId: "tuner", surfaceId: "notes" },
        rendered,
        "https://bot.example.com",
      ),
    ).toBeUndefined();
  });

  test("says why in words when it cannot be shown", () => {
    expect(
      focusedPanelPageV1(
        roster,
        focused,
        { schemaVersion: 1, status: "drop", reason: "state unreadable" },
        "https://bot.example.com",
      ),
    ).toEqual({
      failure: "This plugin could not show its page: state unreadable",
    });
    expect(
      focusedPanelPageV1(
        roster,
        focused,
        {
          schemaVersion: 1,
          status: "rendered",
          document: { big: "x".repeat(70_000) },
        },
        "https://bot.example.com",
      )?.failure,
    ).toContain("larger than");
    expect(
      focusedPanelPageV1(
        { ...roster, members: [{ ...tuner, pages: undefined }] },
        focused,
        rendered,
        "https://bot.example.com",
      ),
    ).toEqual({ failure: "This plugin's page was not published." });
  });
});
