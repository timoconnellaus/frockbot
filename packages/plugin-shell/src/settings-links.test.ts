import { describe, expect, test } from "bun:test";
import {
  decodeSettingsLinkV1,
  renderSettingsLinkV1,
  settingsAnchorV1,
  settingsLinkV1,
  SETTINGS_ANCHORS_V1,
} from "./settings-links.js";

describe("settings link scheme", () => {
  test("renders a Bot row link carrying the Bot, the surface and the anchor", () => {
    expect(settingsLinkV1({ anchor: "bot-name", botId: "alpha" })).toBe(
      "/?bot=alpha&settings=bot-settings#bot-name",
    );
  });

  test("omits the Bot from a User row even when one is selected", () => {
    expect(
      settingsLinkV1({ anchor: "user-default-model", botId: "alpha" }),
    ).toBe("/?settings=user-settings#user-default-model");
  });

  test("renders against an origin when one is supplied", () => {
    expect(
      settingsLinkV1({
        anchor: "bot-model",
        botId: "alpha",
        origin: "https://app.example/",
      }),
    ).toBe("https://app.example/?bot=alpha&settings=bot-settings#bot-model");
  });

  test("refuses an anchor this build does not ship", () => {
    expect(() => settingsLinkV1({ anchor: "invented" })).toThrow(
      "unknown settings anchor: invented",
    );
  });

  test("renders a Markdown citation a payload can carry verbatim", () => {
    expect(
      renderSettingsLinkV1({ anchor: "bot-capabilities", botId: "alpha" }),
    ).toBe(
      "[Capability Assignments](/?bot=alpha&settings=bot-settings#bot-capabilities)",
    );
  });

  test("decodes an absolute link back to its surface, anchor and Bot", () => {
    expect(
      decodeSettingsLinkV1(
        "https://app.example/?bot=alpha&settings=bot-info#bot-info-computer",
      ),
    ).toEqual({
      surface: "bot-info",
      anchor: "bot-info-computer",
      botId: "alpha",
    });
  });

  test("decodes the relative form a location carries", () => {
    expect(decodeSettingsLinkV1("/?settings=plugins#user-packages")).toEqual({
      surface: "plugins",
      anchor: "user-packages",
    });
  });

  test("decodes a surface with no row", () => {
    expect(decodeSettingsLinkV1("/?bot=alpha&settings=bot-settings")).toEqual({
      surface: "bot-settings",
      botId: "alpha",
    });
  });

  test("drops a fragment belonging to another surface", () => {
    expect(
      decodeSettingsLinkV1("/?settings=bot-settings#bot-info-channels"),
    ).toEqual({ surface: "bot-settings" });
  });

  test("drops an anchor nobody registered", () => {
    expect(decodeSettingsLinkV1("/?settings=bot-settings#invented")).toEqual({
      surface: "bot-settings",
    });
  });

  test("refuses a URL naming no surface", () => {
    expect(decodeSettingsLinkV1("/?bot=alpha#bot-name")).toBeUndefined();
    expect(decodeSettingsLinkV1("/?settings=nowhere#bot-name")).toBeUndefined();
    expect(decodeSettingsLinkV1("not a url at all")).toBeUndefined();
  });

  test("every anchor round-trips through its own link", () => {
    for (const entry of SETTINGS_ANCHORS_V1) {
      const decoded = decodeSettingsLinkV1(
        settingsLinkV1({ anchor: entry.anchor, botId: "alpha" }),
      );
      expect(decoded?.surface).toBe(entry.surface);
      expect(decoded?.anchor).toBe(entry.anchor);
      expect(settingsAnchorV1(entry.anchor)).toBe(entry);
    }
  });

  test("anchors are unique", () => {
    const anchors = SETTINGS_ANCHORS_V1.map((entry) => entry.anchor);
    expect(new Set(anchors).size).toBe(anchors.length);
  });
});
