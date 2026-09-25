import { describe, expect, test } from "bun:test";
import type { CompositionMemberV1 } from "@frockbot/core/durable";
import {
  decodePluginPageReportCommandV1,
  MAX_PLUGIN_PAGE_REPORTS_V1,
  pluginPageReportsTextV1,
  readPluginPageReportsV1,
  recordPluginPageReportV1,
} from "./page-reports.js";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  async get(key: string): Promise<unknown> {
    return structuredClone(this.values.get(key));
  }
  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
}

function tunerAt(version: string): CompositionMemberV1 {
  return {
    packageId: "tuner",
    version,
    descriptor: {
      id: "tuner",
      displayName: "Tuner",
      version,
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
  } as unknown as CompositionMemberV1;
}

const roster = (version: string) => ({
  generationId: "gen-1",
  members: [tunerAt(version)],
  enabled: [],
});

const report = {
  pluginId: "tuner",
  surfaceId: "tuner",
  device: "macos",
  level: "log" as const,
  text: "input peaks at 0.004",
};

describe("what a Plugin's pages report", () => {
  test("is decoded exactly", () => {
    expect(
      decodePluginPageReportCommandV1({ schemaVersion: 1, ...report }),
    ).toEqual(report);
    for (const bad of [
      { ...report },
      { schemaVersion: 2, ...report },
      { schemaVersion: 1, ...report, level: "warn" },
      { schemaVersion: 1, ...report, text: "" },
      { schemaVersion: 1, ...report, text: "x".repeat(501) },
      { schemaVersion: 1, ...report, device: "Mac OS" },
      { schemaVersion: 1, ...report, at: "2026-09-25T00:00:00.000Z" },
    ]) {
      expect(() => decodePluginPageReportCommandV1(bad)).toThrow();
    }
  });

  test("is kept for a page of the Plugin, even one switched off, and stamped by the Bot", async () => {
    const storage = new MemoryStorage();
    const at = new Date("2026-09-25T02:10:03.000Z");
    expect(
      await recordPluginPageReportV1(storage, roster("2"), report, at),
    ).toEqual({ status: "recorded" });
    expect(await readPluginPageReportsV1(storage, "tuner")).toEqual([
      {
        at: at.toISOString(),
        surfaceId: "tuner",
        device: "macos",
        level: "log",
        text: "input peaks at 0.004",
        version: "2",
      },
    ]);
  });

  test("is refused for a surface that is not a page, or a Plugin not held", async () => {
    const storage = new MemoryStorage();
    const now = new Date();
    expect(
      await recordPluginPageReportV1(
        storage,
        roster("1"),
        { ...report, surfaceId: "notes" },
        now,
      ),
    ).toEqual({ status: "refused", reason: '"tuner" has no page "notes".' });
    expect(
      await recordPluginPageReportV1(
        storage,
        roster("1"),
        { ...report, pluginId: "stranger" },
        now,
      ),
    ).toMatchObject({ status: "refused" });
    expect(storage.values.size).toBe(0);
  });

  test("keeps the newest, up to the bound", async () => {
    const storage = new MemoryStorage();
    for (let index = 0; index < MAX_PLUGIN_PAGE_REPORTS_V1 + 5; index += 1) {
      await recordPluginPageReportV1(
        storage,
        roster("1"),
        { ...report, text: `reading ${index}` },
        new Date(Date.UTC(2026, 8, 25, 0, 0, index)),
      );
    }
    const kept = await readPluginPageReportsV1(storage, "tuner");
    expect(kept).toHaveLength(MAX_PLUGIN_PAGE_REPORTS_V1);
    expect(kept[0]?.text).toBe(`reading ${MAX_PLUGIN_PAGE_REPORTS_V1 + 4}`);
    expect(kept.at(-1)?.text).toBe("reading 5");
  });

  test("reads back to the Bot newest first, marking an older version", async () => {
    const storage = new MemoryStorage();
    await recordPluginPageReportV1(
      storage,
      roster("1"),
      { ...report, level: "error", text: "TypeError: a4 is undefined" },
      new Date("2026-09-25T01:00:00.000Z"),
    );
    await recordPluginPageReportV1(
      storage,
      roster("2"),
      report,
      new Date("2026-09-25T02:00:00.000Z"),
    );
    expect(
      pluginPageReportsTextV1(
        "tuner",
        await readPluginPageReportsV1(storage, "tuner"),
        "2",
      ),
    ).toBe(
      [
        "2 report(s) from tuner's pages, newest first:",
        "2026-09-25T02:00:00.000Z log (tuner on macos): input peaks at 0.004",
        "2026-09-25T01:00:00.000Z error (tuner on macos, version 1, before the current one): TypeError: a4 is undefined",
      ].join("\n"),
    );
    expect(pluginPageReportsTextV1("tuner", [], "2")).toContain(
      "reported nothing",
    );
  });
});
