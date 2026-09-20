// Setting an account up: the whole journey through the surfaces, and the same
// account built out of the product's commands.
//
// Two claims, deliberately in one file so they are read together.
//
// The first is the journey itself — Models, the provider's connect form, the
// default-model picker, the create sheet — walked end to end and then used to
// say something to a Bot that answers. Almost every other spec in this suite
// used to walk it before getting to its own subject, and now almost none of
// them do: this is where it is still proved, once, as the thing under test
// rather than as a preamble. `first-run.e2e.ts` covers what a brand-new
// account lands in, and `settings-models.e2e.ts` covers what the Models page
// says about a default; neither of them walks the whole path to a working Bot.
//
// The second is that `provisionThroughApi` arrives at the same account. Both
// tests end at one shared assertion over the durable projections — the
// Packages the account holds, the Connection's state, the model the account is
// bound to, the Bot in the Flock directory — so "the same account" is a claim
// checked against the authority rather than asserted in a comment. If the two
// paths ever diverge, the assertion is what says so, in the file whose subject
// that is.
import type { Page } from "@playwright/test";
import {
  test,
  expect,
  provisionThroughApi,
  provisionThroughUi,
  sem,
  sendMessage,
} from "./fixtures.ts";
import { E2E_MODEL_ID, E2E_OLLAMA_GOOD_API_KEY } from "./harness.ts";
import {
  E2E_CUSTOM_MODELS_PACKAGE_ID,
  E2E_PROVIDER_PACKAGE_ID,
} from "./provisioning.ts";

interface SettingsView {
  packages: { packageId: string; state: string }[];
  connections: { connectionId: string; state: string }[];
  accountModel?: { connectionId: string; providerModelId: string };
}

/**
 * What a provisioned account is, read from the authority rather than from the
 * screen: the surfaces are the subject of the first test below, and reading
 * the claim off them would make the second test depend on them too.
 *
 * `view=2` because `accountModel` is behind that contract — the older browser
 * projection omits it, so a read without it would find no model and say
 * nothing about whether one had been chosen.
 */
async function expectProvisionedAccount(
  page: Page,
  userId: string,
  botName: string,
): Promise<void> {
  const headers = { "x-frockbot-user-id": userId };
  const settings = (await (
    await page.request.get("/api/settings?view=2", { headers })
  ).json()) as SettingsView;

  // The provider Package is installed, and Custom models — a separate switch,
  // for a per-Bot override neither path asked for — is not.
  expect(
    settings.packages.find(
      (installed) => installed.packageId === E2E_PROVIDER_PACKAGE_ID,
    ),
  ).toMatchObject({ state: "installed" });
  expect(
    settings.packages.find(
      (installed) => installed.packageId === E2E_CUSTOM_MODELS_PACKAGE_ID,
    )?.state,
  ).not.toBe("installed");

  // The account's model is bound to a Connection that is ready. Bound to
  // something else — or bound to a Connection still authorizing — is a Bot
  // that cannot reply, which is the failure both paths exist to avoid.
  expect(settings.accountModel?.providerModelId).toBe(E2E_MODEL_ID);
  expect(
    settings.connections.find(
      (connection) =>
        connection.connectionId === settings.accountModel?.connectionId,
    ),
  ).toMatchObject({ state: "ready" });

  // And the Bot is in the Flock directory under the name it was created with.
  const flock = (await (
    await page.request.get("/api/bots", { headers })
  ).json()) as { bots: { botId: string; initialName: string }[] };
  expect(flock.bots.map((bot) => bot.initialName)).toContain(botName);
}

test("a User sets an account up through the surfaces and the Bot answers", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Walker",
  });

  await expectProvisionedAccount(page, userId, "Walker");

  // The point of the walk: the Bot it ends on holds a real conversation. One
  // reply, because the thread draws what the Bot *sent* — and a Bot that sent
  // anything reached the provider through the Connection this path made.
  await sendMessage(page, "Hello from the whole path", { replies: 1 });
});

test("the command path arrives at the same account, and that Bot answers too", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  const account = await provisionThroughApi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Rider",
  });

  // The id the helper reported is the one the sidebar drew a row for, which is
  // what every migrated spec depends on when it selects its Bot.
  await expect(sem(page, `sidebar-bot-${account.botId}`)).toBeVisible();
  await expect(sem(page, "chat-composer")).toBeVisible();
  await expect(
    sem(page, "shell-right-panel")
      .getByText("Rider")
      .or(
        sem(page, "bot-panel-toggle").getByRole("button", { name: /Rider/u }),
      ),
  ).toBeVisible();

  await expectProvisionedAccount(page, userId, "Rider");

  await sendMessage(page, "Hello from the command path", { replies: 1 });
});
