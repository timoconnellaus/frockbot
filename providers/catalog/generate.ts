import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

const providers = builtinProviders().map((provider) => ({
  id: provider.id,
  name: provider.name,
  apiKey: Boolean(provider.auth.apiKey),
}));
await Bun.write(
  new URL("./providers.json", import.meta.url),
  JSON.stringify(providers, null, 2) + "\n",
);
