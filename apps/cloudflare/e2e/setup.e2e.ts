// Setup (`/setup`): the account's plan, Computer, AI, web search, connected
// apps and accounts, as a web page the app frames. These specs drive the page
// in the tab itself, signed in by the tab's session, and once through the
// app's own door, where the page reads the account with the reader
// credential the app minted for it.
import type { Page } from "@playwright/test";
import {
  connectOllamaInSetup,
  createBot,
  E2E_MODEL_LABEL,
  expect,
  openApplication,
  openSetup,
  press,
  revealSidebar,
  sem,
  sendMessage,
  setFakeOllamaChatMode,
  test,
} from "./fixtures.ts";
import { E2E_OLLAMA_GOOD_API_KEY, e2eToolCallPrompt } from "./harness.ts";

/** What the fake Ollama says when a Turn reaches it; Frock AI's stub ignores it. */
const OWN_MODEL_REPLY = "Answered by your own model.";

function viaOwnModel(): string {
  return e2eToolCallPrompt("send_to_user", {
    disposition: "finish",
    payload: { type: "text", text: OWN_MODEL_REPLY },
  });
}

async function account(page: Page) {
  return (await (await page.request.get("/api/settings?view=2")).json()) as {
    accountModel?: { providerModelId: string };
    packages: Array<{ packageId: string; state: string }>;
  };
}

test("changing chat in Setup changes what a Bot answers with, and back", async ({
  page,
  userId,
  ollamaBaseUrl,
}, testInfo) => {
  await setFakeOllamaChatMode(page, ollamaBaseUrl, "ok");
  await openApplication(page, userId);
  await createBot(page, "Switcher");

  // Out of the box, Frock AI answers: no key, nothing to set up.
  await sendMessage(page, viaOwnModel(), { replies: 1 });
  await expect(page.getByText("Reply from the Frock AI stub.")).toBeVisible();

  await connectOllamaInSetup(page, {
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    model: E2E_MODEL_LABEL,
  });
  const path = testInfo.outputPath("setup-ai.png");
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach("setup-ai.png", { path, contentType: "image/png" });
  const chosen = await account(page);
  expect(chosen.accountModel?.providerModelId).toBe(E2E_MODEL_LABEL);
  // What lets one Bot differ from the account stays on, and stays per Bot.
  expect(
    chosen.packages.find((p) => p.packageId === "custom-models")?.state,
  ).toBe("installed");

  await openApplication(page, userId);
  await sendMessage(page, viaOwnModel(), { replies: 1 });
  await expect(page.getByText(OWN_MODEL_REPLY)).toBeVisible();

  // Frock AI again is one press, and nothing is left chosen behind it.
  await openSetup(page, "ai");
  await page.getByRole("button", { name: "Frock AI", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Frock AI does every job" }),
  ).toBeVisible();
  await expect
    .poll(async () => (await account(page)).accountModel)
    .toBeUndefined();
});

test("the app opens Setup signed in, without handing the page its session", async ({
  page,
  userId,
}) => {
  await openApplication(page, userId);
  await revealSidebar(page);
  const minted = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/setup/frame",
  );
  await press(sem(page, "sidebar-setup"));
  expect((await minted).status()).toBe(200);
  const frame = page.frameLocator('iframe[src*="/setup"]');
  await expect(frame.getByRole("heading", { name: "Your setup" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    frame.getByRole("list", { name: "Who runs what" }),
  ).toBeVisible();
  await frame.getByRole("link", { name: "AI", exact: true }).click();
  await expect(
    frame.getByRole("heading", { name: "AI", exact: true }),
  ).toBeVisible();

  // Back to the Bots is the page's own way out, answered by the app.
  await frame.getByRole("button", { name: "Back to your bots" }).click();
  await expect(page.locator('iframe[src*="/setup"]')).toHaveCount(0);
});

test("an MCP server is added from a form that asks for its address", async ({
  page,
  userId,
}, testInfo) => {
  await openApplication(page, userId);
  await openSetup(page, "apps");
  await page.getByRole("button", { name: "Add a server" }).click();
  const dialog = page.getByRole("dialog", { name: "Add an MCP server" });
  const address = dialog.getByLabel("Server address");
  await expect(dialog.getByLabel(/API key/u)).toHaveCount(0);

  await address.fill("http://mcp.example.com/mcp");
  await dialog.getByRole("button", { name: "Add server" }).click();
  await expect(dialog.getByText(/full https address/u)).toBeVisible();

  await address.fill("https://mcp.linear.app/mcp");
  await dialog.getByLabel("Name (optional)").fill("Linear");
  const path = testInfo.outputPath("setup-mcp-server-form.png");
  await page.screenshot({ path });
  await testInfo.attach("setup-mcp-server-form.png", {
    path,
    contentType: "image/png",
  });
});

test.describe("Setup on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("fits the width, and finds every provider by name", async ({
    page,
    userId,
  }, testInfo) => {
    await openApplication(page, userId);
    await openSetup(page, "ai");
    await page.getByRole("button", { name: "Custom", exact: true }).click();
    await page.getByRole("button", { name: /^Provider for Chat:/u }).click();
    await page.getByRole("searchbox").fill("OpenRouter");
    await expect(
      page.getByRole("listitem").filter({ hasText: "OpenRouter" }),
    ).toHaveCount(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const path = testInfo.outputPath("setup-phone-ai.png");
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach("setup-phone-ai.png", {
      path,
      contentType: "image/png",
    });

    // Every control a thumb presses is at least 44 points tall.
    const short = await page.evaluate(
      () =>
        [...document.querySelectorAll("main button, main a, nav a")]
          .map((element) => element.getBoundingClientRect())
          .filter((rect) => rect.width > 0 && rect.height < 44).length,
    );
    expect(short).toBe(0);
  });
});
