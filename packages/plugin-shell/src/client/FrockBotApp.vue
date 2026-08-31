<script setup lang="ts">
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import {
  UiIcon,
  UiIconButton,
  UiMarkdown,
  UiSidebarOverlay,
} from "@frockbot/client-ui";
import { computed, inject, nextTick, onMounted, ref, watch } from "vue";
import {
  frockBotWebDataKey,
  type FrockBotWebData,
  type WebChatMessage,
} from "../shared.js";
import { ComposerDraftStore } from "./composer-draft.js";

const injectedWeb = inject(frockBotWebDataKey);
if (!injectedWeb) throw new Error("shell client data was not provided");
const web = injectedWeb;
const surfaces = inject(clientSurfaceRegistryKey);
if (!surfaces) throw new Error("client surface registry was not provided");
const activeSurface = surfaces.active;
/*
 * A registered surface either floats over the workspace or takes the right
 * panel's place. A panel-placed surface swaps the panel's content and forces
 * the panel open; closing it hands the panel back to its plugins.
 */
const panelSurface = computed(() =>
  activeSurface.value?.placement === "panel" ? activeSurface.value : undefined,
);
const overlaySurface = computed(() =>
  activeSurface.value?.placement === "panel" ? undefined : activeSurface.value,
);
const state = computed(() => web.value);
const composerContext = computed(
  () =>
    state.value.composerContext ?? state.value.botSettings?.botId ?? "default",
);
const draftStore = new ComposerDraftStore();
const draft = ref(draftStore.draftFor(composerContext.value));
const rightPanelOpen = ref(true);
// The macOS desktop shell hides its title bar, so the window's traffic lights
// sit inside the sidebar's top row and the wordmark has to clear them.
const macDesktop =
  typeof navigator !== "undefined" &&
  /Electron/u.test(navigator.userAgent) &&
  /Mac/u.test(navigator.platform);
const botName = computed(
  () => state.value.botSettings?.profile.name ?? "Barebones",
);
const isRunning = computed(() => Boolean(state.value.activeRunId));
const isConnecting = computed(() => state.value.connection !== "ready");
const canSend = computed(
  () =>
    state.value.connection === "ready" &&
    state.value.modelReady &&
    Boolean(state.value.activeBotId) &&
    !isRunning.value &&
    draft.value.trim().length > 0,
);

/*
 * Tool activity is internal to the Turn. A Turn that produced only tool calls
 * shows the Bot avatar while it runs and nothing once it finishes with no
 * text, so an empty bubble never appears in the thread.
 */
function isVisible(message: WebChatMessage): boolean {
  if (message.role === "user") return message.text.length > 0;
  return message.text.length > 0 || message.status === "streaming";
}
const messages = computed(() => state.value.messages.filter(isVisible));

/*
 * The thread follows new content only while the reader is already at the
 * bottom. Someone reading back through history is never yanked forward; the
 * jump control tells them there is something newer.
 */
const thread = ref<HTMLElement>();
const pinnedToLatest = ref(true);
const hasUnseenBelow = ref(false);
const nearBottomThreshold = 80;
const prefersReducedMotion =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function onThreadScroll(): void {
  const element = thread.value;
  if (!element) return;
  pinnedToLatest.value =
    element.scrollHeight - element.scrollTop - element.clientHeight <=
    nearBottomThreshold;
  if (pinnedToLatest.value) hasUnseenBelow.value = false;
}

async function scrollToLatest(
  behavior: ScrollBehavior = "smooth",
): Promise<void> {
  await nextTick();
  const element = thread.value;
  if (!element) return;
  element.scrollTo({
    top: element.scrollHeight,
    behavior: prefersReducedMotion ? "auto" : behavior,
  });
  pinnedToLatest.value = true;
  hasUnseenBelow.value = false;
}

onMounted(() => {
  void web.value.loadPluginCatalog();
  void scrollToLatest("auto");
});

watch(
  // Message count moves on a new Turn; the last message's length moves on
  // every streamed delta.
  () =>
    [messages.value.length, messages.value.at(-1)?.text.length ?? 0] as const,
  ([count], [previousCount]) => {
    if (!pinnedToLatest.value) {
      hasUnseenBelow.value = true;
      return;
    }
    // Streamed deltas jump instantly so the smooth scroll never falls behind.
    void scrollToLatest(count === previousCount ? "auto" : "smooth");
  },
);
watch(
  () => state.value.activeBotId,
  () => {
    pinnedToLatest.value = true;
    void scrollToLatest("auto");
  },
);

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
watch(panelSurface, (surface) => {
  if (surface) rightPanelOpen.value = true;
});

