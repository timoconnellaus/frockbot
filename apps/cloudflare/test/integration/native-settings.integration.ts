import { env, evictDurableObject, SELF } from "cloudflare:test";
import { expect, test } from "vitest";
import { decodeProtocol } from "@frockbot/protocol-schemas";
import { nativeHeaders } from "../native-session-fixture.ts";
import {
  asUser,
  freshUserId,
  postAsUser,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

test("browser and native Settings share one owner, revision, pending identity and post-eviction receipt", async () => {
  const userId = freshUserId("settings-pair");
  const headers = await nativeHeaders(userId);
  const native = (path: string, body?: unknown) =>
    SELF.fetch(`https://bot.frockbot.com${path}`, {
      headers: { ...headers, "content-type": "application/json" },
      ...(body === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(body) }),
    });
  const read = async (response: Response) => {
    expect(response.status).toBe(200);
    return decodeProtocol("SettingsFrame", await response.json());
  };
  const initial = await read(await asUser(userId, "/api/settings/application"));
  await postAsUser(userId, "/api/settings/application", {
    schemaVersion: 1,
    commandId: "saved-profile",
    expectedRevision: initial.revision,
    sectionId: "profile",
    values: { name: "Tim" },
  });
  const browser = await read(await asUser(userId, "/api/settings/application"));
  expect(await read(await native("/api/settings/application"))).toEqual(
    browser,
  );
  const command = {
    schemaVersion: 1,
    commandId: "native-profile",
    expectedRevision: browser.revision,
    sectionId: "profile",
    values: { name: "Tim", email: "tim@example.test" },
  };
  const receipt = decodeProtocol(
    "SettingsReceipt",
    await (await native("/api/settings/application", command)).json(),
  );
  expect(receipt.status).toBe("applied");
  const after = await read(await asUser(userId, "/api/settings/application"));
  expect(after.revision).toBe(browser.revision + 1);
  expect(after.sections[0]!.fields[0]!.value).toBe("Tim");
  await evictDurableObject(env.USER_CONFIGURATIONS.getByName(userId));
  expect(
    await (await native("/api/settings/application", command)).json(),
  ).toEqual(receipt);
  expect(await read(await native("/api/settings/application"))).toEqual(after);
  expect(
    (
      await postAsUser(userId, "/api/settings/application", {
        ...command,
        commandId: "stale-browser",
      })
    ).status,
  ).toBe(409);

  const models = await read(await native("/api/settings/models"));
  expect(await read(await asUser(userId, "/api/settings/models"))).toEqual(
    models,
  );
  expect(models.sections[0]!.fields[0]!.value).toBeNull();
  const choose = {
    schemaVersion: 1,
    commandId: "choose-ollama",
    expectedRevision: models.revision,
    sectionId: "provider.provider-ollama-cloud",
    values: {},
  };
  expect(
    (
      (await (await native("/api/settings/models", choose)).json()) as {
        status: string;
      }
    ).status,
  ).toBe("applied");
  const chosen = await read(await asUser(userId, "/api/settings/models"));
  expect(
    chosen.sections.find((s) => s.packageId === "provider-ollama-cloud")
      ?.actions?.[0]?.kind,
  ).toBe("manage-provider");
  const current = (await (
    await asUser(userId, "/api/settings?view=2")
  ).json()) as { packages: Array<{ packageId: string; state: string }> };
  expect(
    current.packages.find((p) => p.packageId === "custom-models")?.state,
  ).toBe("disabled");
  const oldView = await asUser(userId, "/api/settings?view=99");
  expect(oldView.status).toBe(426);
  expect(
    (
      await postAsUser(userId, "/api/settings", {
        schemaVersion: 1,
        type: "user/set-package-settings",
        commandId: "old-model-control",
        expectedRevision: chosen.revision,
        packageId: "custom-models",
        values: {
          "account-model": { connectionId: "old", providerModelId: "old" },
        },
      })
    ).status,
  ).toBe(426);
  expect((await read(await native("/api/settings/models"))).revision).toBe(
    chosen.revision,
  );

  const query = {
    schemaVersion: 1,
    source: "account-models",
    revision: chosen.revision,
    query: "",
  };
  const options = decodeProtocol(
    "SettingsOptionsPage",
    await (await native("/api/settings/models/options", query)).json(),
  );
  expect(options.ownerId).toBe(userId);
  expect(options.items[0]!.value).toBeNull();
  expect(
    await (
      await postAsUser(userId, "/api/settings/models/options", query)
    ).json(),
  ).toEqual(options);
  expect(
    (
      await native("/api/settings/models/options", {
        ...query,
        revision: chosen.revision - 1,
      })
    ).status,
  ).toBe(409);
});
