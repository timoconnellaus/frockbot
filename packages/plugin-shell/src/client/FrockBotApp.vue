<script setup lang="ts">
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import {
  announceUiAnchor,
  UiIcon,
  UiIconButton,
  UiMarkdown,
  UiSidebarOverlay,
} from "@frockbot/client-ui";
import {
  computed,
  inject,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { decodeSettingsLinkV1 } from "../settings-links.js";
import {
  frockBotWebDataKey,
  type FrockBotWebData,
  type WebChatMessage,
  type WebToolAttachment,
} from "../shared.js";
import { ComposerDraftStore } from "./composer-draft.js";
import SendPayloadView from "./SendPayloadView.vue";
import type { ClientSkillCatalogEntryV1 } from "../skill-protocol.js";
import {
  nextSkillHighlightV1,
  rankSkillCandidatesV1,
  SkillAttachmentStore,
  skillPopoverForV1,
  textWithoutSkillTriggerV1,
  type SkillPopoverStateV1,
} from "./skill-invocation.js";

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
/*
 * Skill invocation. `/` or `@` at a word boundary opens a popover over the
 * Bot's catalog; choosing one attaches a ref chip and removes the trigger from
 * the message. The Skill's text is never pasted: the backend resolves the ref
 * against the generation the Turn loads, so what runs is what the instruction
 * root holds, not what the composer once showed.
 */
const composerInput = ref<HTMLTextAreaElement | undefined>(undefined);
const skillStore = new SkillAttachmentStore();
const attachedSkills = ref<readonly ClientSkillCatalogEntryV1[]>([]);
const skillPopover = ref<SkillPopoverStateV1 | undefined>(undefined);
const skillHighlight = ref(0);
const skillCandidates = computed(() =>
  skillPopover.value
    ? rankSkillCandidatesV1(
        state.value.skillCatalog,
        skillPopover.value.query,
        {
          exclude: skillStore.refs(),
        },
      )
    : [],
);
const skillPopoverOpen = computed(
  () => Boolean(skillPopover.value) && skillCandidates.value.length > 0,
);
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
/**
 * The binaries this Turn's tools filed, in call order. Read off the tool
 * activity rather than the text so a result that is JSON stays JSON.
 */
function attachmentsOf(message: WebChatMessage): WebToolAttachment[] {
  return message.tools.flatMap((tool) => tool.attachments ?? []);
}

/** The Workspace read route for one encoded `WorkspacePathV1`. */
function workspaceFileUrl(path: string): string {
  const botId = state.value.activeBotId ?? "";
  return `/api/bots/${encodeURIComponent(botId)}/workspace/file?path=${encodeURIComponent(path)}`;
}

function isVisible(message: WebChatMessage): boolean {
  if (message.role === "user") return message.text.length > 0;
  if (message.role === "system") return message.text.length > 0;
  // A Turn the Bot ended with a widget writes no assistant text at all, so a
  // send is on its own enough to draw the line.
  return (
    message.text.length > 0 ||
    message.sends.length > 0 ||
    message.status === "streaming"
  );
}
/*
 * System lines happen between Turns, so the thread orders by when each line
 * happened. A line with no timestamp keeps the position the projection gave
 * it, which is what makes the sort stable for a Turn still streaming.
 */
const messages = computed(() =>
  state.value.messages
    .filter(isVisible)
    .map((message, index) => ({ message, index }))
    .sort(
      (left, right) =>
        (left.message.at ?? "").localeCompare(right.message.at ?? "") ||
        left.index - right.index,
    )
    .map((entry) => entry.message),
);

/*
 * One anchor per Turn, on its first visible line, so a deep link resolves to
 * exactly one element. A Turn shows as two lines — the prompt and the reply —
 * and giving both the same id would put the same anchor in the document
 * twice.
 */
const turnAnchors = computed(() => {
  const anchors = new Map<string, string>();
  const seen = new Set<string>();
  for (const message of messages.value) {
    if (seen.has(message.runId)) continue;
    seen.add(message.runId);
    anchors.set(message.id, `turn-${message.runId}`);
  }
  return anchors;
});

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

/*
 * Settings deep links. `?settings=<surface>#<anchor>` names a registered
 * surface and one row inside it; the shell opens the surface and announces the
 * anchor, and the anchored row highlights itself. The row is deliberately not
 * hunted for here: a panel loads its state after it mounts, so `UiAnchor` also
 * reads the fragment on its own mount and the two paths cover a link followed
 * cold and a link followed while the panel is already open.
 */
const applySettingsDeepLink = (): void => {
  const target = decodeSettingsLinkV1(window.location.href);
  if (!target || !surfaces.has(target.surface)) return;
  if (surfaces.activeId.value !== target.surface) surfaces.open(target.surface);
  const anchor = target.anchor;
  if (anchor) void nextTick(() => announceUiAnchor(anchor));
};

onMounted(() => {
  void web.value.loadPluginCatalog();
  void scrollToLatest("auto");
  applySettingsDeepLink();
  window.addEventListener("popstate", applySettingsDeepLink);
  window.addEventListener("hashchange", applySettingsDeepLink);
});

onBeforeUnmount(() => {
  window.removeEventListener("popstate", applySettingsDeepLink);
  window.removeEventListener("hashchange", applySettingsDeepLink);
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
    // A Skill belongs to one Bot's instruction root, so a switch drops both
    // the attached refs and the catalog they came from.
    skillStore.take();
    syncAttachedSkills();
    closeSkillPopover();
    void web.value.loadSkillCatalog();
  },
  { immediate: true },
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

function syncAttachedSkills(): void {
  attachedSkills.value = [...skillStore.attached()];
}

function closeSkillPopover(): void {
  skillPopover.value = undefined;
  skillHighlight.value = 0;
}

function refreshSkillPopover(): void {
  const element = composerInput.value;
  if (!element) return closeSkillPopover();
  const open = skillPopoverForV1(draft.value, element.selectionStart ?? 0);
  skillPopover.value = open;
  skillHighlight.value = 0;
}

function attachSkill(entry: ClientSkillCatalogEntryV1): void {
  const open = skillPopover.value;
  if (!open) return;
  const element = composerInput.value;
  const caret = element?.selectionStart ?? draft.value.length;
  const trimmed = textWithoutSkillTriggerV1(draft.value, open, caret);
  // Attaching a ref, not pasting a body: the message keeps only what the User
  // typed, and the Skill travels beside it.
  skillStore.attach(entry);
  syncAttachedSkills();
  draft.value = trimmed.text;
  closeSkillPopover();
  void nextTick(() => {
    const input = composerInput.value;
    if (!input) return;
    input.focus();
    input.setSelectionRange(trimmed.caret, trimmed.caret);
  });
}

function detachSkill(ref: string): void {
  skillStore.detach(ref);
  syncAttachedSkills();
}

async function sendMessage(): Promise<void> {
  const text = draft.value.trim();
  if (!text || !canSend.value) return;
  closeSkillPopover();
  const attached = [...skillStore.attached()];
  const skills = skillStore.take();
  syncAttachedSkills();
  const submission = draftStore.begin(composerContext.value, text);
  draft.value = "";
  // Sending is an explicit request to follow along again.
  pinnedToLatest.value = true;
  void scrollToLatest();
  const result = await web.value.sendPrompt(
    text,
    skills.length > 0 ? skills : undefined,
  );
  // A Turn may have written a Skill, and an edit is visible on the next Turn,
  // so the popover reads the catalog again rather than aging.
  void web.value.loadSkillCatalog();
  if (!result.accepted) {
    // A refused submission gives the Skills back too: the User attached them
    // deliberately and should not have to find them again.
    skillStore.restore(attached);
    syncAttachedSkills();
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
  if (skillPopoverOpen.value) {
    const count = skillCandidates.value.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      skillHighlight.value = nextSkillHighlightV1(
        skillHighlight.value,
        count,
        event.key === "ArrowDown" ? 1 : -1,
      );
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeSkillPopover();
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      const candidate = skillCandidates.value[skillHighlight.value];
      if (candidate) {
        event.preventDefault();
        attachSkill(candidate.entry);
        return;
      }
    }
  }
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
          <k-slot name="frockbot.header-actions" />
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
            :id="turnAnchors.get(message.id)"
            :key="message.id"
            class="message"
            :class="`message-${message.role}`"
          >
            <p v-if="message.role === 'system'" class="message-system-line">
              {{ message.text }}
            </p>
            <template v-else-if="message.role === 'assistant'">
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
              <!--
                A binary a tool filed in a durable root, drawn from the
                Workspace read route. The thread carries the path, never the
                bytes, so a long conversation costs paths and the image is
                fetched only when it is on screen.
              -->
              <div
                v-if="attachmentsOf(message).length > 0"
                class="message-attachments"
              >
                <a
                  v-for="attachment in attachmentsOf(message)"
                  :key="attachment.contentHash"
                  :href="workspaceFileUrl(attachment.path)"
                  target="_blank"
                  rel="noreferrer"
                >
                  <img
                    :src="workspaceFileUrl(attachment.path)"
                    :alt="`Attachment from ${message.runId}`"
                    loading="lazy"
                  />
                </a>
              </div>
              <!--
                Sends sit beside the derived text rather than inside it: each
                payload is its own block, and a widget-ended Turn has no text
                bubble at all.
              -->
              <div v-if="message.sends.length > 0" class="message-sends">
                <SendPayloadView
                  v-for="(send, sendIndex) in message.sends"
                  :key="sendIndex"
                  :send="send"
                />
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
          <ul
            v-if="skillPopoverOpen"
            id="skill-popover"
            class="skill-popover"
            role="listbox"
            aria-label="Skills"
          >
            <li
              v-for="(candidate, index) in skillCandidates"
              :key="candidate.entry.ref"
              class="skill-option"
              :class="{ 'skill-option-active': index === skillHighlight }"
              role="option"
              :aria-selected="index === skillHighlight"
              @mousedown.prevent="attachSkill(candidate.entry)"
              @mousemove="skillHighlight = index"
            >
              <span class="skill-option-name">{{ candidate.entry.name }}</span>
              <span class="skill-option-ref">{{ candidate.entry.ref }}</span>
              <span class="skill-option-description">
                {{ candidate.entry.description }}
              </span>
            </li>
          </ul>
          <div class="composer-body">
            <ul v-if="attachedSkills.length > 0" class="skill-chips">
              <li v-for="entry in attachedSkills" :key="entry.ref">
                <button
                  type="button"
                  class="skill-chip"
                  :title="entry.description"
                  :aria-label="`Remove Skill ${entry.name}`"
                  @click="detachSkill(entry.ref)"
                >
                  <span class="skill-chip-name">{{ entry.name }}</span>
                  <UiIcon name="close" size="sm" />
                </button>
              </li>
            </ul>
            <textarea
              ref="composerInput"
              v-model="draft"
              aria-label="Message"
              :placeholder="
                isConnecting
                  ? 'Connecting…'
                  : !state.modelReady
                    ? 'Choose a default model in Settings'
                    : `Message ${botName}`
              "
              :disabled="isConnecting || !state.modelReady || isRunning"
              rows="1"
              role="combobox"
              :aria-expanded="skillPopoverOpen"
              aria-controls="skill-popover"
              @keydown="handleComposerKeydown"
              @keyup="refreshSkillPopover"
              @click="refreshSkillPopover"
              @blur="closeSkillPopover"
            />
          </div>
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
