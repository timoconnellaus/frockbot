import { inject, type InjectionKey, type Ref } from "vue";
import type { MobileHost } from "../host/index.ts";
import type { AuthSession } from "./auth.ts";

export const authSessionKey: InjectionKey<AuthSession> = Symbol(
  "frockbot-mobile-auth-session",
);

export const mobileHostKey: InjectionKey<MobileHost> = Symbol(
  "frockbot-mobile-host",
);

export const mobileBotIdKey: InjectionKey<Ref<string>> = Symbol(
  "frockbot-mobile-bot-id",
);

export const defaultGatewayUrl: string =
  import.meta.env.VITE_FROCKBOT_GATEWAY_URL ?? "";

export function injectRequired<T>(key: InjectionKey<T>, label: string): T {
  const value = inject(key);
  if (value === undefined) throw new Error(`${label} was not provided`);
  return value;
}
