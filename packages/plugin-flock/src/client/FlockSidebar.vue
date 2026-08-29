<script setup lang="ts">
import { computed, inject, onMounted } from "vue";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { flockWebDataKey } from "./state.js";
import SheepAvatar from "./SheepAvatar.vue";
const flock = inject(flockWebDataKey);
const shell = inject(frockBotWebDataKey);
if (!flock || !shell) throw new Error("Flock client data was not provided");
flock.value.bindShell(shell);
const active = computed(() => shell.value.activeBotId);
onMounted(() => void flock.value.load());
</script>
<template>
  <div class="flock-sidebar-heading">
    <span>Your flock</span
    ><button type="button" aria-label="Create Bot" @click="flock.openCreate">
      ＋
    </button>
  </div>
  <p v-if="flock.loading" class="flock-empty">Loading your flock…</p>
  <p v-else-if="!flock.directory.bots.length" class="flock-empty">
    No Bots yet. Add your first sheep.
  </p>
  <button
    v-for="bot in flock.directory.bots"
    :key="bot.botId"
    type="button"
    class="flock-bot-row"
    :class="{ active: active === bot.botId }"
    @click="flock.select(bot.botId)"
  >
    <SheepAvatar
      :sheep="flock.identities[bot.botId]?.sheep ?? bot.sheep"
      :label="`${bot.initialName} sheep`"
    />
    <span
      ><strong>{{ bot.initialName }}</strong
      ><small>{{ bot.botId }}</small></span
    >
    <i v-if="active === bot.botId" aria-hidden="true">●</i>
  </button>
  <p v-if="flock.error" class="flock-error">{{ flock.error }}</p>
</template>
