<script setup lang="ts">
/**
 * The Applet canvas.
 *
 * The shell owns the frame: the header, the two states, the transition between
 * them, and every loading, empty, and failure branch. The Applets Package owns
 * only the page inside the frame, so how finished this feels never depends on
 * what a Package shipped.
 *
 * Two states, per the plan's §5a. **Building** is the Applet's source as the
 * Bot writes it, read from the Workspace store — nothing here wakes the
 * Computer. **Ready** is the live Applet, which slides in over the code view
 * once a generation is active. A publish that failed leaves the code view up
 * with the failure inline and a way to try again; it never shows progress that
 * is not happening.
 */
import { UiIcon, UiIconButton, UiSkeleton } from "@frockbot/client-ui";
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import { frockBotWebDataKey } from "../shared.js";
import { appletsBridgeStateV2 } from "./applets-state.js";
import {
  appletSourceFingerprintV1,
  mostRecentlyChangedFileV1,
} from "./applets-client.js";
import {
  appletIsBeingBuiltV1,
  appletProgressToolsV1,
  appletProgressV1,
} from "./applet-progress.js";
import { packageIframePagesForSlotV1 } from "./package-iframe-entries.js";
import PackageIframeHost from "./PackageIframeHost.vue";

const RIGHT_PANEL_SLOT = "frockbot.right-panel";
/** A load that takes longer than this stops spinning and offers a retry. */
const LOAD_TIMEOUT_MS = 8_000;

const providedWeb = inject(frockBotWebDataKey);
if (!providedWeb) throw new Error("Applet canvas data was not provided");
const web = providedWeb;

const applet = computed(() => web.value.focusedApplet);
const appletId = computed(() => web.value.focusedAppletId ?? undefined);
const viewer = computed(() =>
  web.value.appletViewer?.appletId === appletId.value
    ? web.value.appletViewer
    : undefined,
);
const source = computed(() => web.value.appletSource);
const build = computed(() => web.value.appletBuild);
const isRunning = computed(() => Boolean(web.value.activeRunId));
const canvasState = computed(() => web.value.appletCanvas);
const failure = computed(() => web.value.appletCanvasError);

/*
 * What the Bot is doing to this Applet, in one line.
 *
 * A publish is minutes away from a create, and for all of it there is nothing
 * to run. The panel used to answer that with one fixed line about the Applet
 * not being live and a file list, which never changed and never said whether
 * anything was happening. This is the sentence in between, projected from what
 * the thread already shows: no new read, no new durable state.
 */
const progress = computed(() =>
  appletProgressV1({
    applet: applet.value ?? null,
    source: source.value,
    build: build.value,
    tools: appletProgressToolsV1(web.value.messages),
    running: isRunning.value,
  }),
);
const beingBuilt = computed(() => appletIsBeingBuiltV1(progress.value));

/** The Applets Package's right-panel page, when its Composition carries one. */
const panelPage = computed(
  () => packageIframePagesForSlotV1(web.value.packageUi, RIGHT_PANEL_SLOT)[0],
);
const states = computed(() => ({ applets: appletsBridgeStateV2(web.value) }));

/*
 * Which view the header's toggle shows.
 *
 * It follows the Turn — a Turn that publishes lands on the Applet, a Turn that
 * writes source lands on the code — until the User picks a side, and then it
 * is theirs until they focus something else.
 */
const userSelectedTab = ref<"app" | "code" | undefined>(undefined);
const followedTab = ref<"app" | "code">("code");
const tab = computed<"app" | "code">(() => {
  if (userSelectedTab.value) return userSelectedTab.value;
  if (!viewer.value) return "code";
  return followedTab.value;
});
const canShowApp = computed(() => Boolean(viewer.value && panelPage.value));
const showingApp = computed(() => canShowApp.value && tab.value === "app");

