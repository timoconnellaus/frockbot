/// <reference path="../env.d.ts" />

import type { Context } from "@cordisjs/client";
import FlySpriteComputerCard from "./FlySpriteComputerCard.vue";
import "./styles.css";

const flySpriteWebPlugin = (ctx: Context) => {
  ctx.client.router.slot({
    type: "frockbot.computer",
    order: 10,
    component: FlySpriteComputerCard,
  });
};

export default flySpriteWebPlugin;
