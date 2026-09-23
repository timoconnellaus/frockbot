import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

// Consumer subscriptions and coding plans whose terms forbid a hosted,
// general-purpose or unattended client, or whose adapter poses as another
// client. See docs/model-providers.md.
const excluded = new Set([
  "github-copilot",
  "kimi-coding",
  "openai-codex",
  "opencode-go",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "qwen-token-plan-individual",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "zai",
  "zai-coding-cn",
]);

const providers = builtinProviders()
  .filter((provider) => provider.auth.apiKey && !excluded.has(provider.id))
  .map((provider) => ({ id: provider.id, name: provider.name }));
await Bun.write(
  new URL("./providers.json", import.meta.url),
  JSON.stringify(providers, null, 2) + "\n",
);
