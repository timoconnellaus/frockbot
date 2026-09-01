<script setup lang="ts">
/**
 * The Channels list, beside the Bots.
 *
 * The rooms the shell's active Bot is in. The list follows that Bot: a Channel
 * is a room between Bots, so which rooms are worth showing is decided by whose
 * conversation is open, and the Package that owns Bot selection is asked
 * rather than guessed at.
 *
 * Unread is backend state. Nothing here computes a badge — the User Durable
 * Object derives it from the Channel's `seq` and its pending deliveries, and
 * this reads the projection.
 */
import { computed, inject, watch } from "vue";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { channelsWebDataKey } from "./state.js";

const channels = inject(channelsWebDataKey);
if (!channels) throw new Error("Channels client data was not provided");
const shell = inject(frockBotWebDataKey);
if (!shell) throw new Error("Shell client data was not provided");

watch(
  () => shell.value.activeBotId,
  (botId) => {
    if (!botId) return;
    void channels.value.load(botId);
  },
  { immediate: true },
);

const rooms = computed(() =>
  channels.value.channels.filter((channel) => channel.kind !== "webui"),
);

const badge = (channelId: string): string | undefined => {
  const view = channels.value.unread[channelId];
  if (!view?.unread || view.count === 0) return undefined;
  return view.capped ? `${view.count}+` : String(view.count);
};

const isUnread = (channelId: string): boolean =>
  channels.value.unread[channelId]?.unread === true;

const subtitle = (channel: { kind: string; members: string[] }): string =>
  channel.kind === "external"
    ? "Connected"
    : `${channel.members.length} member${channel.members.length === 1 ? "" : "s"}`;
</script>

<template>
  <section v-if="rooms.length > 0" class="channels-list" aria-label="Channels">
    <h3 class="channels-heading">Channels</h3>
    <div
      v-for="channel in rooms"
      :key="channel.channelId"
      class="channels-row"
      :class="{
        active: channels.activeChannelId === channel.channelId,
        unread: isUnread(channel.channelId),
        inactive: !channel.active,
      }"
    >
      <button
        type="button"
        class="channels-select"
        :aria-current="
          channels.activeChannelId === channel.channelId ? 'true' : undefined
        "
        @click="channels.open(channel.channelId)"
      >
        <span class="channels-mark" aria-hidden="true">#</span>
        <span class="channels-copy"
          ><strong>{{ channel.name }}</strong
          ><small>{{ subtitle(channel) }}</small></span
        >
        <span
          v-if="badge(channel.channelId)"
          class="channels-badge"
          :aria-label="`${badge(channel.channelId)} unread`"
          >{{ badge(channel.channelId) }}</span
        >
      </button>
    </div>
  </section>
</template>

<style scoped>
.channels-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 12px;
}

.channels-heading {
  margin: 0 0 4px;
  padding: 0 12px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-xs);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.channels-row {
  border-radius: var(--frock-radius-control);
}

.channels-row.active {
  background: var(--frock-surface-raised);
}

.channels-select {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  border: 0;
  border-radius: var(--frock-radius-control);
  background: transparent;
  padding: 6px 12px;
  color: var(--frock-text);
  text-align: left;
  cursor: pointer;
}

.channels-select:hover {
  background: var(--frock-fill-hover);
}

.channels-mark {
  color: var(--frock-text-muted);
}

.channels-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
}

.channels-copy strong {
  overflow: hidden;
  font-size: var(--frock-text-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.channels-copy small {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-xs);
}

.channels-row.unread .channels-copy strong {
  color: var(--frock-text);
  font-weight: 700;
}

.channels-row.inactive .channels-copy small {
  font-style: italic;
}

.channels-badge {
  display: inline-flex;
  min-width: 18px;
  align-items: center;
  justify-content: center;
  border-radius: var(--frock-radius-control);
  background: var(--frock-action-primary);
  padding: 0 5px;
  color: var(--frock-on-accent);
  font-size: var(--frock-text-xs);
  font-weight: 600;
  line-height: 18px;
}
</style>