watch(appletId, () => {
  userSelectedTab.value = undefined;
  followedTab.value = "code";
});
// A generation becoming active is the moment the Applet is worth looking at —
// and so is opening a page on an Applet that already has one. This runs
// immediately because a second window, or a reload, mounts the canvas with the
// viewer credential already in hand: waiting for a *change* left those pages
// on the code view of an Applet that has been live for minutes.
watch(
  () => viewer.value?.generationId,
  (generationId) => {
    if (generationId) followedTab.value = "app";
  },
  { immediate: true },
);
// A Turn writing source is the moment the code is. The fingerprint is what
// says a file changed: the canvas re-reads the source on every poll and gets a
// fresh view object each time, so a watcher on the view itself fired on Turns
// that wrote nothing — an Applet's own tool being called, say — and threw the
// User off the live Applet mid-use. The first source to arrive is a load, not
// a write, so it never moves the tab either.
watch(
  () => appletSourceFingerprintV1(source.value),
  (fingerprint, previous) => {
    if (!previous || fingerprint === previous) return;
    if (isRunning.value) followedTab.value = "code";
  },
);

/** The file the code view is on, following the most recently changed one. */
const openedPath = ref<string | undefined>(undefined);
const currentPath = computed(
  () => openedPath.value ?? mostRecentlyChangedFileV1(source.value),
);
const currentFile = computed(() =>
  source.value?.files.find((file) => file.path === currentPath.value),
);
const sortedFiles = computed(() =>
  (source.value?.files ?? []).toSorted((left, right) =>
    left.path.localeCompare(right.path),
  ),
);
watch(appletId, () => {
  openedPath.value = undefined;
});

/*
 * A load that never lands.
 *
 * A spinner that runs forever tells a User nothing they can act on, so past
 * the timeout the canvas says the read is taking too long and offers the one
 * thing that helps.
 */
const loadTimedOut = ref(false);
let loadTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  canvasState,
  (state) => {
    clearTimeout(loadTimer);
    loadTimedOut.value = false;
    if (state !== "loading") return;
    loadTimer = setTimeout(() => {
      loadTimedOut.value = true;
    }, LOAD_TIMEOUT_MS);
  },
  { immediate: true },
);
onBeforeUnmount(() => clearTimeout(loadTimer));

const loading = computed(
  () => canvasState.value === "loading" && !loadTimedOut.value,
);

/**
 * A generation id is `<ISO time>:<hash prefix>`, which is exact and unreadable.
 * The header says when it went live and keeps the short hash; the full id is
 * the tooltip.
 */
function generationLabel(generationId: string): string {
  const separator = generationId.lastIndexOf(":");
  const stamp = separator > 0 ? generationId.slice(0, separator) : "";
  const hash = separator > 0 ? generationId.slice(separator + 1) : generationId;
  const at = new Date(stamp);
  if (Number.isNaN(at.getTime())) return `Live · ${hash.slice(0, 7)}`;
  const when = at.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `Live since ${when}`;
}

function selectTab(next: "app" | "code"): void {
  userSelectedTab.value = next;
}

function openFile(path: string): void {
  openedPath.value = path;
}

/** Retry is a re-focus: the same durable command, read back the same way. */
async function retry(): Promise<void> {
  const id = appletId.value;
  if (!id) return;
  loadTimedOut.value = false;
  await web.value.setFocusedApplet(id);
}

function openInNewTab(): void {
  const url = viewer.value?.uiUrl;
  if (url) window.open(url, "_blank", "noopener,noreferrer");
}

async function clearFocus(): Promise<void> {
  await web.value.setFocusedApplet(null);
}
</script>

