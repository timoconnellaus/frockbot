import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { computerBotPathKeyV1 } from "@frockbot/computer/core";
import { computerBotKey } from "@frockbot/computer/fly/computer";
import { flySpriteNameForComputer } from "@frockbot/computer/fly";
import {
  computerSpriteNameSourceV1,
  computerSpriteNameV1,
} from "@frockbot/computer/fly/runtime";
import { computerBotKeyV1 } from "./computer.js";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

describe("Computer tenant directory keys", () => {
  test("all consumers preserve the same durable path for accepted identities", () => {
    for (const botId of [
      "General",
      "general",
      "../../Health 🩺",
      " Crème brûlée ",
      "🤖",
    ]) {
      const core = computerBotPathKeyV1(botId);
      expect(computerBotKey(botId)).toBe(core);
      expect(computerBotKeyV1(botId, digest)).toBe(core);
      expect(core).toMatch(/^[a-z0-9-]+-[a-f0-9]{12}$/);
      expect(core).not.toContain("..");
      expect(core).not.toContain("/");
    }
    expect(computerBotPathKeyV1("General")).not.toBe(
      computerBotPathKeyV1("general"),
    );
    expect(computerBotPathKeyV1("é")).not.toBe(computerBotPathKeyV1("e"));
    expect(computerBotPathKeyV1("General")).toBe("general-c910d474dcd7");
  });

  test("rejects empty or overlong identities and malformed digests", () => {
    for (const botId of ["", "   ", "x".repeat(201)]) {
      expect(() => computerBotPathKeyV1(botId)).toThrow("1-200 characters");
      expect(() => computerBotKey(botId)).toThrow("1-200 characters");
      expect(() => computerBotKeyV1(botId, digest)).toThrow("1-200 characters");
    }
    expect(() => computerBotKeyV1("bot", () => "0".repeat(11))).toThrow(
      "SHA-256 hex digest",
    );
  });

  test("the provider and host share one namespaced User storage name", () => {
    for (const userId of ["user-1", " User.Mixed_2 "]) {
      const normalized = userId.trim();
      const host = computerSpriteNameV1(
        normalized,
        digest(computerSpriteNameSourceV1(normalized)),
        "frockbot-test",
      );
      expect(flySpriteNameForComputer({ userId }, "frockbot-test")).toBe(host);
      expect(host).toMatch(/^frockbot-test-[a-f0-9]{12}$/);
    }
    expect(
      flySpriteNameForComputer({ userId: "user-1" }, "frockbot-test"),
    ).not.toBe(flySpriteNameForComputer({ userId: "user-2" }, "frockbot-test"));
    expect(
      flySpriteNameForComputer({ userId: "user-1" }, "frockbot-test"),
    ).toBe("frockbot-test-6d3f5b6befa5");

    for (const userId of ["", "   ", "x".repeat(201)]) {
      expect(() => computerSpriteNameSourceV1(userId)).toThrow(
        "1-200 characters",
      );
      expect(() =>
        flySpriteNameForComputer({ userId }, "frockbot-test"),
      ).toThrow("1-200 characters");
    }
    expect(() =>
      computerSpriteNameV1("user-1", "not-a-digest", "frockbot"),
    ).toThrow("SHA-256 hex digest");
  });
});
