import type { InjectionKey, Ref } from "vue";

export interface ClockWebData {
  timezone: string;
  lastTime: string;
  refresh(): Promise<string>;
}

export const clockWebDataKey: InjectionKey<Ref<ClockWebData>> = Symbol(
  "frockbot-clock-web-data",
);
