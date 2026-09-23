import { expect, test } from "bun:test";
import type { Fetch } from "@typesafe-ai/sdk";
import type { GroupReplyEvidenceV1 } from "@frockbot/core/contracts";
import { createHostedGroupReplyJudgeV1 } from "./group-reply.js";

const evidence: GroupReplyEvidenceV1 = {
  groupName: "Ops",
  members: [
    { botId: "general", name: "General" },
    { botId: "codex", name: "Codex" },
  ],
  recent: [],
  message: { speaker: "General", text: "@Codex again?", mentions: ["codex"] },
  botAuthored: true,
  candidates: [],
};

test("without a key the judge is unavailable: nobody extra, mentions under the bound", async () => {
  expect(await createHostedGroupReplyJudgeV1({}).decide(evidence)).toEqual({
    reply: [],
    mentions: "continues",
    unavailable: true,
  });
});

test("a failing service is the same as an unavailable one", async () => {
  const fetch: Fetch = async () => new Response("down", { status: 503 });
  const judge = createHostedGroupReplyJudgeV1(
    { JEV_API_KEY: "sk-test" },
    fetch,
  );
  expect(await judge.decide(evidence)).toMatchObject({ unavailable: true });
});

test("an abort still aborts", async () => {
  const controller = new AbortController();
  controller.abort();
  const judge = createHostedGroupReplyJudgeV1({ JEV_API_KEY: "sk-test" });
  await expect(judge.decide(evidence, controller.signal)).rejects.toThrow();
});