<template>
  <section
    class="applet-canvas"
    :aria-label="`Applet ${applet?.displayName ?? ''}`"
    :aria-busy="loading"
  >
    <!--
      The Turn's own signal, as a 2px bar across the top of the panel: the
      canvas says the Bot is working with the same signal the conversation
      does, rather than inventing a second one.
    -->
    <div
      v-if="isRunning"
      class="applet-canvas-working"
      role="status"
      aria-label="The Bot is working"
    />
    <header class="applet-canvas-header">
      <span class="applet-canvas-mark" aria-hidden="true"
        ><UiIcon name="applets" size="sm"
      /></span>
      <div class="applet-canvas-title">
        <strong>{{ applet?.displayName ?? "Applet" }}</strong>
        <!--
          While it is being built the line under the name is the pinned
          building view below, not a copy of it here.
        -->
        <small v-if="viewer">{{ generationLabel(viewer.generationId) }}</small>
      </div>
      <div
        v-if="canShowApp"
        class="applet-canvas-tabs"
        role="tablist"
        aria-label="Applet view"
      >
        <button
          type="button"
          role="tab"
          :aria-selected="showingApp"
          :class="{ 'applet-canvas-tab-active': showingApp }"
          @click="selectTab('app')"
        >
          App
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="!showingApp"
          :class="{ 'applet-canvas-tab-active': !showingApp }"
          @click="selectTab('code')"
        >
          Code
        </button>
      </div>
      <UiIconButton
        v-if="viewer"
        icon="link"
        label="Open this Applet in a new tab"
        size="sm"
        @click="openInNewTab"
      />
      <UiIconButton
        icon="close"
        label="Close this Applet"
        size="sm"
        @click="clearFocus"
      />
    </header>

    <!--
      Where the work has got to, pinned under the header while the Applet is
      still being built: one line a person can read, the reason it stopped when
      it stopped, and the tail of whatever the check or the build printed —
      which is the only thing that helps when the Bot is going round in circles
      on a type error. It sits outside the scrolling column deliberately: a
      person reading the source still wants to know what is happening to it.
    -->
    <section
      v-if="applet && !loading && progress && beingBuilt"
      class="applet-canvas-progress"
      :class="{ 'applet-canvas-progress-wrong': Boolean(progress.failure) }"
      data-testid="applet-canvas-progress"
      role="status"
    >
      <p class="applet-canvas-progress-line">
        <span
          v-if="progress.working"
          class="applet-canvas-progress-dot"
          aria-hidden="true"
        />
        <UiIcon v-else-if="progress.failure" name="close" size="sm" />
        <span>{{ progress.label }}</span>
      </p>
      <p v-if="progress.failure" class="applet-canvas-progress-failure">
        {{ progress.failure }}
      </p>
      <pre
        v-if="progress.output"
        class="applet-canvas-progress-output"
      ><code>{{ progress.output.join("\n") }}</code></pre>
    </section>

    <div class="applet-canvas-body">
      <!-- Loading: the shape of what is coming, with a caption that says so. -->
      <div v-if="loading" class="applet-canvas-loading">
        <UiSkeleton width="60%" />
        <UiSkeleton width="90%" />
        <UiSkeleton width="80%" />
        <UiSkeleton width="45%" />
        <p>Reading this Applet…</p>
      </div>

      <!-- No Applet under the focus: the one thing worth doing about that. -->
      <div v-else-if="!applet" class="applet-canvas-empty">
        <span class="applet-canvas-empty-mark" aria-hidden="true"
          ><UiIcon name="applets" size="lg"
        /></span>
        <h3>No Applet here yet</h3>
        <p>
          Ask this Bot to build one — a todo list, a tracker, whatever you keep
          in your head. It writes it, publishes it, and it appears here.
        </p>
      </div>

      <template v-else>
        <!-- Building: the source as it is written, and the last check. -->
        <div class="applet-canvas-code">
          <div
            v-if="failure"
            class="applet-canvas-failure"
            role="alert"
            data-testid="applet-canvas-failure"
          >
            <span>{{ failure }}</span>
            <button type="button" @click="retry">Try again</button>
          </div>
          <div
            v-else-if="loadTimedOut"
            class="applet-canvas-failure"
            role="alert"
          >
            <span>This is taking longer than it should.</span>
            <button type="button" @click="retry">Try again</button>
          </div>
          <div v-if="sortedFiles.length > 0" class="applet-canvas-files">
            <button
              v-for="file in sortedFiles"
              :key="file.path"
              type="button"
              class="applet-canvas-file"
              :class="{
                'applet-canvas-file-active': file.path === currentPath,
              }"
              :aria-current="file.path === currentPath"
              @click="openFile(file.path)"
            >
              {{ file.path }}
            </button>
          </div>
          <p v-else class="applet-canvas-note">
            This Applet has no source yet.
          </p>
          <pre v-if="currentFile" class="applet-canvas-source"><code>{{
            currentFile.text
          }}</code></pre>
          <p v-if="source?.truncated" class="applet-canvas-note">
            Only the first part of this Applet's source is shown.
          </p>
        </div>

        <!--
          Ready: the live Applet, over the code rather than instead of it, so
          the toggle back is a slide and not a reload.
        -->
        <Transition name="applet-app">
          <div v-if="showingApp" class="applet-canvas-app">
            <PackageIframeHost
              v-if="panelPage"
              :contribution="panelPage.contribution"
              :page="panelPage.page"
              :slot="RIGHT_PANEL_SLOT"
              :states="states"
              layout="fill"
              :attribution="false"
            />
          </div>
        </Transition>
      </template>
    </div>
  </section>
