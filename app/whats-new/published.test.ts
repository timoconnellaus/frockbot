import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WHATS_NEW_ENTRIES_V1 } from "./entries.ts";
import { whatsNewPublishedAtV1 } from "./feed.ts";
import { whatsNewEntryIdsOnDiskV1 } from "./generate.ts";
import {
  whatsNewIdsInSourceV1,
  whatsNewIdsInTreeV1,
  whatsNewPublishedDaysV1,
  whatsNewPublishedSourceV1,
} from "./published.ts";

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("What’s New ship dates", () => {
  test("reads every id the catalog declares from the tree", () => {
    const listing = whatsNewEntryIdsOnDiskV1()
      .map((id) => `app/whats-new/entries/${id}.ts`)
      .join("\n");
    expect(whatsNewIdsInTreeV1(`${listing}\n`).sort()).toEqual(
      WHATS_NEW_ENTRIES_V1.map((entry) => entry.id).sort(),
    );
  });

  test("still reads a tag cut before the entries moved into files", () => {
    const before = [
      "export const WHATS_NEW_ENTRIES_V1 = [",
      "  {",
      '    id: "group-chats",',
      '    title: "Group Chats",',
      "  },",
      "  {",
      '    id: "whats-new",',
      "  },",
      "];",
    ].join("\n");
    expect(whatsNewIdsInSourceV1(before)).toEqual(["group-chats", "whats-new"]);
  });

  test("an id ships with the earliest production tag that declares it", () => {
    const declared: Record<string, string[]> = {
      "v0.7.9": [],
      "v0.7.10": ["search"],
      "v0.7.11-rc.1": ["search", "voice"],
      "v0.7.12": ["search", "voice"],
    };
    expect(
      whatsNewPublishedDaysV1(
        ["voice", "search", "unshipped"],
        {
          "v0.7.9": "2026-09-10T02:00:00+00:00",
          "v0.7.10": "2026-09-20T23:30:00-02:00",
          "v0.7.11-rc.1": "2026-09-21T09:00:00+00:00",
          "v0.7.12": "2026-09-22T08:00:00+10:00",
        },
        (tag) => declared[tag] ?? [],
      ),
    ).toEqual({ voice: "2026-09-21", search: "2026-09-21" });
  });

  test("the repository keeps the ship dates empty; the tag deploy writes them", () => {
    expect(read("./published.generated.ts")).toBe(
      whatsNewPublishedSourceV1({}),
    );
    expect(whatsNewPublishedAtV1("whats-new")).toBeUndefined();
    expect(whatsNewPublishedAtV1("constructor")).toBeUndefined();
  });

  test("the production deploy dates entries on a full checkout before the Worker ships", () => {
    const workflow = Bun.YAML.parse(
      read("../../.github/workflows/release.yml"),
    ) as {
      jobs: {
        "deploy-backend": {
          steps: Array<{ name?: string; run?: string; with?: object }>;
        };
      };
    };
    const steps = workflow.jobs["deploy-backend"].steps;
    const names = steps.map((step) => step.name);
    expect(steps[0]?.with).toMatchObject({
      "fetch-depth": 0,
      "fetch-tags": true,
    });
    expect(
      steps.find((step) => step.name === "Date What’s New entries"),
    ).toMatchObject({ run: "bun app/whats-new/published.ts" });
    expect(names.indexOf("Date What’s New entries")).toBeGreaterThan(-1);
    expect(names.indexOf("Date What’s New entries")).toBeLessThan(
      names.indexOf("Deploy Worker"),
    );
  });
});
