import type { ClientPlugin } from "@frockbot/client-core";

// Worker clients expose a safe inert adapter when Sprite authority is absent.
import { ref } from "vue";
import {
  flySpriteComputerKey,
  type FlySpriteComputerState,
} from "../shared.js";
import FlySpriteComputerCard from "./FlySpriteComputerCard.vue";
import "./styles.css";

export const flySpriteClientPlugin: ClientPlugin = (ctx) => {
  const unavailable = () =>
    Promise.reject(
      new Error("Fly Sprite control is unavailable in this application host"),
    );
  const computer = ref<FlySpriteComputerState>({
    phase: "missing-token",
    spriteName: "unconfigured",
    message: "Fly Sprite is not configured for this application host",
    takingControl: false,
    connect: unavailable,
    takeControl: unavailable,
    releaseControl: unavailable,
    retry: unavailable,
  });
  return [
    ctx.provide(flySpriteComputerKey, computer),
    ctx.slot({
      slot: "frockbot.computer",
      order: 10,
      component: FlySpriteComputerCard,
    }),
  ];
};

export default flySpriteClientPlugin;
