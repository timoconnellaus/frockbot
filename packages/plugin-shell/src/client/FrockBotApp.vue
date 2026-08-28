<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref } from "vue";
import {
  frockBotWebDataKey,
  type FrockBotWebData,
  type WebToolActivity,
} from "../shared.js";

const injectedWeb = inject(frockBotWebDataKey);
if (!injectedWeb) throw new Error("shell client data was not provided");
const web = injectedWeb;
const draft = ref("");
const contextMenuOpen = ref(false);
const rightPanelOpen = ref(true);
const state = computed(() => web.value);
const isRunning = computed(() => Boolean(state.value.activeRunId));
const canSend = computed(
  () =>
    state.value.connection === "ready" &&
    !isRunning.value &&
    draft.value.trim().length > 0,
);

function toolSymbol(tool: WebToolActivity): string {
  if (tool.status === "running") return "···";
  if (tool.status === "failed") return "!";
  return "✓";
}

async function sendMessage(): Promise<void> {
  const text = draft.value.trim();
  if (!text || !canSend.value) return;
  draft.value = "";
  const result = await web.value.sendPrompt(text);
  if (!result.accepted) draft.value = text;
}

function handleComposerKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  void sendMessage();
}

function closeContextMenu(): void {
  contextMenuOpen.value = false;
}

onMounted(() => window.addEventListener("pointerdown", closeContextMenu));
onBeforeUnmount(() =>
  window.removeEventListener("pointerdown", closeContextMenu),
);
</script>

<template>
  <div class="frockbot-root">
    <div class="app-shell" :class="{ 'panel-open': rightPanelOpen }">
      <aside class="sidebar">
        <div class="window-controls" aria-hidden="true" />
        <button class="new-bot" title="New bot" aria-label="New bot">+</button>
        <label class="search"
          ><span>⌕</span><input aria-label="Search bots" placeholder="Search"
        /></label>

        <div class="bot-list">
          <button
            class="bot-row active"
            @contextmenu.prevent="contextMenuOpen = true"
          >
            <span class="bot-icon">⌁</span>
            <span class="bot-copy">
              <strong>Barebones</strong>
              <small>A plain bot, ready to grow.</small>
            </span>
            <time>Now</time>
          </button>
          <div v-if="contextMenuOpen" class="context-menu" @pointerdown.stop>
            <button>Rename</button>
            <button>Duplicate</button>
            <button>Choose outfit</button>
            <button class="danger">Archive bot</button>
          </div>
        </div>

        <div class="sidebar-bottom">
          <button class="plugins"><span>⊙</span>Plugins</button>
          <button class="profile">
            <span class="profile-face" />FrockBot user
          </button>
        </div>
      </aside>

      <main class="workspace">
        <header class="topbar">
          <span class="book-icon">⌁</span>
          <div class="workspace-title">
            <strong>Barebones</strong>
            <small>{{ state.modelLabel }}</small>
          </div>
          <button
            class="icon-button"
            title="Bot settings"
            aria-label="Bot settings"
          >
            ⚙
          </button>
          <button
            class="panel-toggle"
            :title="
              rightPanelOpen ? 'Hide computer panel' : 'Show computer panel'
            "
            :aria-label="
              rightPanelOpen ? 'Hide computer panel' : 'Show computer panel'
            "
            @click="rightPanelOpen = !rightPanelOpen"
          >
            {{ rightPanelOpen ? "»" : "«" }}
          </button>
        </header>

        <section class="thread" aria-live="polite">
          <div v-if="state.messages.length === 0" class="empty-thread">
            <div class="empty-mark">⌁</div>
            <h1>Barebones is ready.</h1>
            <p>Start with a conversation. Cordis plugins can add the rest.</p>
          </div>
          <article
            v-for="message in state.messages"
            v-else
            :key="message.id"
            class="message"
            :class="
              message.role === 'user' ? 'message-user' : 'message-assistant'
            "
          >
            <div class="message-bubble">
              <span v-if="message.text">{{ message.text }}</span>
              <span v-else class="typing" aria-label="Thinking"
                ><i /><i /><i
              /></span>
            </div>
            <div v-if="message.tools.length" class="tool-list">
              <details
                v-for="tool in message.tools"
                :key="tool.id"
                class="tool-row"
                :class="`tool-${tool.status}`"
              >
                <summary>
                  <span class="tool-symbol">{{ toolSymbol(tool) }}</span>
                  <span>{{ tool.name }}</span>
                </summary>
                <pre v-if="tool.text">{{ tool.text }}</pre>
              </details>
            </div>
          </article>
        </section>

        <div v-if="state.error" class="error-banner" role="alert">
          <span>{{ state.error }}</span>
          <button v-if="state.connection !== 'ready'" @click="web.restart()">
            Restart agent
          </button>
        </div>

        <form class="composer" @submit.prevent="sendMessage">
          <button type="button" class="add-button" aria-label="Add attachment">
            +
          </button>
          <textarea
            v-model="draft"
            :placeholder="
              state.connection === 'ready'
                ? 'Message Barebones'
                : 'Waiting for Cordis…'
            "
            :disabled="state.connection !== 'ready'"
            rows="1"
            @keydown="handleComposerKeydown"
          />
          <button
            v-if="isRunning"
            type="button"
            class="stop-button"
            @click="web.abort()"
          >
            Stop
          </button>
          <button
            v-else
            class="send-button"
            type="submit"
            :disabled="!canSend"
            aria-label="Send message"
          >
            ↑
          </button>
        </form>
      </main>

      <aside v-if="rightPanelOpen" class="right-panel">
        <k-slot name="frockbot.computer" />
        <section class="routines-section">
          <div class="panel-heading">
            <strong>Routines</strong><button aria-label="Add routine">+</button>
          </div>
          <div class="routine-empty">
            <span>○</span>
            <div>
              <strong>No routines yet</strong>
              <p>Ask Barebones to repeat something later.</p>
            </div>
          </div>
        </section>
        <k-slot name="frockbot.right-panel" />
      </aside>
    </div>
  </div>
</template>
