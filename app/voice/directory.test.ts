import { describe, expect, test } from "bun:test";
import type { BotDirectoryViewV1 } from "@frockbot/app/flock/shared";
import {
  listDirectoryActivityV1,
  projectOpeningDirectoryV1,
} from "./directory.js";

function directory(): BotDirectoryViewV1 {
  return {
    schemaVersion: 1,
    revision: 3,
    bots: [
      {
        schemaVersion: 1,
        botId: "alpha",
        registeredAt: "2026-09-22T00:00:00.000Z",
        initialName: "Seed",
        avatar: { schemaVersion: 1, characterId: "pixel", primary: "#fc85ae" },
        currentProfile: {
          name: "Atlas",
          description: "Selected",
          sourceRevision: 4,
        },
      },
      {
        schemaVersion: 1,
        botId: "beta",
        registeredAt: "2026-09-22T00:00:00.000Z",
        initialName: "Beta seed",
        initialDescription: "From creation",
        avatar: { schemaVersion: 1, characterId: "pixel", primary: "#fc85ae" },
      },
      {
        schemaVersion: 1,
        botId: "gamma",
        registeredAt: "2026-09-22T00:00:00.000Z",
        initialName: "Gamma seed",
        avatar: { schemaVersion: 1, characterId: "pixel", primary: "#fc85ae" },
        currentProfile: { name: "Gamma", sourceRevision: 1 },
      },
    ],
  };
}

describe("voice directory projection", () => {
  test("opening uses the admitted directory and omits unknown activity", () => {
    const opening = projectOpeningDirectoryV1({
      directory: directory(),
      target: {
        botId: "alpha",
        name: "Atlas live",
        description: "Authoritative",
      },
    });
    expect(opening).toEqual([
      { botId: "alpha", name: "Atlas live", description: "Authoritative" },
      { botId: "beta", name: "Beta seed", description: "From creation" },
      { botId: "gamma", name: "Gamma" },
    ]);
    expect(opening.every((bot) => bot.activity === undefined)).toBe(true);
  });

  test("list_bots reports live activity in directory order with bounded concurrency", async () => {
    const bots = projectOpeningDirectoryV1({
      directory: directory(),
      target: { botId: "", name: "" },
    });
    let inFlight = 0;
    let peak = 0;
    const listed = await listDirectoryActivityV1(
      bots,
      async (botId) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        if (botId === "beta") throw new Error("unread");
        if (botId === "gamma") return [{ status: "running" }];
        return [{ status: "completed" }];
      },
      2,
    );
    expect(peak).toBeLessThanOrEqual(2);
    expect(listed.map((bot) => bot.botId)).toEqual(["alpha", "beta", "gamma"]);
    expect(listed[0]).toMatchObject({ name: "Atlas", activity: "idle" });
    expect(listed[1]).toEqual({
      botId: "beta",
      name: "Beta seed",
      description: "From creation",
    });
    expect(listed[1]).not.toHaveProperty("activity");
    expect(listed[2]).toMatchObject({ name: "Gamma", activity: "working" });
  });
});
