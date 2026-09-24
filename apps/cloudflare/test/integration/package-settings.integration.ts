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
import { frockbotToolCallPrompt } from "../harness/miniflare.ts";
import {
  asUser,
  expectJson,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

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
): Promise<Response> {
  return postAsUser(userId, "/api/settings", {
    schemaVersion: 1,
    type: "user/set-package-settings",
    commandId,
    expectedRevision: (await userSettings(userId)).revision,
    packageId: IMAGE_PACKAGE_ID,
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
  // SAFETY: the suite binds the same RPC entrypoint a second time under
  // `AI_PROBE` so the call log is reachable without widening production Env.
  const probe = (
    env as unknown as {
      AI_PROBE: { runCalls(): Promise<Array<{ model: string }>> };
    }
  ).AI_PROBE;
  return probe.runCalls();
}

describe("the Image Package's `image.model` setting", () => {
  it("runs generate_image on the model the User chose from the enum", async () => {
    const userId = freshUserId("image-model-setting");
    const botId = "image-setting-bot";
    await provisionThroughGateway({ userId, botId });
    await installPackage(userId, `install-image-${botId}`, IMAGE_PACKAGE_ID);

    await expectOkJson(
      await setPackageSettings(userId, `set-image-model-${botId}`, {
        model: CHOSEN_IMAGE_MODEL,
      }),
    );
    // The value is projected onto the installation row the client reads back.
    const stored = (await userSettings(userId)).packages.find(
      (pkg) => pkg.packageId === IMAGE_PACKAGE_ID,
    );
    expect(stored?.values).toEqual({ model: CHOSEN_IMAGE_MODEL });

    const before = (await imageModelCalls()).length;
    const turn = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/turns`, {
        schemaVersion: 1,
        commandId: `image-with-setting-${botId}`,
        text: frockbotToolCallPrompt("generate_image", {
          prompt: "a red barn at dusk",
        }),
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

  it("refuses a value the Package's schema does not allow, with the reason", async () => {
    const userId = freshUserId("image-model-invalid");
    await installPackage(userId, `install-image-${userId}`, IMAGE_PACKAGE_ID);
    const revision = (await userSettings(userId)).revision;

    const refused = await setPackageSettings(
      userId,
      `bad-image-model-${userId}`,
      { model: "@cf/not/a-model" },
    );
    expect(refused.status).toBe(400);
    expect((await expectJson(refused)) as { error: string }).toMatchObject({
      error: expect.stringContaining("is not one of"),
    });

    const unknown = await setPackageSettings(userId, `unknown-${userId}`, {
      "not-a-setting": "x",
    });
    expect(unknown.status).toBe(400);
    expect((await expectJson(unknown)) as { error: string }).toMatchObject({
      error: expect.stringContaining("not declared by this Package"),
    });

    // Neither refusal wrote anything, and neither moved the revision.
    const settings = await userSettings(userId);
    expect(
      settings.packages.find((pkg) => pkg.packageId === IMAGE_PACKAGE_ID)
        ?.values,
    ).toBeUndefined();
    expect(settings.revision).toBe(revision);
  });
});
