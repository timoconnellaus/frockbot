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
    <span>Your flock</span
    ><span class="flock-heading-actions"
      ><button type="button" @click="flock.toggleArchived">
        {{ flock.showArchived ? "Hide archived" : "Manage" }}</button
      ><button type="button" aria-label="Create Bot" @click="flock.openCreate">
        ＋
      </button></span
    >
  </div>
  <p v-if="flock.loading" class="flock-empty">Loading your flock…</p>
  <p v-else-if="!flock.directory.bots.length" class="flock-empty">
    No Bots yet. Add your first sheep.
  </p>
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
    <button
      v-if="flock.showArchived && flock.lifecycles[bot.botId] === 'archived'"
      type="button"
      @click="flock.restore(bot.botId)"
    >
      Restore
    </button>
    <button
      v-else-if="flock.showArchived"
      type="button"
      @click="flock.openArchive(bot.botId)"
    >
      Archive
    </button>
  </div>
  <p v-if="flock.error" class="flock-error">{{ flock.error }}</p>
</template>
