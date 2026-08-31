<script setup lang="ts">
import { UiIconButton, UiSkeleton } from "@frockbot/client-ui";
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
    <span>Your flock</span>
    <UiIconButton
      icon="plus"
      label="Create Bot"
      size="sm"
      @click="flock.openCreate"
    />
  </div>
  <div v-if="flock.loading" class="flock-skeleton" aria-busy="true">
    <span class="flock-skeleton-label">Loading your flock…</span>
    <div v-for="row in 3" :key="row" class="flock-skeleton-row">
      <UiSkeleton shape="circle" />
      <span class="flock-skeleton-copy">
        <UiSkeleton :width="row === 2 ? '48%' : '62%'" />
        <UiSkeleton width="36%" />
      </span>
    </div>
  </div>
  <p v-else-if="!flock.directory.bots.length" class="flock-empty">
    No Bots yet. Add your first sheep.
  </p>
  <TransitionGroup v-else name="flock-row" tag="div" class="flock-rows">
    <button
      v-for="bot in flock.directory.bots"
      :key="bot.botId"
      type="button"
      class="flock-bot-row"
      :class="{ active: active === bot.botId }"
      :aria-current="active === bot.botId ? 'true' : undefined"
      @click="flock.select(bot.botId)"
    >
      <SheepAvatar
        :sheep="flock.identities[bot.botId]?.sheep ?? bot.sheep"
        :label="`${bot.initialName} sheep`"
      />
      <span class="flock-bot-copy"
        ><strong>{{ bot.initialName }}</strong
        ><small>{{ bot.botId }}</small></span
      >
      <i v-if="active === bot.botId" class="flock-bot-dot" aria-hidden="true" />
    </button>
  </TransitionGroup>
  <p v-if="flock.error" class="flock-error" role="alert">{{ flock.error }}</p>
</template>
