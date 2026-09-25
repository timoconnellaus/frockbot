import { describe, expect, test } from "bun:test";
import {
  decodePluginPageTryRequestV1,
  PLUGIN_PAGE_TRY_MAX_STEPS_V1,
  pluginPageForTryV1,
} from "./plugin-page-try.js";

describe("a Bot's try of its page", () => {
  test("keeps each step's one action, with the state and answers it gave", () => {
    expect(
      decodePluginPageTryRequestV1({
        steps: [
          { click: "#listen" },
          { tone: { frequency: 196, level: 0.05, noise: 0.02 } },
          { wait: 1500 },
          { silence: true },
          { hostStop: true },
          { state: { a4: 442 } },
          { screenshot: "after" },
        ],
        state: { a4: 440 },
        toolAnswers: { score_add: "added" },
      }),
    ).toEqual({
      steps: [
        { click: "#listen" },
        { tone: { frequency: 196, level: 0.05, noise: 0.02 } },
        { wait: 1500 },
        { silence: true },
        { hostStop: true },
        { state: { a4: 442 } },
        { screenshot: "after" },
      ],
      state: { a4: 440 },
      toolAnswers: { score_add: "added" },
    });
  });

  test("refuses what the stand-in cannot do, in words the Bot can act on", () => {
    const refusal = (
      input: Parameters<typeof decodePluginPageTryRequestV1>[0],
    ) => {
      try {
        decodePluginPageTryRequestV1(input);
        return "accepted";
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(refusal({ steps: [] })).toContain("non-empty");
    expect(refusal({ steps: [{ click: "#a", wait: 1 }] })).toContain(
      "exactly one action",
    );
    expect(refusal({ steps: [{ swipe: "left" }] })).toContain(
      "click, tone, silence, hostStop, state, wait or screenshot",
    );
    expect(
      refusal({ steps: [{ tone: { frequency: 196, level: 2 } }] }),
    ).toContain("0 to 1");
    expect(
      refusal({ steps: [{ tone: { frequency: 5, level: 0.5 } }] }),
    ).toContain("20 to 4000");
    expect(
      refusal({
        steps: Array.from({ length: PLUGIN_PAGE_TRY_MAX_STEPS_V1 + 1 }, () => ({
          wait: 1,
        })),
      }),
    ).toContain("at most");
    expect(
      refusal({ steps: Array.from({ length: 4 }, () => ({ wait: 9_000 })) }),
    ).toContain("add up");
    expect(
      refusal({
        steps: Array.from({ length: 5 }, () => ({ screenshot: "x" })),
      }),
    ).toContain("screenshots");
    expect(
      refusal({ steps: [{ wait: 1 }], toolAnswers: { score_add: 3 } }),
    ).toContain("toolAnswers");
  });

  test("the tried page has no network, as in the app", () => {
    const html = pluginPageForTryV1(
      "<html><head><title>t</title></head></html>",
    );
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(
      html.indexOf("<title>"),
    );
    expect(html).toContain("default-src 'none'");
    expect(pluginPageForTryV1("<p>fragment</p>")).toStartWith(
      '<meta http-equiv="Content-Security-Policy"',
    );
  });
});
