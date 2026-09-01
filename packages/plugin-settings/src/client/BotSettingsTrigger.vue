<script setup lang="ts">
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { UiIconButton } from "@frockbot/client-ui";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { inject } from "vue";

const surfaces = inject(clientSurfaceRegistryKey);
const web = inject(frockBotWebDataKey);
if (!surfaces || !web)
  throw new Error("settings client services were not provided");
</script>

<template>
  <UiIconButton
    v-if="
      web.settingsAvailable &&
      web.activeBotId &&
      surfaces.activeId.value !== 'bot-settings'
    "
    class="bot-settings-trigger"
    icon="gear"
    label="Bot settings"
    :pressed="surfaces.activeId.value === 'bot-settings'"
    @click="surfaces.open('bot-settings')"
  />
</template>
