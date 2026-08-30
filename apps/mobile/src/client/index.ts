import { createApp, ref, type App } from "vue";
import { createMobileHost, type MobileHost } from "../host/index.ts";
import { createCapacitorAdapters } from "../host/capacitor-adapters.ts";
import {
  authSessionKey,
  defaultGatewayUrl,
  mobileBotIdKey,
  mobileHostKey,
} from "./app-context.ts";
import { createAuthSession } from "./auth.ts";
import { createDevicePreferenceStore } from "./capacitor-preferences.ts";
import MobileAuthGate from "./MobileAuthGate.vue";
import {
  createOwnedMobileDisposer,
  retainStartedResource,
} from "./owned-disposal.ts";
import "./mobile.css";

const browserFetch = globalThis.fetch.bind(globalThis);
const auth = createAuthSession({
  store: createDevicePreferenceStore(),
  fetch: (input, init) => {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new Error("gateway requests require a valid URL");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new Error("gateway requests require an http(s) URL");
    return browserFetch(url, init);
  },
  defaultGatewayUrl: defaultGatewayUrl || undefined,
});
const botId = ref("default");
let host: MobileHost | undefined;
let app: App | undefined;
let disposed = false;
const disposeOwnedClient = createOwnedMobileDisposer(
  () => {
    app?.unmount();
    app = undefined;
  },
  async () => {
    const mountedHost = host;
    host = undefined;
    await mountedHost?.dispose();
  },
);

export function disposeMobileClient(): Promise<void> {
  disposed = true;
  return disposeOwnedClient();
}

async function start(): Promise<void> {
  try {
    host = await retainStartedResource(
      createMobileHost({ adapters: createCapacitorAdapters() }),
      () => disposed,
    );
  } catch (error) {
    console.error(
      "Optional mobile capability host failed",
      error instanceof Error ? error.message : "unknown failure",
    );
  }
  if (disposed) return;
  app = createApp(MobileAuthGate);
  app.provide(authSessionKey, auth);
  app.provide(mobileBotIdKey, botId);
  if (host) app.provide(mobileHostKey, host);
  app.mount("#app");
}

window.addEventListener("pagehide", () => void disposeMobileClient(), {
  once: true,
});
void start();
