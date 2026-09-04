// A Bot whose model's provider Package is switched off keeps answering.
//
// The account here is the ordinary one `provisionThroughGateway` builds: Custom
// models on, `provider-ollama-cloud` connected, and the account model bound to
// that Connection. Switching the provider off — directly, or as the cascade
// from disabling a Package it depends on — used to leave the next Turn with no
// binding at all, and the turn handler answered 500. The platform bootstrap now
// stands in, so the Turn runs on `@flock/auto` and the User is told which model
// answered rather than being handed an error.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  asUser,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

/** What the fake `AI` binding has been asked for so far. */
async function flockModelCalls(): Promise<Array<{ model: string }>> {
  // SAFETY: the suite binds the same RPC entrypoint a second time under
  // `AI_PROBE` so the call log is reachable without widening production Env.
  const probe = (
    env as unknown as {
      AI_PROBE: { runCalls(): Promise<Array<{ model: string }>> };
    }
  ).AI_PROBE;
  return probe.runCalls();
}

async function disablePackage(
  userId: string,
  packageId: string,
): Promise<void> {
  const settings = (await expectOkJson(
    await asUser(userId, "/api/settings"),
  )) as { revision: number };
  await expectOkJson(
    await postAsUser(userId, "/api/settings", {
      schemaVersion: 1,
      type: "user/set-package-enabled",
      commandId: `disable-${packageId}`,
      expectedRevision: settings.revision,
      packageId,
      enabled: false,
    }),
  );
}

/**
 * The wire name `@flock/auto` takes on the AI Gateway. Asserting it is what
 * proves the Turn ran on the platform default rather than merely producing a
 * reply from somewhere.
 */
const FLOCK_AUTO_GATEWAY_MODEL = "dynamic/flock-auto";

/** The account's platform bootstrap, as the settings surface reports it. */
async function platformModel(
  userId: string,
): Promise<{ providerModelId?: string } | undefined> {
  const settings = (await expectOkJson(
    await asUser(userId, "/api/settings"),
  )) as { platformModel?: { providerModelId?: string } };
  return settings.platformModel;
}

async function packageStates(
  userId: string,
): Promise<Record<string, string | undefined>> {
  const settings = (await expectOkJson(
    await asUser(userId, "/api/settings"),
  )) as { packages: Array<{ packageId: string; state: string }> };
  return Object.fromEntries(
    settings.packages.map((pkg) => [pkg.packageId, pkg.state]),
  );
}

describe("a Bot whose model's provider is switched off", () => {
  it("answers on the platform default when the provider Package is disabled", async () => {
    const userId = freshUserId("provider-off");
    const botId = "grounded-bot";
    await provisionThroughGateway({ userId, botId });

    await disablePackage(userId, "provider-ollama-cloud");
    expect((await packageStates(userId))["provider-ollama-cloud"]).toBe(
      "disabled",
    );

    const before = (await flockModelCalls()).length;
    const turn = await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId: "turn-after-provider-disabled",
      text: "hello",
    });
    expect(turn.status).toBe(200);
    expect(JSON.stringify(await turn.json())).toContain("Flock AI reply");
    expect(
      (await flockModelCalls()).slice(before).map((call) => call.model),
    ).toContain(FLOCK_AUTO_GATEWAY_MODEL);
    expect((await platformModel(userId))?.providerModelId).toBe("@flock/auto");
  });

  it("cascades a dependency's disable to the provider and still answers", async () => {
    const userId = freshUserId("provider-cascade");
    const botId = "cascaded-bot";
    await provisionThroughGateway({ userId, botId });

    // `provider-ollama-cloud` declares a dependency on `custom-models`, so
    // switching Custom models off carries the provider with it rather than
    // leaving the account in the state the enable path refuses to create.
    await disablePackage(userId, "custom-models");
    const states = await packageStates(userId);
    expect(states["custom-models"]).toBe("disabled");
    expect(states["provider-ollama-cloud"]).toBe("disabled");

    const before = (await flockModelCalls()).length;
    const turn = await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId: "turn-after-cascade",
      text: "hello",
    });
    expect(turn.status).toBe(200);
    expect(JSON.stringify(await turn.json())).toContain("Flock AI reply");
    expect(
      (await flockModelCalls()).slice(before).map((call) => call.model),
    ).toContain(FLOCK_AUTO_GATEWAY_MODEL);
    expect((await platformModel(userId))?.providerModelId).toBe("@flock/auto");
  });
});
