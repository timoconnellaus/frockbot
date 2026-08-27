import type { LlmProvider } from "@frockbot/agent-core";
import type { Plugin } from "cordis";

export const FOUNDATION_PROVIDER = "foundation";
export const FOUNDATION_MODEL = "deterministic-v1";

export const foundationProvider: LlmProvider = {
  id: FOUNDATION_PROVIDER,
  async *stream(request, signal) {
    signal.throwIfAborted();
    const latest = request.messages.at(-1);
    if (latest?.role === "tool") {
      const label = latest.name === "echo" ? "Echo" : latest.name;
      yield { type: "text-delta", text: `${label}: ` };
      await Promise.resolve();
      signal.throwIfAborted();
      yield { type: "text-delta", text: latest.content };
      yield { type: "finish", reason: "completed" };
      return;
    }
    const user = request.messages.findLast(
      (message) => message.role === "user",
    );
    const text = user?.role === "user" ? user.content : "";
    yield { type: "text-delta", text: "Cordis runtime: " };
    await Promise.resolve();
    signal.throwIfAborted();
    yield { type: "text-delta", text };
    yield { type: "finish", reason: "completed" };
  },
};

export const foundationProviderPlugin: Plugin.Function = (ctx) =>
  ctx.llm.register(foundationProvider);
foundationProviderPlugin.inject = ["llm"];

export default foundationProviderPlugin;
