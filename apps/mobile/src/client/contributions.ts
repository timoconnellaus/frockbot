import ClockCard from "@frockbot/plugin-clock/client/ClockCard.vue";
import {
  createContributionRegistry,
  type ContributionRegistry,
} from "./contribution-registry.ts";

export const RIGHT_PANEL_SLOT = "frockbot.right-panel";
export const COMPUTER_SLOT = "frockbot.computer";

export const mobileContributions: ContributionRegistry =
  createContributionRegistry([
    {
      slot: RIGHT_PANEL_SLOT,
      id: "clock.card",
      order: 100,
      component: ClockCard,
    },
  ]);
