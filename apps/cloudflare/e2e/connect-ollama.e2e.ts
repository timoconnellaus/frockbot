// Seam S4 (browser → the connections route contributed by the Settings
// Package) and seam S7 (User Durable Object → the provider).
//
// Incident 4: pressing Connect answered "Failed to fetch" — the route existed
// on the backend Contribution and the client never reached it. No unit test
// could see that, because both halves were correct in isolation.
//
// Incident 5: a key that a catalog read accepts is not a key that can run
// inference. The Package validates with `POST /api/chat`, and the fake server
// reproduces the asymmetry measured against ollama.com: `/api/tags` and
// `/api/show` answer any key, `/api/chat` authenticates. The second test would
// fail outright if the Package went back to validating with a catalog read.
import {
  test,
  expect,
  closeOverlay,
  connectOllama,
  createBot,
  E2E_CONNECTION_LABEL,
  E2E_MODEL_LABEL,
  firstRunDialog,
  ollamaCard,
  openApplication,
} from "./fixtures.ts";
import { E2E_OLLAMA_BAD_API_KEY, E2E_OLLAMA_GOOD_API_KEY } from "./harness.ts";

test("a good key reaches ready and lists the endpoint's models", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  await openApplication(page, userId);
  await firstRunDialog(page).getByRole("button", { name: "Cancel" }).click();

  await connectOllama(page, {
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
  });

  const card = ollamaCard(page);
  await expect(card.getByText("ready · models fresh")).toBeVisible();
  await expect(
    card.getByRole("button", { name: /Ollama Cloud accounts, Connected/ }),
  ).toBeVisible();
  await expect(card.getByText(E2E_CONNECTION_LABEL)).toBeVisible();

  // The catalog the Connection resolved is the one the configured endpoint
  // serves, and it is what the model choosers offer.
  await closeOverlay(page);
  await page.getByRole("button", { name: "FrockBot user" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const models = page.getByLabel(/^Default model/);
  await expect(models).toBeVisible();
  await expect(
    models.getByRole("option", {
      name: `${E2E_MODEL_LABEL} — ${E2E_CONNECTION_LABEL}`,
    }),
  ).toBeAttached();
  await expect(
    models.getByRole("option", {
      name: `glm-5.3-flash — ${E2E_CONNECTION_LABEL}`,
    }),
  ).toBeAttached();
});

test("a key the endpoint refuses for inference never reaches ready", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  await openApplication(page, userId);
  await createBot(page, "Refused");

  await connectOllama(page, {
    apiKey: E2E_OLLAMA_BAD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
  });

  const card = ollamaCard(page);
  const failure = card.getByRole("alert");
  await expect(failure).toContainText(
    "Ollama Cloud rejected the key for inference",
  );
  await expect(card.getByText("ready ·")).toHaveCount(0);
  await expect(card.getByText("failed", { exact: true })).toBeVisible();
});
