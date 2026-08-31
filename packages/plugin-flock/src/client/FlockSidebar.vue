<script setup lang="ts">
import { UiIconButton, UiSkeleton } from "@frockbot/client-ui";
import { computed, inject, onMounted } from "vue";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { flockWebDataKey } from "./state.js";
import BotAvatar from "./BotAvatar.vue";
const injectedFlock = inject(flockWebDataKey);
const injectedShell = inject(frockBotWebDataKey);
if (!injectedFlock || !injectedShell)
  throw new Error("Flock client data was not provided");
const flock = injectedFlock;
const shell = injectedShell;
flock.value.bindShell(shell);
const active = computed(() => shell.value.activeBotId);
/*
 * Hidden and archived are different states. Archiving stops a Bot working;
 * hiding only takes it out of this list, so a hidden Bot stays selectable and
 * the "Hidden" group is how a User reaches it again.
 */
function isHidden(botId: string): boolean {
  return flock.value.profiles[botId]?.hiddenFromSidebar === true;
}
const listedBots = computed(() =>
  flock.value.directory.bots.filter(
    (bot) =>
      flock.value.showArchived ||
      flock.value.lifecycles[bot.botId] !== "archived",
  ),
);
const visibleBots = computed(() =>
  listedBots.value.filter((bot) => !isHidden(bot.botId)),
);
const hiddenBots = computed(() =>
  listedBots.value.filter((bot) => isHidden(bot.botId)),
);
/** The live name the Bot's own settings hold, not the registration seed. */
function botName(botId: string, fallback: string): string {
  return flock.value.profiles[botId]?.name ?? fallback;
}
function botSubtitle(botId: string): string {
  return flock.value.profiles[botId]?.title ?? botId;
}
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
  <template v-else>
    <TransitionGroup name="flock-row" tag="div" class="flock-rows">
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
          <BotAvatar
            :bot-id="bot.botId"
            :sheep="flock.identities[bot.botId]?.sheep ?? bot.sheep"
            :label="`${botName(bot.botId, bot.initialName)} avatar`"
          />
          <span class="flock-bot-copy"
            ><strong>{{ botName(bot.botId, bot.initialName) }}</strong
            ><small>{{ botSubtitle(bot.botId) }}</small></span
          >
          <i
            v-if="active === bot.botId"
            class="flock-bot-dot"
            aria-hidden="true"
          />
        </button>
        <button
          v-if="
            flock.showArchived && flock.lifecycles[bot.botId] === 'archived'
          "
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
    <div v-if="hiddenBots.length" class="flock-hidden-group">
      <button
        type="button"
        class="flock-manage flock-hidden-toggle"
        :aria-expanded="flock.showHidden ? 'true' : 'false'"
        @click="flock.toggleHidden"
      >
        {{
          flock.showHidden
            ? `Hide ${hiddenBots.length} hidden`
            : `Show ${hiddenBots.length} hidden`
        }}
      </button>
      <TransitionGroup
        v-if="flock.showHidden"
        name="flock-row"
        tag="div"
        class="flock-rows"
      >
        <div
          v-for="bot in hiddenBots"
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
            <BotAvatar
              :bot-id="bot.botId"
              :sheep="flock.identities[bot.botId]?.sheep ?? bot.sheep"
              :label="`${botName(bot.botId, bot.initialName)} avatar`"
            />
            <span class="flock-bot-copy"
              ><strong>{{ botName(bot.botId, bot.initialName) }}</strong
              ><small>{{ botSubtitle(bot.botId) }}</small></span
            >
          </button>
        </div>
      </TransitionGroup>
    </div>
  </template>
  <p v-if="flock.error" class="flock-error" role="alert">{{ flock.error }}</p>
</template>
