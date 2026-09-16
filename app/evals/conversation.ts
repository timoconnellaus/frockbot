import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createAgentLoop } from "@frockbot/core/agent-loop";
import { BATCH_TOOL_NAME } from "@frockbot/core/contracts";
import { createAgentRuntimeHarness } from "@frockbot/app/testkit";
import { AGENT_LOOP_MAX_STEPS_V1 } from "@frockbot/app/agent-runtime";
import { foundationBaseRuntimePackagesV1 } from "@frockbot/app/runtime";
import { OpenAICompatibleProvider } from "@frockbot/providers/openai-compatible";

// Development-only model evaluation. Read the saved messages for completeness
// and natural boundaries too: counts alone cannot judge a useful answer.
const cases = [
  {
    name: "simple",
    input: "What does CPU stand for?",
    minMessages: 1,
    maxMessages: 1,
    maxWords: 60,
    structured: false,
  },
  {
    name: "multipart",
    input: "Explain the difference between RAM, storage, and backups.",
    minMessages: 2,
    maxMessages: 4,
    maxWords: 220,
    structured: false,
  },
  {
    name: "requested-detail",
    input:
      "Give me a detailed numbered checklist of ten things to do when moving house, covering before the move, moving day, and after. Explain each item.",
    minMessages: 1,
    maxMessages: 4,
    maxWords: 900,
    structured: true,
  },
];

const baseUrl = process.env.OLLAMA_BASE_URL ?? "https://ollama.com";
const model = process.env.OLLAMA_MODEL ?? "glm-5.3-flash:cloud";
const endpoint = new URL(baseUrl);
if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
  throw new Error(
    "OLLAMA_BASE_URL must not contain credentials, query, or fragment",
  );
if (endpoint.hostname === "ollama.com" && !process.env.OLLAMA_API_KEY)
  throw new Error("Set OLLAMA_API_KEY or point OLLAMA_BASE_URL at your server");
const transport = new OpenAICompatibleProvider({
  baseUrl: `${baseUrl.replace(/\/$/, "")}/v1`,
  apiKey: process.env.OLLAMA_API_KEY,
});
const git = (...args: string[]) =>
  Bun.spawnSync(["git", ...args])
    .stdout.toString()
    .trim();
const report = {
  model,
  baseUrl,
  inferenceSettings: "Provider/model defaults; no temperature or seed override",
  cases,
  repetitions: 3,
  commit: git("rev-parse", "HEAD"),
  workingTreeStatus: git("status", "--porcelain"),
  patchHash: createHash("sha256").update(git("diff", "HEAD")).digest("hex"),
  evalSourceHash: createHash("sha256")
    .update(await Bun.file(import.meta.filename).text())
    .digest("hex"),
  createdAt: new Date().toISOString(),
};
const results = [];
await mkdir(".eval-results", { recursive: true });
const path = `.eval-results/conversation-${Date.now()}.json`;
for (const scenario of cases) {
  for (let repetition = 1; repetition <= report.repetitions; repetition++) {
    const root = createAgentRuntimeHarness();
    for (const pkg of foundationBaseRuntimePackagesV1())
      await root.mount(pkg.feature);
    let modelCalls = 0;
    root.llm.register({
      id: "conversation-eval",
      stream(request, signal) {
        if (++modelCalls > 8)
          throw new Error("Evaluation exceeded eight model calls");
        return transport.stream(
          request,
          AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        );
      },
    });
    const loop = createAgentLoop(root, {
      maxSteps: AGENT_LOOP_MAX_STEPS_V1,
      composition: {
        generationId: "1970-01-01T00:00:00.000Z:0123456789abcdef",
        artifactSetHash: "a".repeat(64),
      },
    });
    const started = performance.now();
    try {
      const handle = await loop.create({
        botId: "conversation-eval",
        sessionId: `${scenario.name}-${repetition}`,
        provider: "conversation-eval",
        model,
        turnType: "chat",
        admitEffect: () => Promise.resolve(true),
      });
      handle.agent.send(scenario.input);
      await handle.agent.whenIdle();
      const events = [...handle.agent.session.events];
      const sends = events.filter((e) => e.type === "send/to-user");
      // The calls the model made, not the envelope it grouped them in: a
      // `batch` journals its own row as well as one per call inside it, and
      // only the inner ones deliver anything.
      const calls = events.flatMap((e) =>
        e.type === "tool/call" && e.name !== BATCH_TOOL_NAME ? [e] : [],
      );
      const messages = sends.flatMap((e) =>
        e.payload.type === "text" ? [e.payload.text] : [],
      );
      // Judge the delivery the user got, not every attempt: a refused call
      // delivers nothing, and the model correcting the payload shape and
      // resending is the runtime safeguard working. `refusedCalls` keeps the
      // attempts visible without failing a Turn that reached the user.
      const deliveredCalls = sends.flatMap((send) => {
        const call = calls.find((c) => c.occurrenceId === send.occurrenceId);
        return call ? [call] : [];
      });
      const refusedCalls = calls.length - deliveredCalls.length;
      const words = messages.map((text) => text.trim().split(/\s+/u).length);
      const text = messages.join("\n\n");
      const totalWords = words.reduce((sum, count) => sum + count, 0);
      const checks = {
        completed:
          events.findLast((e) => e.type === "turn/end")?.outcome ===
          "completed",
        onlyTextSends:
          sends.length === messages.length &&
          calls.every((call) => call.name === "send_to_user"),
        deliveryOrder:
          deliveredCalls.length === sends.length &&
          deliveredCalls.length > 0 &&
          deliveredCalls.every((call, index) => {
            const input = call?.input as { disposition?: string } | null;
            return (
              input?.disposition ===
              (index === deliveredCalls.length - 1 ? "finish" : "continue")
            );
          }),
        messageCount:
          messages.length >= scenario.minMessages &&
          messages.length <= scenario.maxMessages,
        length:
          totalWords > 0 &&
          totalWords <= scenario.maxWords &&
          (scenario.structured
            ? totalWords >= 150
            : words.every((count) => count <= 90)),
        formatting: scenario.structured
          ? (text.match(/^\s*\d+[.)]\s+/gm) ?? []).length === 10
          : !/(^\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|\|)|\*\*|__)/m.test(text),
        distinctMessages: new Set(messages).size === messages.length,
      };
      const result = {
        scenario: scenario.name,
        repetition,
        passed: Object.values(checks).every(Boolean),
        checks,
        messages,
        words,
        modelCalls,
        refusedCalls,
        elapsedMs: Math.round(performance.now() - started),
        events,
      };
      results.push(result);
      await writeFile(path, JSON.stringify({ ...report, results }, null, 2));
      console.log(
        `${result.passed ? "PASS" : "FAIL"} ${scenario.name} ${repetition}/3: ${JSON.stringify(messages)}`,
      );
      if (!result.passed) console.log(checks);
    } finally {
      await loop.dispose();
      await root.dispose();
    }
  }
}
console.log(`Trace: ${path}`);
process.exitCode = results.every((result) => result.passed) ? 0 : 1;