</template>

<style scoped>
.applet-canvas {
  position: relative;
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  background: var(--frock-surface);
}

/* The Turn's signal: 2px, across the top, and gone the moment it settles. */
.applet-canvas-working {
  position: absolute;
  z-index: 2;
  top: 0;
  right: 0;
  left: 0;
  height: 2px;
  background: linear-gradient(
    90deg,
    transparent,
    var(--frock-action-primary),
    transparent
  );
  background-size: 40% 100%;
  background-repeat: no-repeat;
  animation: applet-working 1.4s ease-in-out infinite;
}

@keyframes applet-working {
  0% {
    background-position: -40% 0;
  }

  100% {
    background-position: 140% 0;
  }
}

.applet-canvas-header {
  display: flex;
  height: var(--frock-titlebar-height);
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  padding: 0 8px 0 12px;
  border-bottom: 1px solid var(--frock-border);
}

.applet-canvas-mark {
  display: grid;
  width: var(--frock-avatar-sm);
  height: var(--frock-avatar-sm);
  flex: 0 0 auto;
  place-items: center;
  border-radius: 8px;
  color: var(--frock-action-primary);
  background: var(--frock-surface-subtle);
  box-shadow: inset 0 0 0 1px var(--frock-border);
}

.applet-canvas-title {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
}

.applet-canvas-title strong {
  overflow: hidden;
  color: var(--frock-text);
  font-size: var(--frock-text-md);
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.applet-canvas-title small {
  overflow: hidden;
  color: var(--frock-text-muted);
  font-family: var(--frock-font-mono);
  font-size: var(--frock-text-xs);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.applet-canvas-tabs {
  display: flex;
  flex: 0 0 auto;
  gap: 2px;
  padding: 2px;
  border-radius: var(--frock-radius-control);
  background: var(--frock-surface-subtle);
}

.applet-canvas-tabs button {
  height: var(--frock-control-sm);
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  color: var(--frock-text-muted);
  background: transparent;
  font-size: var(--frock-text-sm);
  font-weight: 500;
  cursor: pointer;
  transition:
    background-color var(--frock-motion-fast),
    color var(--frock-motion-fast);
}

.applet-canvas-tabs button:hover {
  color: var(--frock-text);
  background: var(--frock-fill-hover);
}

.applet-canvas-tab-active,
.applet-canvas-tabs button.applet-canvas-tab-active {
  color: var(--frock-text);
  background: var(--frock-surface-raised);
}

.applet-canvas-body {
  position: relative;
  min-height: 0;
  flex: 1;
}

.applet-canvas-code {
  position: absolute;
  display: flex;
  overflow-y: auto;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  inset: 0;
  scrollbar-color: var(--frock-scrollbar) transparent;
  scrollbar-width: thin;
}

.applet-canvas-app {
  position: absolute;
  overflow: hidden;
  background: var(--frock-surface);
  inset: 0;
}

/*
 * The Applet arriving over its own source. 240ms is long enough to read as a
 * slide and short enough that the toggle still feels like a switch.
 */
.applet-app-enter-active,
.applet-app-leave-active {
  transition:
    transform 240ms cubic-bezier(0.16, 1, 0.3, 1),
    opacity 240ms cubic-bezier(0.16, 1, 0.3, 1);
}

.applet-app-enter-from,
.applet-app-leave-to {
  opacity: 0;
  transform: translateX(16px);
}

.applet-canvas-files {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  gap: 4px;
}

.applet-canvas-file {
  max-width: 100%;
  height: var(--frock-control-sm);
  overflow: hidden;
  padding: 0 8px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-control);
  color: var(--frock-text-muted);
  background: transparent;
  font-family: var(--frock-font-mono);
  font-size: var(--frock-text-xs);
  white-space: nowrap;
  text-overflow: ellipsis;
  cursor: pointer;
}

.applet-canvas-file:hover {
  color: var(--frock-text);
  background: var(--frock-fill-hover);
}

.applet-canvas-file-active {
  color: var(--frock-text);
  border-color: var(--frock-border-strong);
  background: var(--frock-surface-subtle);
}

.applet-canvas-source {
  margin: 0;
  overflow-x: auto;
  padding: 10px 12px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  color: var(--frock-text);
  background: var(--frock-surface-subtle);
  font-family: var(--frock-font-mono);
  font-size: var(--frock-text-sm);
  line-height: var(--frock-leading-snug);
  tab-size: 2;
  white-space: pre;
}

/* Where the work has got to: the panel's own header for the building state. */
.applet-canvas-progress {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--frock-border);
  background: var(--frock-surface-subtle);
}

