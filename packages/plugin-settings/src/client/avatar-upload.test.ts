import { describe, expect, test } from "bun:test";
import { BOT_AVATAR_MAX_BYTES } from "@frockbot/configuration-core";
import {
  BOT_AVATAR_ACCEPT,
  botAvatarUrl,
  prepareAvatarUpload,
} from "./avatar-upload.js";

describe("avatar upload preparation", () => {
  test("encodes an accepted image for the upload command", () => {
    expect(
      prepareAvatarUpload({
        contentType: "image/png",
        bytes: new Uint8Array([0, 1, 2]),
      }),
    ).toEqual({ contentType: "image/png", bytes: "AAEC" });
  });

  test("refuses a type the backend would refuse, and says which", () => {
    expect(() =>
      prepareAvatarUpload({
        contentType: "application/pdf",
        bytes: new Uint8Array([1]),
      }),
    ).toThrow("Choose a PNG, JPEG, WebP, GIF, or SVG image");
    expect(BOT_AVATAR_ACCEPT).toContain("image/svg+xml");
  });

  test("refuses an empty file and one past the durable limit", () => {
    expect(() =>
      prepareAvatarUpload({
        contentType: "image/png",
        bytes: new Uint8Array(),
      }),
    ).toThrow("empty");
    expect(() =>
      prepareAvatarUpload({
        contentType: "image/png",
        bytes: new Uint8Array(BOT_AVATAR_MAX_BYTES + 1),
      }),
    ).toThrow("the limit is 5 MB");
  });

  test("addresses the served avatar by digest so a replacement is refetched", () => {
    expect(botAvatarUrl("my bot", "a".repeat(64))).toBe(
      `/api/bots/my%20bot/avatar?v=${"a".repeat(64)}`,
    );
  });
});
