// Package-level setting values, end to end through the product's own doors.
//
// The slice is one loop: a User sets a value on an installed Package through
// `/api/settings`; the User Durable Object validates it against the schema
// that Package's manifest declares and stores it; the Bot Durable Object reads
// it when it resolves the Composition for the next admitted Turn; and the
// runtime Contribution behaves differently because of it.
//
// Nothing here calls a tool directly. The stubbed model answers with a
// `tool_calls` stream when a Turn's user message carries the trigger, so the
// Agent loop admits, journals and executes the call exactly as it would for a
// real model, and the assertion is on the durable `tool/result`.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { TOOL_CALL_TRIGGER } from "../harness/miniflare.ts";
import {
  asUser,
  expectJson,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  toolCallTriggerPrompt,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

const PACKAGE_ID = "provider-ollama-cloud";
const SETTING_ID = "web-search-max-results";
const IMAGE_PACKAGE_ID = "image";
/** One of the models `image.model`'s manifest enum offers, and not the default. */
const CHOSEN_IMAGE_MODEL = "@cf/bytedance/stable-diffusion-xl-lightning";

interface ClientTurn {
  events: Array<{ type: string }>;
}

interface UserSettings {
  revision: number;
  packages: Array<{
    packageId: string;
    values?: Record<string, unknown>;
  }>;
}

async function userSettings(userId: string): Promise<UserSettings> {
  return (await expectOkJson(
    await asUser(userId, "/api/settings"),
  )) as UserSettings;
}

async function setPackageSettings(
  userId: string,
  commandId: string,
  values: Record<string, unknown>,
  packageId: string = PACKAGE_ID,
): Promise<Response> {
  return postAsUser(userId, "/api/settings", {
    schemaVersion: 1,
    type: "user/set-package-settings",
    commandId,
    expectedRevision: (await userSettings(userId)).revision,
    packageId,
    values,
  });
}

async function installPackage(
  userId: string,
  commandId: string,
  packageId: string,
): Promise<void> {
  await expectOkJson(
    await postAsUser(userId, "/api/settings", {
      schemaVersion: 1,
      type: "user/install-package",
      commandId,
      expectedRevision: (await userSettings(userId)).revision,
      packageId,
      version: "0.0.1",
    }),
  );
}

/** What the fake `AI` binding has been asked to generate so far. */
async function imageModelCalls(): Promise<Array<{ model: string }>> {
  // SAFETY: the binding is declared as Workers AI in the production `Env`; the
  // suite binds the same entrypoint a second time under `WORKERS_AI` so the
  // call log is reachable without widening the production type.
  const probe = (
    env as unknown as {
      WORKERS_AI: { runCalls(): Promise<Array<{ model: string }>> };
    }
  ).WORKERS_AI;
  return probe.runCalls();
}

/** Grant the Bot `web_search`: an Assignment bound to its Ollama Connection. */
async function grantWebSearch(userId: string, botId: string): Promise<void> {
  const { connectionId } = await provisionThroughGateway({ userId, botId });
  const bot = (await expectOkJson(
    await asUser(userId, `/api/bots/${botId}/settings`),
  )) as { revision: number };
  await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/settings`, {
      schemaVersion: 1,
      type: "bot/assign-capability",
      commandId: `assign-web-search-${botId}`,
      botId,
      expectedRevision: bot.revision,
      assignment: {
        assignmentId: "web-search",
        packageId: PACKAGE_ID,
        capabilityId: "ollama-cloud-web-search",
        connectionId,
      },
    }),
  );
}

async function searchResults(
  userId: string,
  botId: string,
  commandId: string,
  maxResults: number,
): Promise<unknown[]> {
  const turn = (await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId,
      text: `${TOOL_CALL_TRIGGER}web_search:${JSON.stringify({
        query: "frockbot parity",
        max_results: maxResults,
      })}`,
    }),
  )) as ClientTurn;
  const result = turn.events.find((event) => event.type === "tool/result") as
    { content: string; isError: boolean } | undefined;
  expect(result, "the Turn produced no tool result").toBeDefined();
  expect(result!.isError, result!.content).toBe(false);
  return (JSON.parse(result!.content) as { results: unknown[] }).results;
}

describe("a Package-level setting value reaching a Turn", () => {
  it("caps web_search at the value the User stored on the Package", async () => {
    const userId = freshUserId("package-settings");
    const botId = "configured-bot";
    await grantWebSearch(userId, botId);

    // Unset, the Package is on its own default and the model's request stands.
    expect(
      await searchResults(userId, botId, "search-default", 3),
    ).toHaveLength(3);

    await expectOkJson(
      await setPackageSettings(userId, `set-${botId}`, { [SETTING_ID]: 1 }),
    );
    // The value is projected onto the installation row the client reads back.
    const stored = (await userSettings(userId)).packages.find(
      (pkg) => pkg.packageId === PACKAGE_ID,
    );
    expect(stored?.values).toEqual({ [SETTING_ID]: 1 });

    // The next admitted Turn resolves its Composition against the new durable
    // state, so the tool runs under the User's ceiling without a redeploy.
    expect(await searchResults(userId, botId, "search-capped", 3)).toHaveLength(
      1,
    );
  });

  it("refuses a value the Package's schema does not allow, with the reason", async () => {
    const userId = freshUserId("package-settings-invalid");
    const botId = "refusing-bot";
    await grantWebSearch(userId, botId);

    const refused = await setPackageSettings(userId, `bad-${botId}`, {
      [SETTING_ID]: 99,
    });
    expect(refused.status).toBe(400);
    expect((await expectJson(refused)) as { error: string }).toMatchObject({
      error: expect.stringContaining("is above 10"),
    });

    const unknown = await setPackageSettings(userId, `unknown-${botId}`, {
      "not-a-setting": "x",
    });
    expect(unknown.status).toBe(400);
    expect((await expectJson(unknown)) as { error: string }).toMatchObject({
      error: expect.stringContaining("not declared by this Package"),
    });

    // Neither refusal wrote anything, and neither moved the revision.
    const settings = await userSettings(userId);
    expect(
      settings.packages.find((pkg) => pkg.packageId === PACKAGE_ID)?.values,
    ).toBeUndefined();
  });
});

describe("the Image Package's `image.model` setting", () => {
  it("runs generate_image on the model the User chose from the enum", async () => {
    const userId = freshUserId("image-model-setting");
    const botId = "image-setting-bot";
    await provisionThroughGateway({ userId, botId });
    await installPackage(userId, `install-image-${botId}`, IMAGE_PACKAGE_ID);

    await expectOkJson(
      await setPackageSettings(
        userId,
        `set-image-model-${botId}`,
        { model: CHOSEN_IMAGE_MODEL },
        IMAGE_PACKAGE_ID,
      ),
    );

    const before = (await imageModelCalls()).length;
    const turn = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/turns`, {
        schemaVersion: 1,
        commandId: `image-with-setting-${botId}`,
        text: toolCallTriggerPrompt([
          "generate_image",
          { prompt: "a red barn at dusk" },
        ]),
      }),
    )) as ClientTurn;
    const result = turn.events.find((event) => event.type === "tool/result") as
      { content: string; isError: boolean } | undefined;
    expect(result, "the Turn made no generate_image call").toBeDefined();
    expect(result!.isError, result!.content).toBe(false);

    // The value crossed the whole slice: a form command, durable User state,
    // the Turn's Composition, and the Package's own model seam.
    const calls = await imageModelCalls();
    expect(calls.length).toBe(before + 1);
    expect(calls.at(-1)).toMatchObject({ model: CHOSEN_IMAGE_MODEL });
  });

  it("refuses a model that is not on the manifest's enum", async () => {
    const userId = freshUserId("image-model-invalid");
    await installPackage(userId, `install-image-${userId}`, IMAGE_PACKAGE_ID);

    const refused = await setPackageSettings(
      userId,
      `bad-image-model-${userId}`,
      { model: "@cf/not/a-model" },
      IMAGE_PACKAGE_ID,
    );
    expect(refused.status).toBe(400);
    expect((await expectJson(refused)) as { error: string }).toMatchObject({
      error: expect.stringContaining("is not one of"),
    });
  });
});