async function sendMessage(): Promise<void> {
  const text = draft.value.trim();
  if (!text || !canSend.value) return;
  const submission = draftStore.begin(composerContext.value, text);
  draft.value = "";
  // Sending is an explicit request to follow along again.
  pinnedToLatest.value = true;
  void scrollToLatest();
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
    <div
      class="app-shell"
      :class="{
        'panel-open': rightPanelOpen,
        'panel-surface': Boolean(panelSurface),
        'mac-desktop': macDesktop,
      }"
    >
      <aside class="sidebar">
        <div class="brand" aria-hidden="true">
          <span class="brand-mark">FrockBot</span>
        </div>
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
          <span class="bot-identity"
            ><k-slot name="frockbot.bot-identity"
          /></span>
          <div class="workspace-title">
            <strong>{{ botName }}</strong>
            <small>{{ state.modelLabel }}</small>
          </div>
        </header>

        <section
          ref="thread"
          class="thread"
          aria-live="polite"
          @scroll.passive="onThreadScroll"
        >
          <div v-if="messages.length === 0" class="empty-thread">
            <div class="empty-mark"><UiIcon name="sparkle" size="lg" /></div>
            <h1>
              {{ state.modelReady ? `${botName} is ready.` : "Choose a model" }}
            </h1>
            <p>
              {{
                state.modelReady
                  ? "Start with a conversation. Cordis plugins can add the rest."
                  : "Choose a default model in Settings to begin."
              }}
            </p>
          </div>
          <article
            v-for="message in messages"
            v-else
            :key="message.id"
            class="message"
            :class="
              message.role === 'user' ? 'message-user' : 'message-assistant'
            "
          >
            <template v-if="message.role === 'assistant'">
              <!--
                The Bot's own avatar comes from whichever Package owns Bot
                identity. When no Package fills the slot the sparkle tile is
                the only child and shows through.
              -->
              <div
                class="bot-avatar"
                :class="{
                  'bot-avatar-live': message.status === 'streaming',
                  'bot-avatar-waiting':
                    message.status === 'streaming' && !message.text,
                }"
              >
                <span class="bot-avatar-fallback" aria-hidden="true"
                  ><UiIcon name="sparkle" size="sm"
                /></span>
                <k-slot name="frockbot.bot-avatar" />
              </div>
              <div v-if="message.text" class="message-bubble">
                <UiMarkdown :text="message.text" />
              </div>
            </template>
            <div v-else class="message-bubble">{{ message.text }}</div>
          </article>
        </section>

        <Transition name="banner">
          <UiIconButton
            v-if="hasUnseenBelow && !state.error && !state.activeRun"
            class="jump-latest"
            icon="arrow-down"
            label="Jump to latest"
            variant="outlined"
            size="sm"
            @click="scrollToLatest()"
          />
        </Transition>

        <Transition name="banner">
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
        </Transition>

        <form
          class="composer"
          :class="{ 'composer-busy': isRunning }"
          @submit.prevent="sendMessage"
        >
          <textarea
            v-model="draft"
            :placeholder="
              isConnecting
                ? 'Connecting…'
                : !state.modelReady
                  ? 'Choose a default model in Settings'
                  : `Message ${botName}`
            "
            :disabled="isConnecting || !state.modelReady || isRunning"
            rows="1"
            @keydown="handleComposerKeydown"
          />
          <UiIconButton
            v-if="isRunning"
            class="stop-button"
            icon="stop"
            label="Stop generating"
            variant="primary"
            @click="web.stopRun()"
          />
          <UiIconButton
            v-else
            type="submit"
            icon="arrow-up"
            label="Send message"
            variant="primary"
            :disabled="!canSend"
          />
        </form>
      </main>

      <aside
        class="right-panel"
        :aria-hidden="!rightPanelOpen"
        :inert="!rightPanelOpen"
      >
        <!--
          Both layers live in one stack so panel plugins keep their state
          while a surface holds their place.
        -->
        <div class="right-panel-stack">
          <Transition name="panel-swap">
            <div v-show="!panelSurface" class="right-panel-content">
              <k-slot name="frockbot.right-panel" />
            </div>
          </Transition>
          <Transition name="panel-swap">
            <section
              v-if="panelSurface"
              class="panel-surface-view"
              :aria-label="panelSurface.title"
            >
              <header class="panel-surface-header">
                <UiIconButton
                  icon="close"
                  label="Close settings"
                  size="sm"
                  @click="surfaces.close()"
                />
                <h2>{{ panelSurface.title }}</h2>
              </header>
              <div class="panel-surface-content">
                <component :is="panelSurface.component" />
              </div>
            </section>
          </Transition>
        </div>
      </aside>

      <div class="window-actions">
        <k-slot name="frockbot.bot-actions" />
        <UiIconButton
          class="panel-toggle"
          :icon="rightPanelOpen ? 'chevrons-right' : 'chevrons-left'"
          :label="rightPanelOpen ? 'Hide side panel' : 'Show side panel'"
          @click="rightPanelOpen = !rightPanelOpen"
        />
      </div>
    </div>

    <k-slot name="frockbot.overlays" />

    <UiSidebarOverlay
      :open="Boolean(overlaySurface)"
      :title="overlaySurface?.title ?? ''"
      @close="surfaces.close()"
    >
      <component :is="overlaySurface.component" v-if="overlaySurface" />
    </UiSidebarOverlay>
  </div>
</template>
