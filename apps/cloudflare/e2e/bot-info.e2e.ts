// The per-Bot info pane and the settings deep-link scheme (register rows 50
// and 51).
//
// The pane is assembled out of four Packages' Contributions — Settings owns the
// identity and Members sections, Computer fills `frockbot.computer`, Routines
// fills `frockbot.bot-info-sections`, and the shell owns the panel they land
// in. Nothing below the browser can prove that assembly: a unit test sees one
// component, and the failure mode this layer exists for is a Contribution that
// mounts against a state it did not expect and throws into the console. The
// `page` fixture fails the test on exactly that.
//
// The deep link is the other half. `?settings=<surface>#<anchor>` is a
// contract a Bot may cite in a payload, so a link that opens the wrong surface
// or lands on nothing is a product bug, not a UI detail.
import { test, expect, provisionThroughUi } from "./fixtures.ts";
import { E2E_OLLAMA_GOOD_API_KEY } from "./harness.ts";

test("the info pane assembles every Package's section without a console error", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  // The GrokBot window size, so the pane is proved at the geometry it copies.
  await page.setViewportSize({ width: 1351, height: 831 });
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Observed",
  });

  await page.getByRole("button", { name: "Bot info" }).click();
  const pane = page.getByRole("region", { name: "Bot info" });
  await expect(pane).toBeVisible();

  // Identity, from the Bot's own durable profile.
  await expect(pane.getByRole("heading", { name: "Observed" })).toBeVisible();
  // Name provenance, however the durable record spells it.
  await expect(pane.locator(".bot-info__provenance").first()).toHaveText(
    /Named by|provenance/u,
  );

  // Members: the Bot itself plus the Capability it was assigned when the model
  // was chosen. Settings owns this section.
  await expect(pane.getByRole("heading", { name: "Members" })).toBeVisible();
  await expect(pane.locator(".bot-info__member-note")).toHaveText(/^Bot · /u);

  // The Computer Package's own preview, through `frockbot.computer`.
  await expect(pane.getByRole("heading", { name: "Computer" })).toBeVisible();
  await expect(pane.locator("section.computer-card")).toBeVisible();

  // The Routines Package, through `frockbot.bot-info-sections`. Its heading is
  // the proof the outlet resolved.
  await expect(pane.getByRole("heading", { name: "Routines" })).toBeVisible();
  await expect(
    pane.locator("#bot-info-routines").getByText("0/0 enabled"),
  ).toBeVisible();

  // Channels are deferred, and the pane says so where they will mount.
  await expect(pane.getByRole("heading", { name: "Channels" })).toBeVisible();
  await expect(pane.locator("#bot-info-channels")).toBeVisible();

  // The notification toggle writes on change, with no Save button.
  const notifications = pane
    .locator("#bot-info-notifications")
    .getByRole("checkbox");
  await expect(notifications).not.toBeChecked();
  await notifications.check();
  await expect(notifications).toBeChecked();

  await expect(pane.locator("p.settings-error")).toHaveCount(0);

  // Nothing in the pane pushes the workspace sideways at the window size.
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("the pane fits the mobile shell", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  // Provisioned at the desktop size and then narrowed: the flow being proved
  // here is the pane at 390px, not the Plugins overlay at 390px.
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Pocket",
  });
  await page.setViewportSize({ width: 390, height: 844 });

  await page.getByRole("button", { name: "Bot info" }).click();
  const pane = page.getByRole("region", { name: "Bot info" });
  await expect(pane).toBeVisible();
  await expect(pane.getByRole("heading", { name: "Channels" })).toBeVisible();

  // Nothing inside the pane may push the document sideways.
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("a settings deep link opens the surface and highlights the row", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Linked",
  });

  const botId = await page.evaluate(
    () => new URL(window.location.href).searchParams.get("bot") ?? "",
  );
  expect(botId).not.toBe("");

  // A cold load of a link a Bot could have cited: the Bot settings panel opens
  // by itself and the Description row is the highlighted target.
  await page.goto(
    `/?bot=${encodeURIComponent(botId)}&settings=bot-settings#bot-description`,
  );
  const panel = page.getByRole("region", { name: "Bot settings" });
  await expect(panel).toBeVisible();
  const row = panel.locator("#bot-description");
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-anchor-target", "true");
  await expect(row.getByRole("textbox", { name: "Description" })).toHaveValue(
    "",
  );

  // A row under the Advanced disclosure: the link has to open it, or it would
  // resolve to a collapsed element nobody can see.
  await page.goto(
    `/?bot=${encodeURIComponent(botId)}&settings=bot-settings#bot-capabilities`,
  );
  await expect(panel).toBeVisible();
  await expect(panel.locator("#bot-capabilities")).toBeVisible();
  await expect(panel.getByText("Capability Assignments")).toBeVisible();

  // And a link into the info pane, which is a different surface entirely.
  await page.goto(
    `/?bot=${encodeURIComponent(botId)}&settings=bot-info#bot-info-computer`,
  );
  const pane = page.getByRole("region", { name: "Bot info" });
  await expect(pane).toBeVisible();
  await expect(pane.locator("#bot-info-computer")).toHaveAttribute(
    "data-anchor-target",
    "true",
  );

  // Every section offers its own copy control, which is what makes the link
  // citable by a person as well as by a Bot.
  await expect(
    pane.getByRole("button", { name: "Copy link to Computer" }),
  ).toBeAttached();
});
