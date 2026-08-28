import type { ClientPlugin } from "@frockbot/client-core";
import { ref } from "vue";
import { computerKey, type ComputerState } from "../shared.js";
import ComputerCard from "./ComputerCard.vue";
import "./styles.css";

export const computerClientPlugin: ClientPlugin = (ctx) => {
  const unavailable = () =>
    Promise.reject(new Error("Computer control is unavailable in this host"));
  const computer = ref<ComputerState>({
    phase: "unconfigured",
    botId: "unconfigured",
    providerLabel: "unconfigured",
    message: "No Computer provider is configured for this host",
    takingControl: false,
    connect: unavailable,
    takeControl: unavailable,
    releaseControl: unavailable,
    retry: unavailable,
  });
  return [
    ctx.provide(computerKey, computer),
    ctx.slot({
      slot: "frockbot.computer",
      order: 10,
      component: ComputerCard,
    }),
  ];
};

export default computerClientPlugin;
