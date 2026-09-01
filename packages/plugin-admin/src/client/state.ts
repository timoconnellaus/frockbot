import type { InjectionKey } from "vue";

export type AdminRequest = (
  path: string,
  method?: "GET" | "POST",
  body?: string,
) => Promise<unknown>;

export const adminRequestKey: InjectionKey<AdminRequest> = Symbol(
  "frockbot.admin-request",
);
