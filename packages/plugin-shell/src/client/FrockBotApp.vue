<script setup lang="ts">
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import {
  announceUiAnchor,
  UiActivityTrail,
  UiIcon,
  UiIconButton,
  UiMarkdown,
  UiSidebarOverlay,
  type ActivityTrailBurstEventV1,
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
  type WebTaskChip,
  type WebToolAttachment,
  type WebToolActivity,
} from "../shared.js";
import { ComposerDraftStore } from "./composer-draft.js";
import {
  applyDictationTailV1,
  voiceButtonLabelV1,
  voiceWaveBarsV1,
  VoiceDictationTranscriptV1,
  type VoiceDictationStateV1,
} from "./voice-dictation.js";
import {
  startVoiceMicrophoneV1,
  voiceMicrophoneRefusalV1,
  type VoiceMicrophoneV1,
} from "./voice-microphone.js";
import type { VoiceDictationSessionV1 } from "@frockbot/client-core";
import {
  activityTrailBeginV1,
  activityTrailSampleV1,
  activityTrailStepV1,
  type ActivityTrailMemoryV1,
  type ActivityTrailStateV1,
} from "./activity-trail.js";
import {
  supersedeDrainLabelV1,
  supersedeDrainStateV1,
} from "./supersede-drain.js";
import { orderTranscriptV1 } from "./transcript-order.js";
import {
  TURN_TEXT_MAX_CHARACTERS_V1,
  turnTextCounterVisibleV1,
  turnTextRemainingV1,
  turnTextTooLongV1,
} from "./turn-limits.js";
import SendPayloadView from "./SendPayloadView.vue";
import AppletCanvas from "./AppletCanvas.vue";
import { appletProgressToolsV1, appletProgressV1 } from "./applet-progress.js";
import PackageIframeHost from "./PackageIframeHost.vue";
import type { ClientSkillCatalogEntryV1 } from "../skill-protocol.js";
import {
  keptSkillHighlightV1,
  nextSkillHighlightV1,
  rankSkillCandidatesV1,
  SkillAttachmentStore,
  skillPopoverForV1,
  textWithoutSkillTriggerV1,
  type SkillPopoverStateV1,
} from "./skill-invocation.js";
import {
  DEPLOYMENT_RELOAD_LABEL_V1,
  DEPLOYMENT_UPDATED_MESSAGE_V1,
  deploymentFollowV1,
  deploymentReloadStoreV1,
  readDeploymentReloadV1,
  writeDeploymentReloadV1,
} from "./deployment.js";

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

/*
 * The phone layout.
 *
 * The same bundle serves every platform, so a phone is this shell at a narrow
 * viewport rather than a second client. Below the breakpoint there is room for
 * one column: the Bot list and the right panel become drawers over the
 * conversation, and only one of them is ever open.
 *
 * The width is matched here as well as in `styles.css` because the layout
 * decides behaviour, not only appearance — the right panel is open by default
 * on a desktop and must not be on a phone, where it would cover the
 * conversation the User just opened. The query is the one in the stylesheet;
 * the two are kept in step deliberately.
 */
const PHONE_LAYOUT_QUERY = "(max-width: 640px)";
const phoneLayoutMedia =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(PHONE_LAYOUT_QUERY)
    : undefined;
const phoneLayout = ref(phoneLayoutMedia?.matches ?? false);
const navOpen = ref(false);
const rightPanelOpen = ref(!phoneLayout.value);

function onPhoneLayoutChange(event: MediaQueryListEvent): void {
  phoneLayout.value = event.matches;
}

/*
 * Crossing the breakpoint resets both drawers to what that layout means by
 * open: a desktop shows the right panel beside the conversation, a phone shows
 * neither over it.
 */
watch(phoneLayout, (phone) => {
  navOpen.value = false;
  if (!panelSurface.value) rightPanelOpen.value = !phone;
});

function openNav(): void {
  // One drawer at a time: two half-covered columns is the layout this replaced.
  rightPanelOpen.value = false;
  navOpen.value = true;
}

function closeNav(): void {
  navOpen.value = false;
}

function toggleRightPanel(): void {
  if (!rightPanelOpen.value) navOpen.value = false;
  rightPanelOpen.value = !rightPanelOpen.value;
}

/**
 * Give the conversation back.
 *
 * A hosted surface holds the panel's place and covers the whole window, so
 * there is no scrim to tap while one is open; the panel is left alone in that
 * case rather than closed out from under it.
 */
function closeDrawers(): void {
  navOpen.value = false;
  if (!panelSurface.value) rightPanelOpen.value = false;
}

/*
 * Escape, wherever the focus is.
 *
 * A drawer's own trigger disappears when the drawer opens, so focus can land
 * back on the document body — outside this component's element — and a handler
 * bound to the root would never see the key. The window is where "give the
 * conversation back" has to be heard.
 */
function onRootKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  if (navOpen.value) {
    event.preventDefault();
    closeNav();
    return;
  }
  // An open overlay owns Escape; closing the panel underneath it would be a
  // second dismissal the User did not ask for.
  if (overlaySurface.value) return;
  // On a phone the right panel covers the conversation, so Escape gives the
  // conversation back — the same thing tapping the scrim does.
  if (phoneLayout.value && rightPanelOpen.value && !panelSurface.value) {
    event.preventDefault();
    rightPanelOpen.value = false;
  }
}

/*
 * The Applet canvas.
 *
 * A Session with a focused Applet gives the right panel to the canvas; without
 * one the panel keeps the content its plugins put there. The canvas is wider
 * than a summary column, and how much wider is the User's: the width they drag
 * is theirs and is remembered per browser, which is a per-viewer convenience
 * rather than durable state and belongs in local storage.
 */
const APPLET_PANEL_WIDTH_KEY = "frockbot.applet-panel-width";
const APPLET_PANEL_MIN = 320;
const APPLET_PANEL_MAX = 900;
const APPLET_PANEL_DEFAULT = 480;

function readStoredPanelWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(APPLET_PANEL_WIDTH_KEY));
    if (!Number.isFinite(stored) || stored <= 0) return APPLET_PANEL_DEFAULT;
    return Math.min(APPLET_PANEL_MAX, Math.max(APPLET_PANEL_MIN, stored));
  } catch {
    return APPLET_PANEL_DEFAULT;
  }
}

const appletPanelWidth = ref(
  typeof window === "undefined" ? APPLET_PANEL_DEFAULT : readStoredPanelWidth(),
);
const appletCanvasOpen = computed(() =>
  Boolean(state.value.focusedAppletId && !panelSurface.value),
);

function storePanelWidth(width: number): void {
  try {
    window.localStorage.setItem(APPLET_PANEL_WIDTH_KEY, String(width));
  } catch {
    // A browser that refuses storage still resizes; it just forgets.
  }
}

function setPanelWidth(width: number): void {
  appletPanelWidth.value = Math.min(
    APPLET_PANEL_MAX,
    Math.max(APPLET_PANEL_MIN, Math.round(width)),
  );
}

