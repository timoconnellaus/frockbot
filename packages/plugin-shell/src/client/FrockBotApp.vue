<script setup lang="ts">
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { UiSidebarOverlay } from "@frockbot/client-ui";
import { computed, inject, onMounted, ref, watch } from "vue";
import {
  frockBotWebDataKey,
  type FrockBotWebData,
  type WebToolActivity,
} from "../shared.js";
import { ComposerDraftStore } from "./composer-draft.js";

const injectedWeb = inject(frockBotWebDataKey);
if (!injectedWeb) throw new Error("shell client data was not provided");
const web = injectedWeb;
const surfaces = inject(clientSurfaceRegistryKey);
if (!surfaces) throw new Error("client surface registry was not provided");
const activeSurface = surfaces.active;
const state = computed(() => web.value);
const composerContext = computed(
  () =>
    state.value.composerContext ?? state.value.botSettings?.botId ?? "default",
);
const draftStore = new ComposerDraftStore();
const draft = ref(draftStore.draftFor(composerContext.value));
const rightPanelOpen = ref(true);
const botName = computed(
  () => state.value.botSettings?.profile.name ?? "Barebones",
);
const isRunning = computed(() => Boolean(state.value.activeRunId));
const canSend = computed(
  () =>
    state.value.connection === "ready" &&
    state.value.modelReady &&
    Boolean(state.value.activeBotId) &&
    !isRunning.value &&
    draft.value.trim().length > 0,
);

onMounted(() => web.value.loadUserSettings());

watch(
  composerContext,
  (current, previous) => {
    draftStore.setDraft(previous, draft.value);
    draft.value = draftStore.draftFor(current);
  },
  { flush: "sync" },
);
watch(draft, (value) => draftStore.setDraft(composerContext.value, value), {
  flush: "sync",
});

function toolSymbol(tool: WebToolActivity): string {
  if (tool.status === "running") return "···";
  if (tool.status === "failed") return "!";
  return "✓";
}

async function sendMessage(): Promise<void> {
  const text = draft.value.trim();
  if (!text || !canSend.value) return;
  const submission = draftStore.begin(composerContext.value, text);
  draft.value = "";
  const result = await web.value.sendPrompt(text);
  if (!result.accepted) {
    const restored = draftStore.reject(submission);
    if (
      restored !== undefined &&
      composerContext.value === submission.context
    ) {
      draft.value = restored;
    }
  }
}

function handleComposerKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  void sendMessage();
}
</script>

<template>
  <div class="frockbot-root">
    <div class="app-shell" :class="{ 'panel-open': rightPanelOpen }">
      <aside class="sidebar">
        <div class="window-controls" aria-hidden="true" />
        <div class="bot-list">
          <k-slot name="frockbot.sidebar-bots" />
        </div>

        <div class="sidebar-bottom">
          <k-slot name="frockbot.sidebar-actions" />
          <k-slot name="frockbot.user-profile" />
        </div>
      </aside>

      <main class="workspace">
        <header class="topbar">
          <span class="book-icon"><k-slot name="frockbot.bot-identity" /></span>
          <div class="workspace-title">
            <strong>{{ botName }}</strong>
            <small>{{ state.modelLabel }}</small>
          </div>
          <k-slot name="frockbot.bot-actions" />
          <button
            class="panel-toggle"
            :title="rightPanelOpen ? 'Hide side panel' : 'Show side panel'"
            :aria-label="rightPanelOpen ? 'Hide side panel' : 'Show side panel'"
            @click="rightPanelOpen = !rightPanelOpen"
          >
            {{ rightPanelOpen ? "»" : "«" }}
          </button>
        </header>

        <section class="thread" aria-live="polite">
          <div v-if="state.messages.length === 0" class="empty-thread">
            <div class="empty-mark">⌁</div>
            <h1>
              {{ state.modelReady ? `${botName} is ready.` : "Choose a model" }}
            </h1>
            <p>
              {{
                state.modelReady
                  ? "Start with a conversation. Cordis plugins can add the rest."
                  : "Select a model Connection in Bot settings to begin."
              }}
            </p>
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

        <div
          v-if="state.error || state.activeRun"
          class="error-banner"
          :role="state.error && !state.activeRun ? 'alert' : 'status'"
        >
          <span>{{ state.activeRun?.message ?? state.error }}</span>
          <button
            v-if="state.activeRun?.canResume"
            type="button"
            @click="web.resumeRun(state.activeRun.runId)"
          >
            Resolve Turn
          </button>
        </div>

        <form class="composer" @submit.prevent="sendMessage">
          <textarea
            v-model="draft"
            :placeholder="
              state.connection !== 'ready'
                ? 'Waiting for Cordis…'
                : !state.modelReady
                  ? 'Select a model in Bot settings'
                  : `Message ${botName}`
            "
            :disabled="
              state.connection !== 'ready' || !state.modelReady || isRunning
            "
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
        <k-slot name="frockbot.right-panel" />
      </aside>
    </div>

    <k-slot name="frockbot.overlays" />

    <UiSidebarOverlay
      :open="Boolean(activeSurface)"
      :title="activeSurface?.title ?? ''"
      @close="surfaces.close()"
    >
      <component :is="activeSurface.component" v-if="activeSurface" />
    </UiSidebarOverlay>
  </div>
</template>
