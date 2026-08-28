import { describe, expect, test } from "bun:test";
import {
  ConfigurationDecodeError,
  decodeConfigurationCommandV1,
  decodeConfigurationQueryV1,
} from "./index.js";

describe("configuration DTO seam", () => {
  test("decodes a versioned Bot profile command", () => {
    expect(
      decodeConfigurationCommandV1({
        schemaVersion: 1,
        type: "bot/update-profile",
        commandId: "command-1",
        botId: "primary",
        expectedRevision: 3,
        profile: {
          name: "Housework",
          label: "Research, marketing, admin",
          description: "Keeps the household organized.",
        },
      }),
    ).toEqual({
      schemaVersion: 1,
      type: "bot/update-profile",
      commandId: "command-1",
      botId: "primary",
      expectedRevision: 3,
      profile: {
        name: "Housework",
        label: "Research, marketing, admin",
        description: "Keeps the household organized.",
      },
    });
  });

  test("rejects unversioned, malformed, and unknown commands", () => {
    for (const value of [
      { type: "bot/update-profile" },
      {
        schemaVersion: 1,
        type: "bot/update-profile",
        commandId: "command-1",
        botId: "../primary",
        expectedRevision: 0,
        profile: { name: "Primary" },
      },
      { schemaVersion: 1, type: "bot/delete-everything" },
    ]) {
      expect(() => decodeConfigurationCommandV1(value)).toThrow(
        ConfigurationDecodeError,
      );
    }
  });

  test("decodes only explicit User and Bot queries", () => {
    expect(
      decodeConfigurationQueryV1({
        schemaVersion: 1,
        type: "bot/get",
        botId: "primary",
      }),
    ).toEqual({ schemaVersion: 1, type: "bot/get", botId: "primary" });
    expect(() =>
      decodeConfigurationQueryV1({ schemaVersion: 1, type: "all/get" }),
    ).toThrow(ConfigurationDecodeError);
  });
});
