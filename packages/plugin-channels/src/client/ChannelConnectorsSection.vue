<script setup lang="ts">
/**
 * Connectors, inside the Bot info pane's Channels card (register rows 36 and
 * 51).
 *
 * The pane owns the card, the heading and the anchor a deep link cites, and
 * knows nothing about rooms or keys — so this contributes the content and no
 * heading of its own. Two headings named "Channels" in one region would be two
 * answers to "where do connectors live", and the pane already gave one.
 *
 * Connect names a Connection and gets a Channel back; disconnect revokes the
 * key and stops the deliveries, keeping the record and its history. What is
 * shown for a connected Channel is the Connection's *label* — the webhook path
 * is returned once, to the User who asked for it, and is held only for as long
 * as this section stays open. Nothing here can read it back, because no route
 * returns it twice.
 */
import { computed, inject } from "vue";
import { channelsWebDataKey } from "./state.js";

const channels = inject(channelsWebDataKey);
if (!channels) throw new Error("Channels client data was not provided");

/** The one platform this deployment carries today. */
const PLATFORM = "telegram";

const connected = computed(() =>
  channels.value.channels.filter((channel) => channel.kind === "external"),
);
const rooms = computed(() =>
  channels.value.channels.filter((channel) => channel.kind === "group"),
);
</script>

<template>
  <div class="channel-connectors">
    <p v-if="rooms.length > 0" class="channel-connectors-rooms">
      In {{ rooms.length }} group
      {{ rooms.length === 1 ? "channel" : "channels" }}.
    </p>

    <ul v-if="connected.length > 0" class="channel-connector-list">
      <li v-for="channel in connected" :key="channel.channelId">
        <span class="channel-connector-copy"
          ><strong>{{ channel.name }}</strong
          ><small>{{
            channel.active ? "Connected" : "Disconnected"
          }}</small></span
        >
        <button
          v-if="channel.active"
          type="button"
          :disabled="channels.connect.busy"
          @click="channels.disconnect(channel.channelId)"
        >
          Disconnect
        </button>
      </li>
    </ul>

    <form
      class="channel-connect-form"
      @submit.prevent="channels.connectChannel(PLATFORM)"
    >
      <label for="channel-connection">Connection</label>
      <input
        id="channel-connection"
        :value="channels.connect.connectionId"
        placeholder="Connection id"
        @input="
          channels.connect.connectionId = (
            $event.target as HTMLInputElement
          ).value
        "
      />
      <label for="channel-connect-name">Name</label>
      <input
        id="channel-connect-name"
        :value="channels.connect.name"
        placeholder="Telegram"
        @input="
          channels.connect.name = ($event.target as HTMLInputElement).value
        "
      />
      <button type="submit" :disabled="channels.connect.busy">
        {{ channels.connect.busy ? "Connecting…" : "Connect" }}
      </button>
    </form>

    <p v-if="channels.connect.error" class="channel-connect-error" role="alert">
      {{ channels.connect.error }}
    </p>
    <p v-if="channels.connect.webhookPath" class="channel-connect-hook">
      Point the platform at this path. It is shown once and never stored where a
      later read could reach it.
      <code>{{ channels.connect.webhookPath }}</code>
    </p>
  </div>
</template>

<style scoped>
/*
 * The card is the pane's; this is its content. Every box here is allowed to
 * shrink below its content — `min-width: 0` on each flex item — because the
 * pane is 390px wide on a phone and the house rule is that wide content
 * scrolls inside its own container rather than pushing the page sideways.
 */
.channel-connectors {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 8px;
}

.channel-connectors-rooms {
  margin: 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-xs);
}

.channel-connector-list {
  display: flex;
  min-width: 0;
  margin: 0;
  flex-direction: column;
  gap: 6px;
  padding: 0;
  list-style: none;
}

.channel-connector-list li {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-control);
  padding: 6px 8px;
}

.channel-connector-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.channel-connector-copy strong {
  overflow: hidden;
  font-size: var(--frock-text-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.channel-connector-copy small {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-xs);
}

.channel-connect-form {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.channel-connect-form label {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-xs);
}

/*
 * An input carries an intrinsic `size` width that is wider than a phone's
 * pane. `min-width: 0` with `width: 100%` and a border box is what makes it
 * obey the column instead of setting its width.
 */
.channel-connect-form input {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-control);
  background: var(--frock-surface);
  padding: 6px 8px;
  color: var(--frock-text);
  font: inherit;
  font-size: var(--frock-text-sm);
}

.channel-connect-form button,
.channel-connector-list button {
  flex: none;
  align-self: flex-start;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-control);
  background: var(--frock-action-secondary);
  padding: 4px 10px;
  color: var(--frock-action-secondary-text);
  font-size: var(--frock-text-xs);
  cursor: pointer;
}

.channel-connect-error {
  margin: 0;
  color: var(--frock-danger-text);
  font-size: var(--frock-text-xs);
  overflow-wrap: anywhere;
}

/*
 * The webhook path is one long unbroken token. It wraps rather than widening
 * the pane, and the code run scrolls inside itself if it still cannot.
 */
.channel-connect-hook {
  margin: 0;
  min-width: 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-xs);
  overflow-wrap: anywhere;
}

.channel-connect-hook code {
  display: block;
  max-width: 100%;
  overflow-x: auto;
  font-family: var(--frock-font-mono);
  overflow-wrap: anywhere;
}
</style>