function onPanelHandlePointerDown(event: PointerEvent): void {
  if (phoneLayout.value) return;
  const target = event.currentTarget as HTMLElement;
  target.setPointerCapture(event.pointerId);
  const move = (moveEvent: PointerEvent) => {
    setPanelWidth(window.innerWidth - moveEvent.clientX);
  };
  const stop = () => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", stop);
    target.removeEventListener("pointercancel", stop);
    storePanelWidth(appletPanelWidth.value);
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", stop);
  target.addEventListener("pointercancel", stop);
}

/** The keyboard's way to do what the drag does. */
function onPanelHandleKeydown(event: KeyboardEvent): void {
  const step = event.shiftKey ? 64 : 16;
  if (event.key === "ArrowLeft") setPanelWidth(appletPanelWidth.value + step);
  else if (event.key === "ArrowRight")
    setPanelWidth(appletPanelWidth.value - step);
  else return;
  event.preventDefault();
  storePanelWidth(appletPanelWidth.value);
}

/** The phone's way into a focused Applet while the panel is closed. */
const appletChip = computed(() =>
  phoneLayout.value && !rightPanelOpen.value && state.value.focusedAppletId
    ? (state.value.focusedApplet?.displayName ?? "Applet")
    : undefined,
);
/*
 * What the Bot is doing to it, on the phone.
 *
 * There is no room beside the conversation here, so the chip carries the line
 * the canvas would have shown and opens the canvas over the whole screen. It
 * is the same projection and the same words: a person who moves between their
 * phone and a laptop reads one story, not two.
 */
const appletChipStatus = computed(() => {
  if (!appletChip.value) return undefined;
  const progress = appletProgressV1({
    applet: state.value.focusedApplet ?? null,
    source: state.value.appletSource,
    build: state.value.appletBuild,
    tools: appletProgressToolsV1(state.value.messages),
    running: Boolean(state.value.activeRunId),
  });
  return progress && progress.stage !== "published" ? progress : undefined;
});
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
/*
 * The trigger the User has dismissed with Escape, by its index in the text.
 *
 * The popover is derived from the composer's text on every keyup, so closing it
 * while the `/` is still typed used to last exactly until the Escape key came
 * back up and the derivation opened it again. A dismissal is state the text
 * cannot express, so it is held here: that one trigger stays shut, and typing
 * on past it keeps it shut, until the `/` itself goes and a new trigger begins.
 *
 * Declared beside the state it guards rather than beside the functions that
 * read it: `closeSkillPopover` is called from a watcher that runs during setup,
 * so a `const` further down the file is still in its dead zone by then.
 */
const skillDismissedAt = ref<number | undefined>(undefined);
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
// The Bot's own name, or nothing: an account with no Bot, and a Bot whose
// settings have not arrived yet, must never be given a made-up name.
const botName = computed(() => state.value.botSettings?.profile.name ?? "");
const hasBot = computed(() => Boolean(state.value.activeBotId));
/**
 * The greeting, the composer placeholder and the not-ready line all read off
 * the same two facts: whether a Bot is open, and what the model resolver said.
 * `state.modelLabel` already carries the resolver's own repairable failure
 * sentence when the binding failed, so the surface repeats it rather than
 * inventing "Model unavailable" of its own.
 */
const threadHeading = computed(() => {
  // An unreadable Bot list is not an empty one.
  if (state.value.botsUnavailable) return "Couldn't load your Bots.";
  if (!hasBot.value) return "No Bots yet.";
  if (!botName.value) return state.value.modelReady ? "Ready." : "Not ready.";
  return state.value.modelReady
    ? `${botName.value} is ready.`
    : `${botName.value} isn't ready.`;
});
const threadHint = computed(() => {
  if (state.value.botsUnavailable) {
    return "Check your connection, then try again.";
  }
  if (!hasBot.value) return "Add your first sheep to start a conversation.";
  if (state.value.modelReady) {
    return "Say anything to get started.";
  }
  return state.value.modelLabel;
});
/** A Turn is executing. The composer stays open; only Stop depends on this. */
const isRunning = computed(() => Boolean(state.value.runningRunId));
const isConnecting = computed(() => state.value.connection !== "ready");
/**
 * Sending while the Bot is working is the point: the message supersedes the
 * running Turn. So the only things that close the composer are the ones that
 * would make any message impossible.
 */
const composerPlaceholder = computed(() => {
  if (isConnecting.value) return "Connecting…";
  if (!state.value.modelReady) return state.value.modelLabel;
  return botName.value ? `Message ${botName.value}` : "Message";
});
/*
 * The send route's size rule, enforced where the person can still do something
 * about it. Past the limit the server answers 413 and nothing is sent, so the
 * composer says how much is left before the button closes rather than letting
 * a long message make the round trip to be refused.
 */
const draftText = computed(() => draft.value.trim());
const draftTooLong = computed(() => turnTextTooLongV1(draftText.value));
const draftCounterVisible = computed(() =>
  turnTextCounterVisibleV1(draftText.value),
);
const draftCounterLabel = computed(() => {
  const remaining = turnTextRemainingV1(draftText.value);
  const count = Math.abs(remaining).toLocaleString("en-US");
  return remaining < 0
    ? `${count} characters over the ${TURN_TEXT_MAX_CHARACTERS_V1.toLocaleString("en-US")} limit`
    : `${count} characters left`;
});
const canSend = computed(
  () =>
    state.value.connection === "ready" &&
    state.value.modelReady &&
    Boolean(state.value.activeBotId) &&
    draftText.value.length > 0 &&
    !draftTooLong.value,
);
/**
 * Stop takes the button only while there is nothing to send. The moment the
 * User has typed something, sending it is what they mean by interrupting.
 */
const showStop = computed(() => isRunning.value && !canSend.value);

/*
 * Dictation (voice plan D4).
 *
 * The send button's slot already switches between Send and Stop, and this is
 * the third thing it holds: with nothing to send and nothing to stop, the
 * button offers to listen instead. While it is listening the slot carries a
 * bin and a send, because those are the only two things a person wants next.
 *
 * Nothing here is a second composer. Speech lands in the same draft the
 * keyboard writes to, through the same `ComposerDraftStore`, and Send is the
 * ordinary `sendMessage` — so a message that is half spoken and half typed
 * behaves exactly like one that is entirely typed, including a refusal that
 * gives the draft back.
 */
const voiceState = ref<VoiceDictationStateV1>("idle");
const voiceError = ref<string | undefined>(undefined);
const voiceBars = ref<number[]>(voiceWaveBarsV1(0, []));
const voiceTranscript = new VoiceDictationTranscriptV1();
let voiceSession: VoiceDictationSessionV1 | undefined;
let voiceMicrophone: VoiceMicrophoneV1 | undefined;
/** The exact text dictation last wrote, so a typed edit around it survives. */
let voiceTail = "";
/** Send was pressed; the last transcript is what we are waiting for. */
let voiceSendOnFinal = false;

