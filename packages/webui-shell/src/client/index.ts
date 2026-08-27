/// <reference path="../env.d.ts" />

import type { Context } from "@cordisjs/client";
import FrockBotApp from "./FrockBotApp.vue";
import "./styles.css";

const frockBotWebUI = (ctx: Context) => {
  ctx.client.router.slot({
    type: "root",
    order: 10_000,
    component: FrockBotApp,
  });
};

export default frockBotWebUI;
