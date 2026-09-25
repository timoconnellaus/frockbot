// A Bot writes, checks and publishes a Plugin, the User approves it in the
// conversation, and its tool reaches the Bot — end to end, on the real
// routes (ADR 0026 step 7).
//
// Nothing here is faked and nothing is seeded. `plugin_create` writes the
// SDK scaffold into the Plugin's source root through the Turn's own
// Workspace surface, `plugin_check` and `plugin_publish` post that source to
// the real `apps/applet-build` service, the app Worker hash-verifies and
// stores the module, and the publish ends in an approval card on the Turn's
// log. Pressing Approve is what makes the Plugin run: the next Turn calls its
// tool through the Plugin worker, and the answer comes off the Turn's durable
// log.
//
// The build needs Docker. When it is not running this spec fails saying so,
// rather than passing without having built anything.
import {
  test,
  expect,
  press,
  enablePluginAuthoring,
  provisionThroughApi,
  sendMessage,
} from "./fixtures.ts";
import {
  appletBuildAvailableV1,
  E2E_OLLAMA_GOOD_API_KEY,
  e2eToolCallPrompt,
} from "./harness.ts";
import { botIdOf, expectToolSaid, runTool } from "./publish-journey.ts";
import { publicationJourneyTimeoutMs } from "./suite.ts";

const DESKTOP = { width: 1351, height: 831 } as const;

test("a Bot writes, checks and publishes a Plugin; the User approves it; its tool reaches the Bot", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  // Two container builds and five scripted Turns.
  test.setTimeout(publicationJourneyTimeoutMs);
  expect(
    appletBuildAvailableV1(),
    "Docker is not running, so apps/applet-build could not start and no Plugin can be built. Start Docker and run this spec again.",
  ).toBe(true);

  await page.setViewportSize(DESKTOP);
  // The admin-held master toggle, before the Bot exists: the tools are mounted
  // per Turn behind it, and the Skill goes with them.
  await enablePluginAuthoring(page, userId);
  await provisionThroughApi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Author",
  });

  // The scaffold: two files the Bot can read back, already building.
  await runTool(page, "Build me a notes plugin.", "plugin_create", {
    displayName: "Notes",
  });
  await expectToolSaid(page, userId, 'Created \\"notes\\"');
  await runTool(page, "Show me the descriptor.", "plugin_read_file", {
    pluginId: "notes",
    path: "plugin.json",
  });
  await expectToolSaid(page, userId, '\\"id\\": \\"notes\\"');

  // The check builds through the real service.
  await runTool(page, "Check it.", "plugin_check", { pluginId: "notes" });
  await expectToolSaid(page, userId, "notes builds.");

  // The publish builds again, stores the module, and asks. Nothing runs yet.
  await runTool(page, "Publish it.", "plugin_publish", {
    pluginId: "notes",
    purpose: "Keep short notes the Bot can read back.",
  });
  await expectToolSaid(page, userId, "asked the User to approve it");
  const before = await page.request.get(
    `/api/bots/${encodeURIComponent(await botIdOf(page, userId))}/plugins`,
  );
  expect(
    ((await before.json()) as { plugins: Array<{ pluginId: string }> }).plugins
      .map((row) => row.pluginId)
      .includes("notes"),
    "a publish must not reach the Composition before the User answers",
  ).toBe(false);

  // The card is in the conversation, and Approve is what makes it real.
  const approve = page
    .locator('[flt-semantics-identifier^="approval-approve-"]')
    .last();
  await expect(approve).toBeVisible({ timeout: 60_000 });
  await press(approve);

  // The Plugin is in the account's Composition and on for this Bot.
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/bots/${encodeURIComponent(await botIdOf(page, userId))}/plugins`,
        );
        const body = (await response.json()) as {
          plugins: Array<{ pluginId: string; on: boolean; kind: string }>;
        };
        return body.plugins.find((row) => row.pluginId === "notes");
      },
      { timeout: 60_000, message: "the approved Plugin never joined" },
    )
    .toMatchObject({ kind: "authored", on: true });

  // From the next Turn the Plugin's tool is an ordinary tool under its own
  // namespace, running in the Plugin worker with the storage grant.
  await sendMessage(
    page,
    `Keep a note.\n${e2eToolCallPrompt("call_dynamic_tool", {
      namespace: "notes",
      toolName: "note_add",
      arguments: { text: "Buy milk" },
    })}`,
  );
  await expectToolSaid(page, userId, "Kept it. 1 note(s) now.");
  await sendMessage(
    page,
    `How many?\n${e2eToolCallPrompt("call_dynamic_tool", {
      namespace: "notes",
      toolName: "note_count",
      arguments: {},
    })}`,
  );
  await expectToolSaid(page, userId, "1 note(s).");
});
