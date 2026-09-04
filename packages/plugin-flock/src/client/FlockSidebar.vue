<script setup lang="ts">
import { UiSkeleton } from "@frockbot/client-ui";
import { computed, inject, onMounted } from "vue";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { flockWebDataKey } from "./state.js";
import {
  formatSidebarMessageTimeV1,
  groupSidebarBotsV1,
  partitionPinnedSidebarBotsV1,
} from "./sidebar.js";
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
/*
 * A pinned Bot is a tile above the list instead of a row inside it, never
 * both: the tile is the row, moved, so grouping runs over what is left.
 */
const partitionedBots = computed(() =>
  partitionPinnedSidebarBotsV1(visibleBots.value, flock.value.profiles),
);
const pinnedBots = computed(() => partitionedBots.value.pinned);
const groupedVisibleBots = computed(() =>
  groupSidebarBotsV1(partitionedBots.value.rest, flock.value.profiles),
);
const hiddenBots = computed(() =>
  listedBots.value.filter((bot) => isHidden(bot.botId)),
);

/** The live name the Bot's own settings hold, not the registration seed. */
function botName(botId: string, fallback: string): string {
  return flock.value.profiles[botId]?.name ?? fallback;
}
function botSubtitle(botId: string): string {
  return flock.value.profiles[botId]?.title ?? "No messages yet";
}
function previewText(botId: string): string {
  return flock.value.unread[botId]?.lastMessage?.text ?? botSubtitle(botId);
}
function previewAt(botId: string): string | undefined {
  return flock.value.unread[botId]?.lastMessage?.at;
}
function previewTime(botId: string): string {
  const at = previewAt(botId);
  return at ? formatSidebarMessageTimeV1(at) : "";
}

/*
 * Unread is backend state: the Bot Durable Object derives the count and the
 * gateway fans it out. Nothing here computes one — these read the projection.
 */
function isUnread(botId: string): boolean {
  return flock.value.unread[botId]?.unread === true;
}
/**
 * Whether the row draws an activity ring.
 *
 * The open Bot's own Turn is the Shell's — it is projecting the run into the
 * conversation and knows about it a poll sooner — so that row reads the Shell.
 * Every other row reads the unread fan-out, which is the only thing that knows
 * a Bot in another conversation is working.
 */
function isWorking(botId: string): boolean {
  if (botId === active.value) return shell.value.activeRunId !== undefined;
  return flock.value.unread[botId]?.working === true;
}
function unreadLabel(botId: string): string | undefined {
  const view = flock.value.unread[botId];
  if (!view?.unread || view.count === 0) return undefined;
  return view.capped ? `${view.count}+` : String(view.count);
}
/** Hidden Bots contribute no row, so their unread arrives as one badge. */
const hiddenUnreadCount = computed(() =>
  hiddenBots.value.reduce(
    (total, bot) => total + (flock.value.unread[bot.botId]?.count ?? 0),
    0,
  ),
);
const hiddenUnread = computed(() =>
  hiddenBots.value.some((bot) => isUnread(bot.botId)),
);
onMounted(() => void flock.value.load());
</script>

<template>
  <div class="flock-list-actions">
    <button type="button" class="flock-manage" @click="flock.toggleArchived">
      {{ flock.showArchived ? "Hide archived" : "Manage" }}
    </button>
  </div>
  <!--
    The skeleton is for a list nobody has yet, not for every request: the first
    paint happens before `load()` is even called, and a reload after creating a
    Bot must keep the list already on screen rather than blanking it. "No Bots
    yet." is a fact about the account, so it waits for an answer.
  -->
  <div v-if="!flock.loaded" class="flock-skeleton" aria-busy="true">
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
    <!--
      Pinned Bots: large tiles above the labelled groups, in pin order. The
      tile is the row moved, so clicking it selects exactly as a row does.
    -->
    <TransitionGroup
      v-if="pinnedBots.length"
      name="flock-row"
      tag="div"
      class="flock-pinned"
    >
      <button
        v-for="bot in pinnedBots"
        :key="bot.botId"
        type="button"
        class="flock-pinned-tile"
        :class="{
          active: active === bot.botId,
          archived: flock.lifecycles[bot.botId] === 'archived',
          unread: isUnread(bot.botId),
        }"
        :disabled="flock.lifecycles[bot.botId] === 'archived'"
        :aria-current="active === bot.botId ? 'true' : undefined"
        @click="flock.select(bot.botId)"
      >
        <span class="flock-pinned-art">
          <BotAvatar
            :bot-id="bot.botId"
            :sheep="flock.identities[bot.botId]?.sheep ?? bot.sheep"
            size="tile"
            :label="`${botName(bot.botId, bot.initialName)} avatar`"
            :working="isWorking(bot.botId)"
          />
          <i
            v-if="isUnread(bot.botId)"
            class="flock-pinned-dot"
            role="img"
            :aria-label="`${botName(bot.botId, bot.initialName)} has unread`"
          />
        </span>
        <span class="flock-pinned-name">{{
          botName(bot.botId, bot.initialName)
        }}</span>
      </button>
    </TransitionGroup>
    <div class="flock-groups">
      <section
        v-for="group in groupedVisibleBots.groups"
        :key="group.key"
        class="flock-group"
      >
        <h2 v-if="groupedVisibleBots.showHeadings" class="flock-group-heading">
          {{ group.label }}
        </h2>
        <TransitionGroup name="flock-row" tag="div" class="flock-rows">
          <div
            v-for="bot in group.bots"
            :key="bot.botId"
            class="flock-bot-row"
            :class="{
              active: active === bot.botId,
              archived: flock.lifecycles[bot.botId] === 'archived',
              unread: isUnread(bot.botId),
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
                :working="isWorking(bot.botId)"
              />
              <span class="flock-bot-copy">
                <span class="flock-bot-primary">
                  <strong>{{ botName(bot.botId, bot.initialName) }}</strong>
                  <time
                    v-if="previewAt(bot.botId)"
                    :datetime="previewAt(bot.botId)"
                  >
                    {{ previewTime(bot.botId) }}
                  </time>
                </span>
                <small>{{ previewText(bot.botId) }}</small>
              </span>
              <span
                v-if="unreadLabel(bot.botId) || active === bot.botId"
                class="flock-bot-indicators"
              >
                <span
                  v-if="unreadLabel(bot.botId)"
                  class="flock-unread-badge"
                  :aria-label="`${unreadLabel(bot.botId)} unread`"
                  >{{ unreadLabel(bot.botId) }}</span
                >
                <i
                  v-if="active === bot.botId"
                  class="flock-bot-dot"
                  aria-hidden="true"
                />
              </span>
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
      </section>
    </div>
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
        <span
          v-if="hiddenUnread"
          class="flock-unread-badge"
          :aria-label="`${hiddenUnreadCount} unread in hidden Bots`"
          >{{ hiddenUnreadCount > 0 ? hiddenUnreadCount : "" }}</span
        >
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
            unread: isUnread(bot.botId),
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
              :working="isWorking(bot.botId)"
            />
            <span class="flock-bot-copy">
              <span class="flock-bot-primary">
                <strong>{{ botName(bot.botId, bot.initialName) }}</strong>
                <time
                  v-if="previewAt(bot.botId)"
                  :datetime="previewAt(bot.botId)"
                >
                  {{ previewTime(bot.botId) }}
                </time>
              </span>
              <small>{{ previewText(bot.botId) }}</small>
            </span>
          </button>
        </div>
      </TransitionGroup>
    </div>
  </template>
  <p v-if="flock.error" class="flock-error" role="alert">{{ flock.error }}</p>
</template>
