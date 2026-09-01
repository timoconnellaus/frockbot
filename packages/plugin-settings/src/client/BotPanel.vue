<script setup lang="ts">
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { settingsLinkV1 } from "@frockbot/plugin-shell/settings-links";
import { UiAnchor } from "@frockbot/client-ui";
import { computed, inject, onMounted } from "vue";

const providedWeb = inject(frockBotWebDataKey);
if (!providedWeb) throw new Error("settings client services were not provided");
const web = providedWeb;
const botName = computed(
  () => web.value.botSettings?.profile.name ?? "This Bot",
);
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
      <k-slot name="frockbot.computer" />
      <p>{{ botName }}'s screen</p>
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

.bot-panel__computer p {
  margin: 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
  text-align: center;
}
</style>
