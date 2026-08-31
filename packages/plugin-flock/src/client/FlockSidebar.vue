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
const visibleBots = computed(() =>
  flock.value.directory.bots.filter(
    (bot) =>
      flock.value.showArchived ||
      flock.value.lifecycles[bot.botId] !== "archived",
  ),
);
onMounted(() => void flock.value.load());
</script>
<template>
  <div class="flock-sidebar-heading">
    <span>Your flock</span>
    <span class="flock-heading-actions">
      <button type="button" class="flock-manage" @click="flock.toggleArchived">
        {{ flock.showArchived ? "Hide archived" : "Manage" }}
      </button>
      <UiIconButton
        icon="plus"
        label="Create Bot"
        size="sm"
        @click="flock.openCreate"
      />
    </span>
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
    <div
      v-for="bot in visibleBots"
      :key="bot.botId"
      class="flock-bot-row"
      :class="{
        active: active === bot.botId,
        archived: flock.lifecycles[bot.botId] === 'archived',
      }"
    >
      <button
        type="button"
        class="flock-bot-select"
        :disabled="flock.lifecycles[bot.botId] === 'archived'"
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
        <i
          v-if="active === bot.botId"
          class="flock-bot-dot"
          aria-hidden="true"
        />
      </button>
      <button
        v-if="flock.showArchived && flock.lifecycles[bot.botId] === 'archived'"
        type="button"
        class="flock-lifecycle"
        @click="flock.restore(bot.botId)"
      >
        Restore
      </button>
      <button
        v-else-if="flock.showArchived"
        type="button"
        class="flock-lifecycle"
        @click="flock.openArchive(bot.botId)"
      >
        Archive
      </button>
    </div>
  </TransitionGroup>
  <p v-if="flock.error" class="flock-error" role="alert">{{ flock.error }}</p>
</template>
