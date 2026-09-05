<script setup lang="ts">
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { settingsLinkV1 } from "@frockbot/plugin-shell/settings-links";
import { UiAnchor } from "@frockbot/client-ui";
import { computed, inject, onMounted } from "vue";

const providedWeb = inject(frockBotWebDataKey);
if (!providedWeb) throw new Error("settings client services were not provided");
const web = providedWeb;
const computerLink = computed(() =>
  settingsLinkV1({
    anchor: "bot-info-computer",
    botId: web.value.activeBotId,
  }),
);

onMounted(() => void web.value.loadBotSettings());
</script>

<template>
  <section class="bot-panel" aria-label="Bot panel">
    <UiAnchor
      anchor="bot-info-computer"
      label="Computer"
      :href="computerLink"
      class="bot-panel__computer"
    >
      <!--
        No caption. The card below this slot says what it is in every state it
        has — "No computer" with the sentence explaining it, "Computer" with
        its screen status — and a line reading "Alpha's screen" under a card
        that has just said the Bot has no computer contradicts the card while
        repeating it. The panel belongs to one Bot and its header names it.
      -->
      <k-slot name="frockbot.computer" />
    </UiAnchor>
    <k-slot name="frockbot.bot-panel-sections" />
  </section>
</template>

<style scoped>
.bot-panel {
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.bot-panel__computer {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
