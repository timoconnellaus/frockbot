import { expect, test } from "bun:test";

import {
  decodePluginDescriptorV1,
  decodePluginWorkerHealthV1,
  ISOLATE_CONTRACT_VERSION,
  PLUGIN_CARD_ACTION_NAME_PATTERN_V1,
} from "./index.js";

test("the contracts barrel initializes the shared Plugin card contract", () => {
  expect(new RegExp(PLUGIN_CARD_ACTION_NAME_PATTERN_V1).test("send_now")).toBe(
    true,
  );
  expect(
    decodePluginDescriptorV1({
      id: "email",
      displayName: "Email",
      version: "1.0.0",
      contractVersion: ISOLATE_CONTRACT_VERSION,
      tools: [],
      hooks: [],
      grants: [],
      contextKeys: ["user", "bot", "session"],
    }).id,
  ).toBe("email");
  expect(
    decodePluginWorkerHealthV1({
      schemaVersion: 1,
      contractVersion: ISOLATE_CONTRACT_VERSION,
      plugins: [],
    }).plugins,
  ).toEqual([]);
});