const dictating = computed(() => voiceState.value !== "idle");

/*
 * Following a release.
 *
 * A reload is destructive, so the shell only does it on its own when there is
 * nothing to lose, and otherwise says so and waits. The bar is not an alert:
 * nothing is wrong, there is just newer code to pick up.
 */
const reloadStore = deploymentReloadStoreV1();
const lastReloadedAt = readDeploymentReloadV1(reloadStore);
const updateBarVisible = ref(false);

function followDeployment(): void {
  const decision = deploymentFollowV1({
    stale: state.value.deploymentStale,
    turnRunning: Boolean(state.value.runningRunId),
    draft: draft.value,
    overlayOpen: Boolean(overlaySurface.value),
    listening: dictating.value,
    holds: state.value.reloadHolds,
    now: Date.now(),
    ...(lastReloadedAt === undefined ? {} : { reloadedAt: lastReloadedAt }),
  });
  updateBarVisible.value = decision === "offer";
  if (decision !== "reload") return;
  reloadNow();
}

function reloadNow(): void {
  writeDeploymentReloadV1(reloadStore, Date.now());
  /*
   * `location.reload()` and nothing else. The Android shell runs this very
   * bundle inside a WebView served from its own origin, so re-navigating to a
   * URL this code built would leave that origin behind; reloading in place
   * works the same way in both.
   */
  window.location.reload();
}

watch(
  [
    () => state.value.deploymentStale,
    () => state.value.runningRunId,
    () => state.value.reloadHolds,
    draft,
    overlaySurface,
    dictating,
  ],
  () => followDeployment(),
  { immediate: true },
);
const voiceButtonLabel = computed(() => voiceButtonLabelV1(voiceState.value));
/**
 * The wave button takes the slot only when the slot is otherwise idle: an
 * empty draft, no Turn to stop, and a platform that can actually listen.
 */
const showVoiceButton = computed(
  () =>
    state.value.voiceAvailable &&
    !dictating.value &&
    !showStop.value &&
    draftText.value.length === 0,
);

function writeDictationIntoDraft(): void {
  const applied = applyDictationTailV1(
    draft.value,
    voiceTail,
    voiceTranscript.text(),
  );
  voiceTail = applied.tail;
  draft.value = applied.draft;
  void nextTick(syncComposerHeight);
}

async function startDictation(): Promise<void> {
  if (dictating.value || !state.value.voiceAvailable) return;
  voiceError.value = undefined;
  voiceTranscript.reset();
  voiceTail = "";
  voiceSendOnFinal = false;
  voiceBars.value = voiceWaveBarsV1(0, []);
  voiceState.value = "starting";
  const session = web.value.openVoiceDictation({
    ready: () => {
      if (voiceState.value === "starting") voiceState.value = "listening";
    },
    delta: (text) => {
      voiceTranscript.delta(text);
      writeDictationIntoDraft();
    },
    transcript: (text) => {
      voiceTranscript.settle(text);
      writeDictationIntoDraft();
    },
    final: () => {
      void completeDictation();
    },
    failed: (message) => {
      voiceError.value = message;
      void stopDictation();
    },
    closed: () => {
      // A socket that goes away mid-capture leaves the draft exactly where it
      // is; the person can still type the rest and send it.
      if (dictating.value) void stopDictation();
    },
  });
  if (!session) {
    voiceState.value = "idle";
    voiceError.value = "Dictation isn't available on this device.";
    return;
  }
  voiceSession = session;
  try {
    voiceMicrophone = await startVoiceMicrophoneV1({
      audio: (pcm16) => session.sendAudio(pcm16),
      level: (value) => {
        voiceBars.value = voiceWaveBarsV1(value, voiceBars.value);
      },
    });
  } catch (error) {
    voiceError.value = voiceMicrophoneRefusalV1(error);
    await stopDictation();
  }
}

/** Everything captured has been transcribed; send it if that is why we stopped. */
async function completeDictation(): Promise<void> {
  const send = voiceSendOnFinal;
  await stopDictation();
  if (send) await sendMessage();
}

async function stopDictation(): Promise<void> {
  voiceState.value = "idle";
  voiceSendOnFinal = false;
  voiceBars.value = voiceWaveBarsV1(0, []);
  const microphone = voiceMicrophone;
  const session = voiceSession;
  voiceMicrophone = undefined;
  voiceSession = undefined;
  await microphone?.stop();
  session?.close();
}

/** The bin. Discards what was dictated, exactly as D4 says it does. */
function discardDictation(): void {
  voiceSession?.cancel();
  voiceTranscript.reset();
  voiceTail = "";
  draft.value = "";
  voiceError.value = undefined;
  void stopDictation();
  void nextTick(syncComposerHeight);
}

/**
 * Send, mid-dictation. The audio is committed and the message waits for the
 * last transcript rather than sending half a sentence.
 */
function sendDictation(): void {
  if (voiceState.value !== "listening") return;
  voiceSendOnFinal = true;
  voiceState.value = "finishing";
  voiceSession?.commit();
}

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

function iframeEntriesFor(tool: WebToolActivity) {
  const separator = tool.name.indexOf("/");
  const namespace = separator < 0 ? undefined : tool.name.slice(0, separator);
  const toolName = separator < 0 ? tool.name : tool.name.slice(separator + 1);
  const slot = `frockbot.tool-result:${toolName}`;
  return (state.value.packageUi?.contributions ?? [])
    .filter(
      (contribution) =>
        namespace === undefined || contribution.packageId === namespace,
    )
    .flatMap((contribution) =>
      contribution.pages.flatMap((page) =>
        page.mounts
          .filter((mount) => mount.slot === slot)
          .map((mount) => ({
            contribution,
            page,
            slot,
            order: mount.order ?? 0,
          })),
      ),
    )
    .sort(
      (left, right) =>
        left.order - right.order ||
        left.contribution.packageId.localeCompare(right.contribution.packageId),
    );
}

function toolResultState(tool: WebToolActivity): unknown {
  if (tool.text === undefined) return { status: tool.status };
  try {
    return JSON.parse(tool.text) as unknown;
  } catch {
    return { content: tool.text, isError: tool.status === "failed" };
  }
}

/** The Workspace read route for one encoded `WorkspacePathV1`. */
function workspaceFileUrl(path: string): string {
  const botId = state.value.activeBotId ?? "";
  return `/api/bots/${encodeURIComponent(botId)}/workspace/file?path=${encodeURIComponent(path)}`;
}

/**
 * One dispatched subagent, merged with what it currently is.
 *
 * The chip's identity — type, description, model — is the durable dispatch on
 * the run, which never changes. Its status and its summary come from the Bot's
 * task list, because a background subagent settles long after the Turn that
 * dispatched it is over. The backend is the authority for both halves; this
 * only joins them.
 */
