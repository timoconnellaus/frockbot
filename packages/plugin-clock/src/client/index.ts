/// <reference path="../env.d.ts" />

import type { ClientPlugin } from "@frockbot/client-core";
import { ref } from "vue";
import { clockWebDataKey, type ClockWebData } from "../shared.js";
import ClockCard from "./ClockCard.vue";
import "./styles.css";

export const clockClientPlugin: ClientPlugin = (ctx) => {
  const clock = ref<ClockWebData>({
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    lastTime: "Not requested yet",
    async refresh() {
      const botId = new URL(window.location.href).searchParams.get("bot");
      if (!botId) throw new Error("Select a Bot before requesting the time");
      const result = await ctx.transport.turn(
        botId,
        "/time",
        new AbortController().signal,
        crypto.randomUUID(),
      );
      clock.value.lastTime = result.text;
      return result.text;
    },
  });
  return [
    ctx.provide(clockWebDataKey, clock),
    ctx.slot({
      slot: "frockbot.right-panel",
      order: 100,
      component: ClockCard,
    }),
  ];
};

export default clockClientPlugin;