.applet-canvas-progress-wrong {
  border-bottom-color: var(--frock-danger-border);
  background: var(--frock-danger-surface);
}

.applet-canvas-progress-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--frock-text);
  font-size: var(--frock-text-sm);
  font-weight: 600;
}

.applet-canvas-progress-wrong .applet-canvas-progress-line {
  color: var(--frock-danger-text);
}

/* The same "something is happening" the thread uses, at the size of a word. */
.applet-canvas-progress-dot {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: var(--frock-action-primary);
  animation: applet-progress-pulse 1.4s ease-in-out infinite;
}

@keyframes applet-progress-pulse {
  0%,
  100% {
    opacity: 0.35;
  }

  50% {
    opacity: 1;
  }
}

.applet-canvas-progress-failure {
  margin: 0;
  color: var(--frock-danger-text);
  font-size: var(--frock-text-sm);
}

.applet-canvas-progress-output {
  max-height: 180px;
  margin: 0;
  overflow: auto;
  padding: 8px 10px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-control);
  color: var(--frock-text-muted);
  background: var(--frock-surface);
  font-family: var(--frock-font-mono);
  font-size: var(--frock-text-xs);
  line-height: var(--frock-leading-snug);
  white-space: pre;
}

.applet-canvas-failure {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--frock-danger-border);
  border-radius: var(--frock-radius-control);
  color: var(--frock-danger-text);
  background: var(--frock-danger-surface);
  font-size: var(--frock-text-sm);
}

.applet-canvas-failure button {
  height: var(--frock-control-sm);
  flex: 0 0 auto;
  padding: 0 10px;
  border: 1px solid var(--frock-danger-border);
  border-radius: var(--frock-radius-control);
  color: var(--frock-text);
  background: transparent;
  font-size: var(--frock-text-sm);
  cursor: pointer;
}

.applet-canvas-note {
  margin: 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-xs);
}

.applet-canvas-loading {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
}

.applet-canvas-loading p {
  margin: 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-xs);
}

.applet-canvas-empty {
  display: flex;
  height: 100%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
}

.applet-canvas-empty-mark {
  display: grid;
  width: var(--frock-avatar-md);
  height: var(--frock-avatar-md);
  place-items: center;
  border-radius: var(--frock-radius-control);
  color: var(--frock-action-primary);
  background: var(--frock-surface-subtle);
  box-shadow: inset 0 0 0 1px var(--frock-border);
}

.applet-canvas-empty h3 {
  margin: 0;
  color: var(--frock-text);
  font-size: var(--frock-text-lg);
  font-weight: 600;
}

.applet-canvas-empty p {
  max-width: 34ch;
  margin: 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

@media (prefers-reduced-motion: reduce) {
  .applet-canvas-working {
    animation: none;
  }

  .applet-app-enter-active,
  .applet-app-leave-active {
    transition: none;
  }

  .applet-canvas-progress-dot {
    animation: none;
  }
}
</style>
