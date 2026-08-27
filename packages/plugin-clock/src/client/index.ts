/// <reference path="../env.d.ts" />

import type { Context } from "@cordisjs/client";
import ClockCard from "./ClockCard.vue";
import "./styles.css";

const clockWebPlugin = (ctx: Context) => {
  ctx.client.router.slot({
    type: "frockbot.right-panel",
    order: 100,
    component: ClockCard,
  });
};

export default clockWebPlugin;
