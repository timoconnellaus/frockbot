import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createAgentLoop } from "@frockbot/core/agent-loop";
import type { SessionEvent } from "@frockbot/core/contracts";
import { createAgentRuntimeHarness } from "@frockbot/app/testkit";
import { AGENT_LOOP_MAX_STEPS_V1 } from "@frockbot/app/agent-runtime";
import { foundationBaseRuntimePackagesV1 } from "@frockbot/app/runtime";
import { OpenAICompatibleProvider } from "@frockbot/providers/openai-compatible";

export function gradeGreeting(events: readonly SessionEvent[]) {
  const requests = events.filter((e) => e.type === "model/request");
  const calls = events.filter((e) => e.type === "tool/call");
  const sends = events.filter((e) => e.type === "send/to-user");
  const input = calls[0]?.input;
  const text = sends[0]?.payload.type === "text" ? sends[0].payload.text : "";
  const end = events.findLast((e) => e.type === "turn/end");
  const checks = {
    oneModelCall: requests.length === 1,
    onlySendToUser: calls.length === 1 && calls[0]?.name === "send_to_user",
    finalDisposition:
      typeof input === "object" &&
      input !== null &&
      "disposition" in input &&
      input.disposition === "finish",
    oneVisibleReply: sends.length === 1,
    shortGreeting:
      text.trim().length > 0 &&
      text.length <= 240 &&
      /\b(hi|hello|hey|greetings|welcome)\b/i.test(text),
    completed: end?.outcome === "completed",
  };
  return { passed: Object.values(checks).every(Boolean), checks, text };
}

if (import.meta.main) {
  const baseUrl = process.env.OLLAMA_BASE_URL ?? "https://ollama.com";
  const model = process.env.OLLAMA_MODEL ?? "glm-5.3-flash:cloud";
  const endpoint = new URL(baseUrl);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error(
      "OLLAMA_BASE_URL must not contain credentials, query, or fragment",
    );
  if (endpoint.hostname === "ollama.com" && !process.env.OLLAMA_API_KEY)
    throw new Error(
      "Set OLLAMA_API_KEY for Ollama Cloud, or OLLAMA_BASE_URL for your server",
    );
  const transport = new OpenAICompatibleProvider({
    baseUrl: `${baseUrl.replace(/\/$/, "")}/v1`,
    apiKey: process.env.OLLAMA_API_KEY,
  });
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", ...args])
      .stdout.toString()
      .trim();
  const results = [];
  for (let repetition = 1; repetition <= 10; repetition++) {
    const root = createAgentRuntimeHarness();
    for (const pkg of foundationBaseRuntimePackagesV1())
      await root.mount(pkg.feature);
    let modelCalls = 0;
    root.llm.register({
      id: "greeting-eval",
      stream: (request, signal) => {
        if (++modelCalls > 3)
          throw new Error("Greeting exceeded three model calls");
        return transport.stream(request, signal);
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
        botId: "greeting-eval",
        sessionId: `greeting-${repetition}`,
        provider: "greeting-eval",
        model,
        turnType: "chat",
        admitEffect: () => Promise.resolve(true),
      });
      handle.agent.send("Hi");
      await handle.agent.whenIdle();
      const events = [...handle.agent.session.events];
      const result = {
        repetition,
        ...gradeGreeting(events),
        elapsedMs: Math.round(performance.now() - started),
        events,
      };
      results.push(result);
      console.log(
        `${result.passed ? "PASS" : "FAIL"} greeting ${repetition}/10 (${result.elapsedMs} ms): ${JSON.stringify(result.text)}`,
      );
      if (!result.passed) console.log(result.checks);
    } finally {
      await loop.dispose();
      await root.dispose();
    }
  }
  const report = {
    case: { input: "Hi", repetitions: 10 },
    model,
    baseUrl,
    inferenceSettings:
      "Provider/model defaults; no temperature or seed override",
    commit: git("rev-parse", "HEAD"),
    workingTreeStatus: git("status", "--porcelain"),
    patchHash: createHash("sha256").update(git("diff", "HEAD")).digest("hex"),
    evalSourceHash: createHash("sha256")
      .update(await Bun.file(import.meta.filename).text())
      .digest("hex"),
    createdAt: new Date().toISOString(),
    passed: results.every((r) => r.passed),
    results,
  };
  await mkdir(".eval-results", { recursive: true });
  const path = `.eval-results/greeting-${Date.now()}.json`;
  await writeFile(path, JSON.stringify(report, null, 2));
  console.log(`Trace: ${path}`);
  process.exitCode = report.passed ? 0 : 1;
}
