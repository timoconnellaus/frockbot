// What a publication journey does between Turns: script the Bot's own tool
// calls through the conversation, and read what they did off the operator
// surface, since the transcript hides tool results on purpose.
import type { Page } from "@playwright/test";
import { sendMessage } from "./fixtures.ts";
import { E2E_DEBUG_TOKEN, e2eFrockbotToolCallPrompt } from "./harness.ts";

/**
 * The latest Turns' tool results, from the operator surface. The transcript
 * hides them on purpose, so this is what an assertion about what a tool *did*
 * reads, and what says why when one fails.
 */
async function recentToolResults(page: Page, userId: string): Promise<string> {
  const headers = { authorization: `Bearer ${E2E_DEBUG_TOKEN}` };
  const botId = await botIdOf(page, userId);
  const detail = await page.request.get(
    `/api/debug/bots/${botId}?userId=${userId}&events=true`,
    { headers },
  );
  return JSON.stringify(await detail.json(), null, 2);
}

/** Poll the operator surface until a tool result says `text`, or explain. */
export async function expectToolSaid(
  page: Page,
  userId: string,
  text: string,
  timeoutMs = 300_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let results = "";
  while (Date.now() < deadline) {
    results = await recentToolResults(page, userId);
    if (results.includes(text)) return;
    await new Promise((sleep) => setTimeout(sleep, 2_000));
  }
  throw new Error(`no tool result said "${text}".\n${results}`);
}

export async function runTool(
  page: Page,
  text: string,
  name: string,
  input: unknown = {},
): Promise<void> {
  // The Plugin authoring tools are first-party registrations, so the scripted
  // model reaches them through the `frockbot` namespace.
  await sendMessage(page, `${text}\n${e2eFrockbotToolCallPrompt(name, input)}`);
}

/** The journey's Bot, which every journey names Author. */
export async function botIdOf(page: Page, _userId: string): Promise<string> {
  const bots = (await (await page.request.get("/api/bots")).json()) as {
    bots?: Array<{ botId: string; initialName: string }>;
  };
  const botId = bots.bots?.find((bot) => bot.initialName === "Author")?.botId;
  if (!botId) throw new Error("no Bot");
  return botId;
}
