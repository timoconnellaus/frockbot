import { expect, test } from "bun:test";
import { TypeSafeClient, type Fetch } from "@typesafe-ai/sdk";
import type { PluginFitEvidenceV1 } from "../plugins/authoring-check.js";
import { createJevPluginFitJudgeV1 } from "./plugin-fit.js";

const evidence: PluginFitEvidenceV1 = {
  request: "Make me a guitar tuner.",
  purpose: "Tune a guitar by ear.",
  displayName: "Tuner",
  parts: [
    { kind: "tool", label: "tool tune: Tunes a string" },
    { kind: "host", label: "network host tracker.example.net" },
  ],
  code: "// plugin.ts\nexport const tools = [];",
};

function judge(answers: Record<string, number> | Error, seen: unknown[] = []) {
  const fetch: Fetch = async (_input, init) => {
    seen.push(JSON.parse(String(init?.body)));
    if (answers instanceof Error) {
      return Response.json({ error: { message: "down" } }, { status: 503 });
    }
    return Response.json({
      model: "jev-1.13.0",
      answers: Object.fromEntries(
        Object.entries(answers).map(([key, noul]) => [
          key,
          { type: "noul", noul },
        ]),
      ),
      usage: { input_tokens: 1, output_tokens: 0 },
    });
  };
  return createJevPluginFitJudgeV1({
    client: new TypeSafeClient({ apiKey: "k", logLevel: "off", fetch }),
    budget: { retry: { maxRetries: 0 }, timeout: 1_000 },
  });
}

test("asks once for the whole Plugin and once per part, over one state", async () => {
  const seen: unknown[] = [];
  await judge({ fitsRequest: 0.9, part_0: 0.9, part_1: 0.9 }, seen).judge(
    evidence,
  );
  expect(seen).toHaveLength(1);
  const body = seen[0] as { questions: object; state: unknown };
  expect(Object.keys(body.questions)).toEqual([
    "fitsRequest",
    "part_0",
    "part_1",
  ]);
  expect(body.state).toEqual({
    request: evidence.request,
    purpose: evidence.purpose,
    plugin: {
      name: "Tuner",
      parts: evidence.parts.map((part) => part.label),
      code: evidence.code,
    },
  });
});

test("reads fit in three bands and names the parts nothing asked for", async () => {
  const verdict = async (fits: number) =>
    judge({ fitsRequest: fits, part_0: 0.95, part_1: 0.1 }).judge(evidence);
  expect((await verdict(0.8))?.fits).toBe("likely");
  expect((await verdict(0.45))?.fits).toBe("unclear");
  const unlikely = await verdict(0.1);
  expect(unlikely).toMatchObject({
    fits: "unlikely",
    unneeded: [{ kind: "host", label: "network host tracker.example.net" }],
    model: "jev-1.13.0",
  });
});

test("Jev failing leaves the check to the lint alone", async () => {
  expect(await judge(new Error("down")).judge(evidence)).toBeUndefined();
});
