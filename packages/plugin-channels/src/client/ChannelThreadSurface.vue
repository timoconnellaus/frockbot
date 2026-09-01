<script setup lang="ts">
/**
 * One Channel, as a room.
 *
 * Bubbles grouped by sender under that sender's own avatar, the tapbacks the
 * log recorded folded into chips beneath each one, and a members strip that
 * says who is in the room. The grouping and the folding are
 * `./thread.ts` — pure, and tested without a DOM; this file is the drawing.
 *
 * What a Bot looks like belongs to the Flock Package, so the avatar is its
 * component rather than a second opinion about Bot identity kept here. And an
 * external Channel shows the *label* of the Connection it speaks through: the
 * token was returned once, at connect, and nothing since can read it.
 */
import { computed, inject } from "vue";
import BotAvatar from "@frockbot/plugin-flock/client/BotAvatar.vue";
import { flockWebDataKey } from "@frockbot/plugin-flock/client/state";
import { UiMarkdown } from "@frockbot/client-ui";
import { channelsWebDataKey } from "./state.js";
import { projectChannelMembersV1, projectChannelThreadV1 } from "./thread.js";

const channels = inject(channelsWebDataKey);
if (!channels) throw new Error("Channels client data was not provided");
const flock = inject(flockWebDataKey);

const thread = computed(() => channels.value.thread);
const groups = computed(() =>
  projectChannelThreadV1(thread.value?.messages ?? [], {
    ...(channels.value.botId === undefined
      ? {}
      : { selfBotId: channels.value.botId }),
    ...(channels.value.activeChannelId === undefined
      ? {}
      : {
          lastReadSeq:
            channels.value.unread[channels.value.activeChannelId]?.lastReadSeq,
        }),
  }),
);
const members = computed(() =>
  projectChannelMembersV1(
    thread.value?.channel.members ?? [],
    thread.value?.messages ?? [],
  ),
);

const botName = (botId: string): string =>
  flock?.value.profiles[botId]?.name ?? botId;

const senderLabel = (group: {
  senderBotId?: string;
  senderPeer?: string;
}): string => {
  if (group.senderBotId !== undefined) return botName(group.senderBotId);
  if (group.senderPeer !== undefined) return group.senderPeer;
  return "Someone";
};

const sheepFor = (botId: string) => flock?.value.identities[botId]?.sheep;

const submit = (event: Event): void => {
  event.preventDefault();
  void channels.value.post();
};
</script>

<template>
  <section class="channel-thread" aria-label="Channel">
    <p v-if="!thread" class="channel-empty">Choose a Channel to open it.</p>
    <template v-else>
      <header class="channel-head">
        <h3>{{ thread.channel.name }}</h3>
        <p v-if="thread.connectionLabel" class="channel-connection">
          Connected through <strong>{{ thread.connectionLabel }}</strong>
          <span v-if="thread.platform"> on {{ thread.platform }}</span>
        </p>
        <p v-else-if="!thread.channel.active" class="channel-connection">
          Disconnected. The history stays; nothing new arrives.
        </p>
      </header>

      <!--
        Who is in the room. A peer is not a member — an external Channel has one
        Bot and one person on the other end — so the strip names both rather
        than describing the room by its membership alone.
      -->
      <ul class="channel-members" aria-label="Members">
        <li v-for="member in members" :key="member.botId ?? member.peer">
          <BotAvatar
            v-if="member.botId && sheepFor(member.botId)"
            :bot-id="member.botId"
            :sheep="sheepFor(member.botId)!"
            size="mini"
            :label="`${botName(member.botId)} avatar`"
          />
          <span>{{ member.botId ? botName(member.botId) : member.peer }}</span>
        </li>
      </ul>

      <div class="channel-log">
        <p v-if="groups.length === 0" class="channel-empty">
          Nothing has been said here yet.
        </p>
        <template v-for="group in groups" :key="group.groupId">
          <p v-if="group.firstUnread" class="channel-divider">New</p>
          <article class="channel-group" :class="{ mine: group.mine }">
            <div class="channel-avatar">
              <BotAvatar
                v-if="group.senderBotId && sheepFor(group.senderBotId)"
                :bot-id="group.senderBotId"
                :sheep="sheepFor(group.senderBotId)!"
                size="mini"
                :label="`${senderLabel(group)} avatar`"
              />
              <span v-else class="channel-peer-mark" aria-hidden="true">@</span>
            </div>
            <div class="channel-bubbles">
              <small class="channel-sender">{{ senderLabel(group) }}</small>
              <div
                v-for="entry in group.messages"
                :key="entry.messageId"
                class="channel-bubble"
              >
                <UiMarkdown :text="entry.text" />
                <ul
                  v-if="entry.reactions.length > 0"
                  class="channel-tapbacks"
                  aria-label="Reactions"
                >
                  <li
                    v-for="chip in entry.reactions"
                    :key="chip.emoji"
                    class="channel-tapback"
                    :class="{ mine: chip.mine }"
                    :title="chip.botIds.join(', ')"
                  >
                    <span aria-hidden="true">{{ chip.emoji }}</span>
                    <span>{{ chip.count }}</span>
                  </li>
                </ul>
              </div>
            </div>
          </article>
        </template>
      </div>

      <form class="channel-composer" @submit="submit">
        <label class="channel-composer-label" :for="'channel-composer'"
          >Say something in this room</label
        >
        <textarea
          id="channel-composer"
          :value="channels.draft"
          :disabled="channels.posting || !thread.channel.active"
          rows="2"
          @input="
            channels.setDraft(($event.target as HTMLTextAreaElement).value)
          "
        ></textarea>
        <p v-if="channels.postFailure" class="channel-failure" role="alert">
          {{ channels.postFailure }}
        </p>
        <button
          type="submit"
          :disabled="
            channels.posting ||
            !thread.channel.active ||
            channels.draft.trim().length === 0
          "
        >
          {{ channels.posting ? "Posting…" : "Post" }}
        </button>
      </form>
    </template>
  </section>