function taskChipsOf(message: WebChatMessage): Array<{
  chip: WebTaskChip;
  status: string;
  summary?: string;
}> {
  return (message.tasks ?? []).map((chip) => {
    const record = state.value.tasks.find(
      (candidate) => candidate.taskId === chip.taskId,
    );
    return {
      chip,
      status: record?.status ?? "queued",
      ...(record?.summary === undefined
        ? record?.failure === undefined
          ? {}
          : { summary: record.failure }
        : { summary: record.summary }),
    };
  });
}

/** Which chips the User has opened. Local, and per chip. */
const expandedTasks = ref(new Set<string>());

function toggleTask(taskId: string): void {
  const next = new Set(expandedTasks.value);
  if (!next.delete(taskId)) next.add(taskId);
  expandedTasks.value = next;
}

/** A subagent still live is one the User may stop; a settled one is not. */
function isTaskLive(status: string): boolean {
  return status === "queued" || status === "running";
}

function stopTask(taskId: string): void {
  void web.value.stopTask(taskId);
}

function isVisible(message: WebChatMessage): boolean {
  if (message.role === "user") return message.text.length > 0;
  if (message.role === "system") return message.text.length > 0;
  // A Turn the Bot ended with a widget writes no assistant text at all, so a
  // send is on its own enough to draw the line — and so is a Turn whose only
  // visible act was dispatching a subagent.
  return (
    message.text.length > 0 ||
    (message.notice?.length ?? 0) > 0 ||
    message.tools.some((tool) => iframeEntriesFor(tool).length > 0) ||
    message.sends.length > 0 ||
    (message.tasks?.length ?? 0) > 0 ||
    message.status === "streaming"
  );
}
/*
 * System lines happen between Turns, so the thread orders by when each line
 * happened — but a Turn moves as a unit, anchored on the message the person
 * sent, or a reply stamped from this tab's clock sorts above the durable
 * timestamps of the messages it answers. `transcript-order.ts` holds the rule.
 */
const messages = computed(() =>
  orderTranscriptV1(
    state.value.messages.filter(isVisible),
    new Date().toISOString(),
  ),
);

/**
 * The comet trail: what the Turn the User is watching is actually doing.
 *
 * A Turn that spends a minute making tool calls used to show the User nothing
 * but a breathing avatar, and then — briefly — a list of tool names, which put
 * the model's plumbing into a conversation. The trail is neither. Particles
 * stream off the right of the working Bot's avatar at the rate text is
 * arriving, burst when a tool call starts or settles, flash when a reply
 * lands, and trickle while the Turn waits on the model. Nobody is told which
 * tool ran; the transcript stays a conversation.
 *
 * The mapping is `activity-trail.ts`, which is pure. This is the part that
 * cannot be: reading the open Turn out of the projection, and keeping a slow
 * tick so the trickle can start when a Turn goes quiet without anything
 * arriving to notice it.
 */

/** How often the trail is re-read when nothing has changed. */
const TRAIL_TICK_MS = 400;

/** Bursts kept in the log handed to the canvas. Older ones have long fired. */
const TRAIL_BURST_LOG = 24;

const trailRate = ref(0);
const trailState = ref<ActivityTrailStateV1>("ended");
const trailBursts = ref<ActivityTrailBurstEventV1[]>([]);
let trailMemory: ActivityTrailMemoryV1 | null = null;
let trailRunId: string | undefined;
let trailSeq = 0;
let trailTick = 0;
/** The drain's clock, advanced by the same tick the trail runs on. */
const drainNow = ref(Date.now());

/**
 * The Turn still going, if any. Only one executes at a time, but a Turn queued
 * behind it is streaming-shaped too and has produced nothing yet, so the
 * executing one wins: the trail keeps reading the words that are arriving
 * rather than restarting on a Turn that has not begun.
 */
const workingMessage = computed(() => {
  const streaming = messages.value.filter(
    (message) => message.role === "assistant" && message.status === "streaming",
  );
  return streaming.find((message) => !message.pending) ?? streaming.at(-1);
});

const workingSample = computed(() => {
  const message = workingMessage.value;
  if (message === undefined) return undefined;
  return activityTrailSampleV1({
    text: message.text,
    toolStatuses: message.tools.map((tool) => tool.status),
    // Counted across the whole Turn, because every send the Bot delivers is a
    // message of its own and the working line carries none of them. A send is
    // still a beat the trail has to feel.
    sends: messages.value.reduce(
      (total, candidate) =>
        candidate.runId === message.runId
          ? total + candidate.sends.length
          : total,
      0,
    ),
    status: message.status,
  });
});

function stepTrail(): void {
  // The same tick the trail runs on carries the drain's clock: "this has been
  // stopping for twenty seconds" is not an event either.
  drainNow.value = Date.now();
  const sample = workingSample.value;
  const message = workingMessage.value;
  const now = Date.now();
  if (sample === undefined || message === undefined) {
    trailMemory = null;
    trailRunId = undefined;
    trailRate.value = 0;
    trailState.value = "ended";
    return;
  }
  // A second Turn starts from nothing rather than inheriting the first one's
  // character count, which would otherwise read as a huge negative delta.
  if (trailMemory === null || trailRunId !== message.runId) {
    trailRunId = message.runId;
    trailMemory = activityTrailBeginV1(sample, now);
  }
  const stepped = activityTrailStepV1(trailMemory, sample, now);
  trailMemory = stepped.memory;
  trailRate.value = stepped.plan.rate;
  trailState.value = stepped.plan.state;
  if (stepped.plan.bursts.length === 0) return;
  const log = [...trailBursts.value];
  for (const burst of stepped.plan.bursts) {
    trailSeq += 1;
    log.push({ seq: trailSeq, ...burst });
  }
  trailBursts.value = log.slice(-TRAIL_BURST_LOG);
}

watch(workingSample, () => {
  stepTrail();
});

/*
 * A message sent into a running Turn supersedes it, and the new Turn starts
 * only once the old one has settled. The row above the person's message is
 * still the Turn they replaced, so for those seconds it says so.
 * `supersede-drain.ts` holds the whole rule; this reads it against the
 * transcript and the tick's clock.
 */
