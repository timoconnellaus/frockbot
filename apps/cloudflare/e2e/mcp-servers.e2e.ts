// A remote MCP server is added from the Marketplace with a form of its own:
// the address first, a name, and a token only when the server asks for one —
// never the key form a model provider draws.
import {
  answerInputs,
  expect,
  group,
  openApplication,
  openConnectors,
  press,
  searchMarketplace,
  settle,
  test,
} from "./fixtures.ts";

// Twice the pixels, so the capture stays sharp as a What's New still.
test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });

test("an MCP server is added from a form that asks for its address", async ({
  page,
  userId,
}, testInfo) => {
  await openApplication(page, userId);
  await openConnectors(page);
  await searchMarketplace(page, "remote MCP server");
  const card = group(page, "MCP servers");
  await expect(card).toBeVisible();

  await press(card.getByText("Connect", { exact: true }));
  // A focused empty field reads its hint into its label, so match the start.
  const address = card.locator('input[aria-label^="Server address"]');
  await expect(address).toBeVisible();
  await expect(card.locator('input[aria-label="API key"]')).toHaveCount(0);

  // An address that is not https is refused before anything is sent.
  await answerInputs([[address, "http://mcp.example.com/mcp"]]);
  await press(card.getByText("Add server", { exact: true }));
  await expect(card.getByText(/full https address/)).toBeVisible();

  await answerInputs([
    [address, "https://mcp.linear.app/mcp"],
    [card.locator('input[aria-label^="Name (optional)"]'), "Linear"],
  ]);
  await settle(page);
  // Editing the address takes back what was said about the last one.
  await expect(card.getByText(/full https address/)).toHaveCount(0);
  const path = testInfo.outputPath("mcp-server-form.png");
  await page.screenshot({ path });
  await testInfo.attach("mcp-server-form.png", {
    path,
    contentType: "image/png",
  });
});
