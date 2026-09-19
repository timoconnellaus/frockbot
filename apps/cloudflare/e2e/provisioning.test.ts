// The command bodies the e2e provisioning helper posts, checked here rather
// than only by a browser suite that costs a `wrangler dev` to start.
//
// Two things are worth pinning. The id rule, because a Bot created under an id
// the authority refuses — or under one the sidebar cannot be found by — fails
// in the middle of some other spec rather than here. And the command shapes,
// because every one of these routes decodes exactly: `exactCommand` refuses an
// unknown field outright, so a body that drifts is a 400 at provisioning time
// with no surface to read it off.
import { expect, test } from "bun:test";
import {
  botIdFromName,
  chooseModelProviderCommandV1,
  connectApiKeyCommandV1,
  createBotCommandV1,
  E2E_API_BASE_URL_SETTING,
  E2E_CONNECTION_TYPE_ID,
  E2E_CUSTOM_MODELS_PACKAGE_ID,
  E2E_PROVIDER_PACKAGE_ID,
  enableCustomModelsCommandV1,
  setAccountModelCommandV1,
} from "./provisioning.ts";

/** `BotId` in the wire protocol: what every one of these ids has to satisfy. */
const BOT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

test("a Bot id is a slug of the name, suffixed so two are two", () => {
  expect(botIdFromName("Rememberer")).toMatch(/^rememberer-[0-9a-f]{8}$/);
  expect(botIdFromName("First Bot")).toMatch(/^first-bot-[0-9a-f]{8}$/);
  // Punctuation and spacing fold to single separators, and the edges are
  // trimmed: an id that began or ended with `-` would fail the protocol's own
  // pattern on the first character.
  expect(botIdFromName("  Ada's Bot!!  ")).toMatch(/^ada-s-bot-[0-9a-f]{8}$/);
  // A name with nothing a slug can keep still has to produce an id.
  expect(botIdFromName("🙂")).toMatch(/^bot-[0-9a-f]{8}$/);
  const names = ["Rememberer", "  Ada's Bot!!  ", "🙂", "A".repeat(200)];
  for (const name of names) expect(botIdFromName(name)).toMatch(BOT_ID);
  // The stem is cut to 80 characters, so a long name leaves room for the
  // suffix inside the protocol's 128.
  expect(botIdFromName("A".repeat(200)).length).toBe(89);
  expect(botIdFromName("Twin")).not.toBe(botIdFromName("Twin"));
});

test("each command carries its own id", () => {
  const ids = [
    enableCustomModelsCommandV1(0).commandId,
    chooseModelProviderCommandV1(1).commandId,
    connectApiKeyCommandV1({ label: "l", apiKey: "k", apiBaseUrl: "u" })
      .commandId,
    setAccountModelCommandV1({
      expectedRevision: 2,
      connectionId: "c",
      providerModelId: "m",
    }).commandId,
    createBotCommandV1({ expectedRevision: 0, botId: "b", name: "B" })
      .commandId,
  ];
  expect(new Set(ids).size).toBe(ids.length);
});

test("the User settings commands are the ones the client sends, fenced", () => {
  expect(enableCustomModelsCommandV1(3)).toMatchObject({
    schemaVersion: 1,
    type: "user/set-package-enabled",
    expectedRevision: 3,
    packageId: E2E_CUSTOM_MODELS_PACKAGE_ID,
    enabled: true,
  });
  // No `version`: `user/choose-model-provider` resolves the Package's version
  // and its dependencies out of the deployment's catalogue, and a pinned one
  // here would go stale the day that catalogue moved.
  const chosen = chooseModelProviderCommandV1(4);
  expect(chosen).toMatchObject({
    schemaVersion: 1,
    type: "user/choose-model-provider",
    expectedRevision: 4,
    packageId: E2E_PROVIDER_PACKAGE_ID,
  });
  expect(Object.keys(chosen).sort()).toEqual([
    "commandId",
    "expectedRevision",
    "packageId",
    "schemaVersion",
    "type",
  ]);
  expect(
    setAccountModelCommandV1({
      expectedRevision: 5,
      connectionId: "connection-1",
      providerModelId: "gpt-oss:20b",
    }),
  ).toMatchObject({
    schemaVersion: 1,
    type: "user/set-account-model",
    expectedRevision: 5,
    model: { connectionId: "connection-1", providerModelId: "gpt-oss:20b" },
  });
});

test("the connect command names the endpoint through the shipped setting", () => {
  const command = connectApiKeyCommandV1({
    label: "Local Ollama",
    apiKey: "e2e-test-key",
    apiBaseUrl: "http://127.0.0.1:1234/s/e2e-1",
  });
  expect(command).toMatchObject({
    schemaVersion: 1,
    type: "connection/create-api-key",
    packageId: E2E_PROVIDER_PACKAGE_ID,
    connectionTypeId: E2E_CONNECTION_TYPE_ID,
    label: "Local Ollama",
    apiKey: "e2e-test-key",
    settings: { [E2E_API_BASE_URL_SETTING]: "http://127.0.0.1:1234/s/e2e-1" },
  });
  // A Connection command is made at-most-once by its id rather than fenced on
  // a revision, which is what `/api/connection-commands` looks a lost answer
  // up by. Carrying one would be refused.
  expect(command).not.toHaveProperty("expectedRevision");
});

test("bot/create is fenced on the Flock directory, not on settings", () => {
  const command = createBotCommandV1({
    expectedRevision: 2,
    botId: "rememberer-0a1b2c3d",
    name: "Rememberer",
  });
  expect(command).toMatchObject({
    schemaVersion: 1,
    type: "bot/create",
    expectedRevision: 2,
    botId: "rememberer-0a1b2c3d",
    name: "Rememberer",
  });
  // No avatar: the Flock draws one at random, and a spec that named one would
  // be making a claim about the look it is not there to make.
  expect(command).not.toHaveProperty("avatar");
});