const supersedeDrain = computed(() =>
  supersedeDrainStateV1({ messages: messages.value, now: drainNow.value }),
);
const workingLabel = computed(
  () => supersedeDrainLabelV1(supersedeDrain.value) ?? "Working",
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
/*
 * A conversation opens at its end, not at its start with a scroll after it.
 *
 * While this is true the thread is laid out and measured but not painted, so
 * the frames where it sits at the top — and where a late-measuring code block
 * or image moves it — are never shown. It is turned off inside a
 * `requestAnimationFrame` callback, which runs after layout and before the
 * paint of that same frame, so the first frame the reader sees is the last
 * Turn and there is no animation between the two.
 */
const threadSettling = ref(true);
/*
 * True until this Bot's transcript has arrived. A Bot the cache was not
 * holding opens empty and fills in from the read, and that arrival is an
 * opening rather than new content: it is placed without a paint in between,
 * the same as a restored one, instead of scrolling down where it can be seen.
 */
const threadOpening = ref(true);

function onThreadScroll(): void {
  const element = thread.value;
  if (!element) return;
  // A scroll the settling pass caused is not the reader moving.
  if (threadSettling.value) return;
  pinnedToLatest.value =
    element.scrollHeight - element.scrollTop - element.clientHeight <=
    nearBottomThreshold;
  if (pinnedToLatest.value) hasUnseenBelow.value = false;
}

/** Puts the thread at its end now, without a scroll the reader can see. */
function pinToLatest(): void {
  const element = thread.value;
  if (!element) return;
  element.scrollTop = element.scrollHeight;
  pinnedToLatest.value = true;
  hasUnseenBelow.value = false;
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

/**
 * Opens a transcript where the reader left it, before the first paint.
 *
 * `viewport` is where they were when they switched away from this Bot;
 * without one — or with one that was at the end — the thread opens at the
 * end, which is where a conversation is read from.
 */
async function settleThread(viewport?: {
  scrollTop: number;
  pinnedToLatest: boolean;
}): Promise<void> {
  threadSettling.value = true;
  await nextTick();
  const place = (): void => {
    const element = thread.value;
    if (!element) return;
    if (viewport && !viewport.pinnedToLatest) {
      element.scrollTop = viewport.scrollTop;
      pinnedToLatest.value = false;
      return;
    }
    pinToLatest();
  };
  place();
  /*
   * Whichever comes first. The frame callback is the one that matters — it
   * runs after layout and before that frame is painted, which is what makes
   * the opening invisible. The timer is a floor under it: a thread that is
   * hidden is a thread nobody can read or measure, so a browser that
   * withholds frames from a backgrounded or throttled page must not be able
   * to leave it that way.
   */
  let revealed = false;
  const reveal = (): void => {
    if (revealed) return;
    revealed = true;
    // Layout has happened: anything that measured late — a rendered code
    // block, an avatar — has its real height now, so this is the placement
    // the reader actually sees.
    place();
    threadSettling.value = false;
  };
  if (typeof requestAnimationFrame === "function")
    requestAnimationFrame(reveal);
  setTimeout(reveal, 120);
}

/** Where the reader has this Bot's thread, for the cache to hold. */
function threadViewport(): { scrollTop: number; pinnedToLatest: boolean } {
  const element = thread.value;
  return {
    scrollTop: element?.scrollTop ?? 0,
    pinnedToLatest: pinnedToLatest.value,
  };
}

/*
 * Content that changes height after it is drawn — a loaded image, Markdown
 * that reflowed — must not move a reader who is at the end away from it.
 * Every message is observed, because the one that grows is usually the last
 * but is not always.
 */
let threadResize: ResizeObserver | undefined;
function observeThreadContent(): void {
  const element = thread.value;
  if (!element || !threadResize) return;
  threadResize.disconnect();
  for (const child of element.children) threadResize.observe(child);
}

/*
 * Settings deep links. `?settings=<surface>#<anchor>` names a registered
 * surface or the default Bot panel and one row inside it; the shell opens it and announces the
 * anchor, and the anchored row highlights itself. The row is deliberately not
 * hunted for here: a panel loads its state after it mounts, so `UiAnchor` also
 * reads the fragment on its own mount and the two paths cover a link followed
 * cold and a link followed while the panel is already open.
 */
const applySettingsDeepLink = (): void => {
  const target = decodeSettingsLinkV1(window.location.href);
  if (!target) return;
  if (target.surface === "bot-panel") {
    surfaces.close();
    rightPanelOpen.value = true;
  } else {
    if (!surfaces.has(target.surface)) return;
    if (surfaces.activeId.value !== target.surface)
      surfaces.open(target.surface);
  }
  const anchor = target.anchor;
  if (anchor) void nextTick(() => announceUiAnchor(anchor));
};

onMounted(() => {
  void web.value.loadPluginCatalog();
  if (typeof ResizeObserver === "function") {
    threadResize = new ResizeObserver(() => {
      if (pinnedToLatest.value || threadSettling.value) pinToLatest();
    });
    observeThreadContent();
  }
  threadOpening.value = messages.value.length === 0;
  void settleThread(
    state.value.activeBotId
      ? web.value.transcripts.viewportFor(state.value.activeBotId)
      : undefined,
  );
  void nextTick(syncComposerHeight);
  applySettingsDeepLink();
  window.addEventListener("popstate", applySettingsDeepLink);
  window.addEventListener("hashchange", applySettingsDeepLink);
  phoneLayoutMedia?.addEventListener("change", onPhoneLayoutChange);
  window.addEventListener("keydown", onRootKeydown);
  // The trail is event-driven, but "nothing has arrived for a second and a
  // half" is not an event: this slow tick is what notices it.
  trailTick = window.setInterval(stepTrail, TRAIL_TICK_MS);
});

onBeforeUnmount(() => {
  window.clearInterval(trailTick);
  threadResize?.disconnect();
  threadResize = undefined;
  window.removeEventListener("popstate", applySettingsDeepLink);
  window.removeEventListener("hashchange", applySettingsDeepLink);
  phoneLayoutMedia?.removeEventListener("change", onPhoneLayoutChange);
  window.removeEventListener("keydown", onRootKeydown);
  // A microphone outlives a component that stops drawing it unless it is told
  // not to, and a browser shows the recording indicator for as long as it does.
  void stopDictation();
});

watch(
  // Message count moves on a new Turn; the last message's length moves on
  // every streamed delta.
  () =>
    [messages.value.length, messages.value.at(-1)?.text.length ?? 0] as const,
  ([count], [previousCount]) => {
    void nextTick(observeThreadContent);
    // A transcript still settling is placed by `settleThread`, which is the
    // path that never shows the move.
    if (threadSettling.value) return;
    if (threadOpening.value && count > 0) {
      threadOpening.value = false;
      void settleThread(
        state.value.activeBotId
          ? web.value.transcripts.viewportFor(state.value.activeBotId)
          : undefined,
      );
      return;
    }
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
  (botId, previousBotId) => {
    // Choosing a Bot is what the drawer is for, so it closes behind the choice
    // rather than covering the conversation it just opened.
    closeNav();
    // Pre-flush: the thread on screen is still the Bot being left, so this is
    // the scroll position to come back to.
    if (previousBotId) {
      web.value.transcripts.rememberViewport(previousBotId, threadViewport());
    }
    // A restored transcript is already here, so this switch is not opening on
    // an empty thread and the arrival below is not one either.
    threadOpening.value = messages.value.length === 0;
    void settleThread(
      botId ? web.value.transcripts.viewportFor(botId) : undefined,
    );
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
watch(
  draft,
  () => {
    void nextTick(syncComposerHeight);
  },
  { flush: "post" },
);
watch(panelSurface, (surface) => {
  if (surface) rightPanelOpen.value = true;
});
/*
 * A surface is the thing the User asked for, and on a phone it fills the
 * window. The drawer that offered it has served its purpose either way.
 */
watch(
  () => surfaces.activeId.value,
  (surface) => {
    if (surface) closeNav();
  },
);

/** Keep the textarea at its content height until its CSS maximum takes over. */
function syncComposerHeight(): void {
  const input = composerInput.value;
  if (!input) return;
  input.style.height = "auto";
  const maxHeight = Number.parseFloat(getComputedStyle(input).maxHeight);
  const contentHeight = input.scrollHeight;
  const height = Number.isFinite(maxHeight)
    ? Math.min(contentHeight, maxHeight)
    : contentHeight;
  input.style.height = `${height}px`;
  input.style.overflowY =
    Number.isFinite(maxHeight) && contentHeight > maxHeight ? "auto" : "hidden";
}

function syncAttachedSkills(): void {
  attachedSkills.value = [...skillStore.attached()];
}

function closeSkillPopover(): void {
  skillPopover.value = undefined;
  skillHighlight.value = 0;
  skillDismissedAt.value = undefined;
}

function dismissSkillPopover(): void {
  const at = skillPopover.value?.at;
  closeSkillPopover();
  skillDismissedAt.value = at;
}

function refreshSkillPopover(): void {
  const element = composerInput.value;
  if (!element) return closeSkillPopover();
  // Read the highlighted Skill before the query moves, so the refilter below
  // can put the highlight back on the same Skill rather than on row zero.
  const highlighted = skillCandidates.value[skillHighlight.value]?.entry.ref;
  const open = skillPopoverForV1(draft.value, element.selectionStart ?? 0);
  if (!open) return closeSkillPopover();
  if (skillDismissedAt.value === open.at) {
    skillPopover.value = undefined;
    skillHighlight.value = 0;
    return;
  }
  skillPopover.value = open;
  skillHighlight.value = keptSkillHighlightV1(
    highlighted,
    skillCandidates.value,
  );
}

/*
 * The popover is bounded and scrolls, so a highlight moved past its edge has
 * to bring its row with it; `nearest` leaves a row that is already visible
 * exactly where it is.
 */
const skillPopoverList = ref<HTMLUListElement | undefined>(undefined);
watch(skillHighlight, (index) => {
  void nextTick(() => {
    const option = skillPopoverList.value?.children.item(index);
    if (option instanceof HTMLElement && option.scrollIntoView) {
      option.scrollIntoView({ block: "nearest" });
    }
  });
});

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
  void nextTick(syncComposerHeight);
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

/**
 * Sends the message a broken Turn was answering, again, as a new Turn.
 *
 * The same words the person already sent — read back off their own line in the
 * thread — and nothing else: a retry is not an edit, and it starts a Turn of
 * its own rather than reopening the one that ended.
 */
async function retryTurn(message: WebChatMessage): Promise<void> {
  if (!canSend.value) return;
  const text = messages.value
    .find(
      (candidate) =>
        candidate.runId === message.runId && candidate.role === "user",
    )
    ?.text.trim();
  if (!text) return;
  pinnedToLatest.value = true;
  void scrollToLatest();
  await web.value.sendPrompt(text);
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
      dismissSkillPopover();
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
  if (event.key === "Escape" && dictating.value) {
    // Escape is the keyboard's bin, the same as it is for the Skill popover.
    event.preventDefault();
    discardDictation();
    return;
  }
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  // Enter means send either way; mid-dictation it commits the audio first so
  // the last word spoken is in the message.
  if (dictating.value) {
    sendDictation();
    return;
  }
  void sendMessage();
}
</script>

<template>
  <div class="frockbot-root">
    <!--
      The workspace under an open surface.

      A drawer that covers the app while the app behind it still answers the
      Tab key is two live UIs at once: a screen reader reads straight past the
      panel into the conversation, and the focus ring disappears behind the
      scrim. `inert` says which layer the User is in, and takes the background
      out of the accessibility tree for exactly as long as the panel is over
      it. A panel-placed surface sits inside this shell rather than over it, so
      it is not one of these.
    -->
    <div
      class="app-shell"
      :inert="Boolean(overlaySurface) || undefined"
      :class="{
        'panel-open': rightPanelOpen,
        'panel-surface': Boolean(panelSurface),
        'panel-applet': appletCanvasOpen,
        'mac-desktop': macDesktop,
        'phone-layout': phoneLayout,
        'nav-open': navOpen,
      }"
      :style="{ '--applet-panel-width': `${appletPanelWidth}px` }"
    >
      <aside
        class="sidebar"
        :aria-hidden="phoneLayout && !navOpen"
        :inert="phoneLayout && !navOpen"
      >
        <div class="brand" aria-hidden="true">
          <span class="brand-mark">FrockBot</span>
        </div>
        <div class="sidebar-top">
          <k-slot name="frockbot.sidebar-top" />
        </div>
        <div class="bot-list">
          <k-slot name="frockbot.sidebar-bots" />
        </div>
        <div class="sidebar-bottom">
          <k-slot name="frockbot.sidebar-actions" />
          <k-slot name="frockbot.user-profile" />
        </div>
      </aside>

      <!--
        The dimmed conversation behind an open drawer, and the way back to it.
        It sits under both drawers and over the workspace, so a tap anywhere on
        what is still visible of the conversation closes what covers it.
      -->
      <Transition name="scrim">
        <button
          v-if="phoneLayout && (navOpen || rightPanelOpen)"
          type="button"
          class="nav-scrim"
          aria-label="Close drawer"
          @click="closeDrawers"
        />
      </Transition>

      <main class="workspace">
        <header class="topbar">
          <!--
            The way back to the Bot list on a phone, where the sidebar is a
            drawer. At desktop widths the column is simply there and a control
            that opens it would be a control that does nothing.
          -->
          <UiIconButton
            v-if="phoneLayout"
            class="nav-toggle"
            icon="menu"
            label="Show navigation"
            @click="openNav"
          />
          <span class="bot-identity"
            ><k-slot name="frockbot.bot-identity"
          /></span>
          <div v-if="hasBot" class="workspace-title">
            <strong>{{ botName }}</strong>
            <small>{{ state.modelLabel }}</small>
          </div>
          <k-slot name="frockbot.header-actions" />
          <!--
            A phone has no right panel on screen, so the controls that live in
            its header — the settings gear above all, the only route to
            Routines, the audit log and template import — have nowhere to be.
            They come here instead, where the panel's own header would be at a
            desktop width. The panel keeps them at every other size, so they
            are never drawn twice.
          -->
          <div v-if="phoneLayout && !rightPanelOpen" class="topbar-bot-actions">
            <k-slot name="frockbot.bot-actions" />
          </div>
        </header>

        <section
          ref="thread"
          class="thread"
          :class="{ 'thread-settling': threadSettling }"
          aria-live="polite"
          @scroll.passive="onThreadScroll"
        >
          <div v-if="messages.length === 0" class="empty-thread">
            <div class="empty-mark"><UiIcon name="sparkle" size="lg" /></div>
            <h1>{{ threadHeading }}</h1>
            <p>{{ threadHint }}</p>
          </div>
          <article
            v-for="message in messages"
            v-else
            :id="turnAnchors.get(message.id)"
            :key="message.id"
            class="message"
            :class="[
              `message-${message.role}`,
              { 'message-pending': message.pending },
            ]"
          >
            <!--
              A system line is the product speaking, not the Bot, so it has no
              avatar and no bubble — and when the thing it reports is something
              the person can act on, it carries the same Retry the failed
              assistant row does rather than leaving them to find the composer.
            -->
            <template v-if="message.role === 'system'">
              <p class="message-system-line">{{ message.text }}</p>
              <button
                v-if="message.retry === 'resend'"
                type="button"
                class="message-retry"
                :disabled="!canSend"
                @click="sendMessage()"
              >
                Retry
              </button>
            </template>
            <template v-else-if="message.role === 'assistant'">
              <div class="message-column">
                <div v-if="message.text" class="message-bubble">
                  <UiMarkdown :text="message.text" />
                </div>
                <!--
                  Why the Turn ends where it does, under whatever it had
                  already said rather than in place of it.
                -->
                <p v-if="message.notice" class="message-notice">
                  {{ message.notice }}
                </p>
                <!--
                  The way out of an ending the person cannot otherwise act on:
                  the client could not reach the Bot, their text is back in the
                  composer, and this sends it again.
                -->
                <button
                  v-if="message.retry === 'resend'"
                  type="button"
                  class="message-retry"
                  :disabled="!canSend"
                  @click="sendMessage()"
                >
                  Retry
                </button>
                <!--
                  The reply broke after the message was admitted, so the
                  message is in the thread and the composer is empty: this
                  sends the same words again as a new Turn, in place of the
                  "Try again." the notice used to end with and nobody could
                  press.
                -->
                <button
                  v-if="message.retry === 'resend-turn'"
                  type="button"
                  class="message-retry"
                  :disabled="!canSend"
                  @click="retryTurn(message)"
                >
                  Try again
                </button>
                <template v-for="tool in message.tools" :key="tool.id">
                  <PackageIframeHost
                    v-for="entry in iframeEntriesFor(tool)"
                    :key="`${tool.id}:${entry.contribution.packageId}:${entry.page.id}`"
                    class="message-package-iframe"
                    :contribution="entry.contribution"
                    :page="entry.page"
                    :slot="entry.slot"
                    :states="{ [`tool:${tool.name}`]: toolResultState(tool) }"
                  />
                </template>
                <!--
                A binary a tool filed in the Workspace, drawn from the
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
                <!--
                The subagents this Turn dispatched. The child's own Session is
                never in this transcript, so the chip is the whole of what the
                conversation says about it; opening one shows the summary the
                child handed back and nothing else.
              -->
                <div
                  v-if="taskChipsOf(message).length > 0"
                  class="message-tasks"
                >
                  <button
                    v-for="entry in taskChipsOf(message)"
                    :key="entry.chip.taskId"
                    type="button"
                    class="task-chip"
                    :class="`task-chip-${entry.status}`"
                    :aria-expanded="expandedTasks.has(entry.chip.taskId)"
                    @click="toggleTask(entry.chip.taskId)"
                  >
                    <span class="task-chip-type">{{
                      entry.chip.taskType
                    }}</span>
                    <span class="task-chip-description">{{
                      entry.chip.description
                    }}</span>
                    <span class="task-chip-status">{{ entry.status }}</span>
                    <span class="task-chip-model">{{ entry.chip.model }}</span>
                    <span
                      v-if="expandedTasks.has(entry.chip.taskId)"
                      class="task-chip-summary"
                      >{{
                        entry.summary ??
                        "This subagent has not reported a summary yet."
                      }}</span
                    >
                    <!--
                    Cancellation is the User's, explicit and authenticated. It
                    is offered only while the subagent is live: a settled one
                    has an outcome, and stopping it would rewrite it.
                  -->
                    <span
                      v-if="
                        expandedTasks.has(entry.chip.taskId) &&
                        isTaskLive(entry.status)
                      "
                      class="task-chip-stop"
                      role="button"
                      tabindex="0"
                      @click.stop="stopTask(entry.chip.taskId)"
                      @keydown.enter.stop.prevent="stopTask(entry.chip.taskId)"
                      @keydown.space.stop.prevent="stopTask(entry.chip.taskId)"
                      >Stop this subagent</span
                    >
                  </button>
                </div>
              </div>
            </template>
            <div v-else class="message-user-column">
              <div class="message-bubble">{{ message.text }}</div>
              <span v-if="message.via" class="message-via">
                via {{ message.via.name }}
              </span>
            </div>
          </article>
          <!--
            The working row: the Bot's own avatar on its own line at the end of
            the thread, with the comet trail streaming off to its right. It
            appears only while a Turn is running. Every line in this transcript
            is from the same Bot — there are no group conversations yet (issue
            152) — so a sheep beside a settled reply named nobody the reader did
            not already know; the one under a running Turn is the whole account
            of what the Bot is doing.

            It is a child of the thread rather than of the running Turn's
            article, so it is always the last thing in the transcript. Send a
            message while the Bot is still winding down and the new message
            lands above the sheep, where a reader looking at the bottom of the
            thread expects the newest thing to be — not underneath a running
            Turn that is already over.

            The art comes from whichever Package owns Bot identity; when no
            Package fills the slot the sparkle tile is the only child and shows
            through. The row carries the status role, and the canvas beside it
            is hidden from assistive technology: the trail is a picture of a
            fact the label already states.
          -->
          <Transition name="bot-working">
            <div
              v-if="workingMessage"
              class="bot-working"
              role="status"
              :aria-label="workingLabel"
              :data-supersede="supersedeDrain"
            >
              <div
                class="bot-avatar bot-avatar-live"
                :class="{ 'bot-avatar-waiting': !workingMessage.text }"
              >
                <span class="bot-avatar-fallback" aria-hidden="true"
                  ><UiIcon name="sparkle" size="sm"
                /></span>
                <k-slot name="frockbot.bot-avatar" />
              </div>
              <UiActivityTrail
                class="bot-working-indicator"
                :rate="trailRate"
                :bursts="trailBursts"
                :state="trailState"
              />
              <span
                v-if="supersedeDrain !== 'none'"
                class="bot-working-label"
                >{{ workingLabel }}</span
              >
            </div>
          </Transition>
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
              Try again
            </button>
          </div>
        </Transition>

        <Transition name="banner">
          <!--
            One bar at a time in this spot. A failed Turn is the more urgent
            thing to read, and newer code is still there once it is dealt with.
          -->
          <div
            v-if="updateBarVisible && !state.error && !state.activeRun"
            class="update-banner"
            role="status"
          >
            <span>{{ DEPLOYMENT_UPDATED_MESSAGE_V1 }}</span>
            <button type="button" @click="reloadNow()">
              {{ DEPLOYMENT_RELOAD_LABEL_V1 }}
            </button>
          </div>
        </Transition>

        <!--
          No Bot, no composer. A disabled input under a made-up Bot name reads
          as a broken Bot; the first-run pane above points at making one.
        -->
        <form
          v-if="hasBot"
          class="composer"
          :class="{ 'composer-busy': isRunning }"
          @submit.prevent="sendMessage"
        >
          <ul
            v-if="skillPopoverOpen"
            ref="skillPopoverList"
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
          <!--
            The phone's way back to a focused Applet. The panel is a drawer
            here, so with it closed there is nothing on screen that says an
            Applet is in play; this chip both says so and opens it.
          -->
          <button
            v-if="appletChip"
            type="button"
            class="applet-chip"
            data-testid="applet-chip"
            @click="toggleRightPanel"
          >
            <UiIcon name="applets" size="sm" />
            <span class="applet-chip-text">
              <span class="applet-chip-name">Applet: {{ appletChip }}</span>
              <span v-if="appletChipStatus" class="applet-chip-status">
                <span
                  v-if="appletChipStatus.working"
                  class="applet-chip-dot"
                  aria-hidden="true"
                />
                {{ appletChipStatus.failure ?? appletChipStatus.label }}
              </span>
            </span>
            <span class="applet-chip-action">{{
              appletChipStatus ? "Watch" : "Open"
            }}</span>
          </button>
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
              :placeholder="composerPlaceholder"
              :disabled="isConnecting || !state.modelReady"
              rows="1"
              role="combobox"
              :aria-expanded="skillPopoverOpen"
              aria-controls="skill-popover"
              @input="syncComposerHeight"
              @keydown="handleComposerKeydown"
              @keyup="refreshSkillPopover"
              @click="refreshSkillPopover"
              @blur="closeSkillPopover"
            />
            <!--
              Silent until the budget is nearly spent, then it says how much is
              left — and, past the limit, how much has to go before the send
              button opens again.
            -->
            <p
              v-if="draftCounterVisible"
              class="composer-counter"
              :class="{ 'composer-counter-over': draftTooLong }"
              aria-live="polite"
            >
              {{ draftCounterLabel }}
            </p>
            <!--
              The capture animation, and the only place the state is written
              out. It is level-driven from the microphone: bars that move while
              the room is silent would say the microphone works when it does
              not.
            -->
            <p
              v-if="dictating"
              class="voice-capture"
              role="status"
              aria-live="polite"
            >
              <span class="voice-wave" aria-hidden="true">
                <span
                  v-for="(bar, index) in voiceBars"
                  :key="index"
                  class="voice-wave-bar"
                  :style="{ transform: `scaleY(${bar})` }"
                />
              </span>
              <span>{{ voiceButtonLabel }}</span>
            </p>
            <!--
              Why dictation stopped, in the words the server or the browser
              used. It sits under the draft it could not add to, and the draft
              itself is untouched.
            -->
            <p v-if="voiceError" class="voice-error" role="alert">
              {{ voiceError }}
            </p>
          </div>
          <!--
            Start a new conversation. Sits beside the composer because that is
            where you are when you decide the last one is finished. Disabled
            while a Turn is running: the Bot is still writing to it.
          -->
          <UiIconButton
            icon="plus"
            label="New conversation"
            variant="ghost"
            class="new-conversation-button"
            :disabled="isRunning"
            @click="web.startConversation()"
          />
          <!--
            The send slot, and its four states. Dictation replaces the one
            button with two, because while it is listening the only two things
            worth offering are "throw this away" and "that's the message".
          -->
          <template v-if="dictating">
            <UiIconButton
              class="voice-discard-button"
              icon="trash"
              label="Discard dictation"
              variant="ghost"
              @click="discardDictation"
            />
            <UiIconButton
              class="voice-send-button"
              icon="arrow-up"
              label="Send dictated message"
              variant="primary"
              :disabled="voiceState !== 'listening'"
              @click="sendDictation"
            />
          </template>
          <UiIconButton
            v-else-if="showStop"
            class="stop-button"
            icon="stop"
            label="Stop generating"
            variant="primary"
            @click="web.stopRun()"
          />
          <UiIconButton
            v-else-if="showVoiceButton"
            class="voice-button"
            icon="waveform"
            :label="voiceButtonLabel"
            variant="primary"
            @click="startDictation"
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
        <!--
          The edge the User drags to make room for an Applet. It is a real
          control, not a hairline: it takes focus and the arrow keys do what
          the drag does.
        -->
        <div
          v-if="appletCanvasOpen && !phoneLayout"
          class="applet-panel-handle"
          role="separator"
          tabindex="0"
          aria-orientation="vertical"
          aria-label="Resize the Applet panel"
          :aria-valuenow="appletPanelWidth"
          :aria-valuemin="320"
          :aria-valuemax="900"
          @pointerdown="onPanelHandlePointerDown"
          @keydown="onPanelHandleKeydown"
        />
        <div class="right-panel-stack">
          <Transition name="panel-swap">
            <div v-show="!panelSurface" class="right-panel-content">
              <!--
                A focused Applet takes the panel; with none, the panel is the
                one its plugins have always drawn.
              -->
              <AppletCanvas v-if="appletCanvasOpen" />
              <template v-else>
                <!--
                  The Bot's own controls sit wherever they can actually be
                  pressed, and in exactly one place: here at desktop widths and
                  whenever the panel is over the conversation, in the topbar on
                  a phone with the panel closed. Two gears with the same name
                  is two answers to "where is Bot settings", and one of them is
                  always the one behind the open drawer.
                -->
                <header
                  v-if="!phoneLayout || rightPanelOpen"
                  class="right-panel-header"
                >
                  <k-slot name="frockbot.bot-actions" />
                </header>
                <div class="right-panel-body">
                  <k-slot name="frockbot.right-panel" />
                </div>
              </template>
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
                  icon="chevron-left"
                  label="Back to Bot panel"
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

      <!--
        The panel's own toggle. It stays at every width: on a phone the panel
        is a drawer, and this is the only way to open it — the Bot's own
        controls moved to the topbar (above), but the panel holds more than
        they do. What made it read wrongly on a phone was being the *only*
        survivor of that pair, saying "hide" beside a gear that had nowhere
        to be.
      -->
      <div class="window-actions">
        <UiIconButton
          class="panel-toggle"
          :icon="rightPanelOpen ? 'chevrons-right' : 'chevrons-left'"
          :label="rightPanelOpen ? 'Hide side panel' : 'Show side panel'"
          @click="toggleRightPanel"
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
