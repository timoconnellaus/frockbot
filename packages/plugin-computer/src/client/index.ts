/// <reference path="../env.d.ts" />

import type { Context } from "@cordisjs/client";
import ComputerCard from "./ComputerCard.vue";
import "./styles.css";

// The viewer UI is shared by every provider capable of publishing a viewer.
const computerWebPlugin = (ctx: Context) => {
  ctx.client.router.slot({
    type: "frockbot.computer",
    order: 10,
    component: ComputerCard,
  });
};

export default computerWebPlugin;
