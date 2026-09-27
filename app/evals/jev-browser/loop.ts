// The production browser-task loop (`computer/browser-task.ts`) driven against
// a local Playwright page: observe is the page's accessibility snapshot, act
// is Playwright by role and name, decide is live Jev. A click the loop would
// send for review stops the task here, as a refusal would.
import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { Page } from "playwright";
import {
  runBrowserTaskV1,
  type BrowserTaskOutcomeV1,
} from "@frockbot/computer/browser-task";
import { jevChargeMicrosV1 } from "../../billing/jev.ts";
import { RESPONSE_REVIEW_MODEL_V1 } from "../../supervision/response-review.ts";

export const MODEL = RESPONSE_REVIEW_MODEL_V1;
export const MICROS_PER_INPUT_TOKEN = jevChargeMicrosV1(1_000_000) / 1_000_000;

const client = new TypeSafeClient({
  apiKey: process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY!,
  ...(process.env.JEV_BASE_URL ? { baseURL: process.env.JEV_BASE_URL } : {}),
});

export interface JevCall {
  ms: number;
  inputTokens: number;
}

export interface TaskRun {
  outcome: BrowserTaskOutcomeV1 | "failed";
  reason: string;
  steps: string[];
  calls: JevCall[];
  wallMs: number;
}

export async function runTask(
  page: Page,
  task: { goal: string; values?: Record<string, string> },
  opts: { log?: boolean } = {},
): Promise<TaskRun> {
  const calls: JevCall[] = [];
  const started = performance.now();
  const report = await runBrowserTaskV1(task, {
    observe: async () => {
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(50);
      return {
        url: page.url(),
        title: await page.title(),
        snapshot: await page.locator("body").ariaSnapshot({ timeout: 10_000 }),
      };
    },
    act: async (action, value) => {
      const { role, name, nth } = action.control;
      const target = page
        .getByRole(role as Parameters<Page["getByRole"]>[0], {
          name,
          exact: true,
        })
        .nth(nth);
      if (opts.log) console.log(`  step: ${action.describe}`);
      if (action.operation.op === "click") {
        await target.click({ timeout: 3_000 });
      } else if (action.operation.op === "type") {
        await target.fill(value ?? "", { timeout: 3_000 });
      } else {
        await target.selectOption(
          { label: action.operation.option },
          { timeout: 3_000 },
        );
      }
    },
    decide: async ({ state, questions }) => {
      const at = performance.now();
      try {
        const result = await client.systemOne(
          { state, questions: questions as never, model: MODEL } as never,
          { retry: { maxRetries: 1 } },
        );
        calls.push({
          ms: Math.round(performance.now() - at),
          inputTokens: result.usage.input_tokens,
        });
        return result.answers as never;
      } catch (error) {
        if (opts.log) console.log(`  jev failed: ${String(error)}`);
        return undefined;
      }
    },
    review: async (action) => `Review wanted before: ${action.describe}`,
  });
  return {
    outcome: report.outcome,
    reason:
      report.outcome === "needs_approval"
        ? report.steps.at(-1)!.replace(/^needs approval: /, "")
        : report.reason,
    steps: report.steps.filter((step) => !step.startsWith("needs approval")),
    calls,
    wallMs: Math.round(performance.now() - started),
  };
}