</template>

<style scoped>
.channel-thread {
  display: flex;
  height: 100%;
  flex-direction: column;
  gap: 12px;
}

.channel-head h3 {
  margin: 0;
  font-size: var(--frock-text-md);
}

.channel-connection {
  margin: 4px 0 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-xs);
}

.channel-members {
  display: flex;
  margin: 0;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0;
  list-style: none;
}

.channel-members li {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-control);
  padding: 2px 8px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-xs);
}

.channel-log {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
}

.channel-empty {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.channel-divider {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--frock-action-primary);
  font-size: var(--frock-text-xs);
  text-transform: uppercase;
}

.channel-divider::after {
  border-top: 1px solid var(--frock-action-primary);
  content: "";
  flex: 1;
}

.channel-group {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.channel-avatar {
  flex: none;
}

.channel-peer-mark {
  display: inline-flex;
  width: var(--frock-avatar-sm);
  height: var(--frock-avatar-sm);
  align-items: center;
  justify-content: center;
  border-radius: var(--frock-radius-control);
  background: var(--frock-surface-subtle);
  color: var(--frock-text-muted);
}

.channel-bubbles {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 4px;
}

.channel-sender {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-xs);
}

.channel-bubble {
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-raised);
  padding: 8px 10px;
  font-size: var(--frock-text-sm);
}

.channel-group.mine .channel-bubble {
  background: var(--frock-surface-accent-soft);
}

.channel-tapbacks {
  display: flex;
  margin: 6px 0 0;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0;
  list-style: none;
}

.channel-tapback {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-control);
  background: var(--frock-surface);
  padding: 0 6px;
  font-size: var(--frock-text-xs);
  line-height: 18px;
}

.channel-tapback.mine {
  border-color: var(--frock-accent-border);
  background: var(--frock-accent-surface);
  color: var(--frock-accent-text);
}

.channel-composer {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.channel-composer-label {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-xs);
}

.channel-composer textarea {
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-control);
  background: var(--frock-surface);
  padding: 8px;
  color: var(--frock-text);
  font: inherit;
  font-size: var(--frock-text-sm);
  resize: vertical;
}

.channel-composer button {
  align-self: flex-end;
  border: 0;
  border-radius: var(--frock-radius-control);
  background: var(--frock-action-primary);
  padding: 6px 14px;
  color: var(--frock-on-accent);
  font-size: var(--frock-text-sm);
  cursor: pointer;
}

.channel-composer button:disabled {
  background: var(--frock-surface-disabled);
  color: var(--frock-text-disabled);
  cursor: not-allowed;
}

.channel-failure {
  margin: 0;
  color: var(--frock-danger-text);
  font-size: var(--frock-text-xs);
}
</style>
