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
  type WebTaskChip,
  type WebToolAttachment,
  type WebToolActivity,
} from "../shared.js";
import { ComposerDraftStore } from "./composer-draft.js";
import SendPayloadView from "./SendPayloadView.vue";
import AppletCanvas from "./AppletCanvas.vue";
import PackageIframeHost from "./PackageIframeHost.vue";
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
  if (!hasBot.value) return "No Bots yet.";
  if (!botName.value) return state.value.modelReady ? "Ready." : "Not ready.";
  return state.value.modelReady
    ? `${botName.value} is ready.`
    : `${botName.value} isn't ready.`;
});
const threadHint = computed(() => {
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
const canSend = computed(
  () =>
    state.value.connection === "ready" &&
    state.value.modelReady &&
    Boolean(state.value.activeBotId) &&
    draft.value.trim().length > 0,
);
/**
 * Stop takes the button only while there is nothing to send. The moment the
 * User has typed something, sending it is what they mean by interrupting.
 */
const showStop = computed(() => isRunning.value && !canSend.value);

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

/**
 * The tools this Turn ran, as the thread draws them.
 *
 * A tool whose Package draws its own surface is shown by that surface; every
 * other one is a chip, because a Turn that spends a minute making tool calls
 * used to show the User nothing at all but a spinning avatar.
 */
function toolChipsOf(message: WebChatMessage): WebToolActivity[] {
  return message.tools.filter((tool) => iframeEntriesFor(tool).length === 0);
}

/**
 * What a chip calls a tool, in the User's words rather than the model's.
 *
 * A tool name is an identifier — `send_to_user`, `user-Github--acme/search_issues`
 * — and the transcript is a conversation, so the chip drops the namespace,
 * un-snakes the rest and capitalises it.
 */
function toolChipLabel(tool: WebToolActivity): string {
  const bare = tool.name.split("/").pop() ?? tool.name;
  const words = bare.replace(/[_.-]+/g, " ").trim();
  if (words.length === 0) return tool.name;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Whether a chip is drawn as a failure.
 *
 * A tool call the model recovered from is not a failure the User has anything
 * to do with: a refused call followed by a Turn that went on to finish is the
 * Bot correcting itself, and colouring it red reports a broken Turn that
 * worked. Only a Turn that itself ended badly keeps the failed state.
 */
function toolChipState(
  tool: WebToolActivity,
  message: WebChatMessage,
): "running" | "completed" | "failed" | "retried" {
  if (tool.status !== "failed") return tool.status;
  return message.status === "completed" || message.status === "streaming"
    ? "retried"
    : "failed";
}

/** What a chip says a tool is doing. Its status, in the User's words. */
function toolChipStatus(
  tool: WebToolActivity,
  message: WebChatMessage,
): string {
  const state = toolChipState(tool, message);
  if (state === "running") return "running";
  if (state === "retried") return "retried";
  return state === "failed" ? "failed" : "done";
}

/** Which tool chips the User has opened. Local, and per chip. */
const expandedTools = ref(new Set<string>());

function toggleTool(toolId: string): void {
  const next = new Set(expandedTools.value);
  if (!next.delete(toolId)) next.add(toolId);
  expandedTools.value = next;
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
 * happened. A line with no timestamp is treated as arriving now, so an
 * incomplete projection can never jump above the durable history.
 */
const messages = computed(() => {
  const missingAt = new Date().toISOString();
  return state.value.messages
    .filter(isVisible)
    .map((message, index) => ({ message, index }))
    .sort(
      (left, right) =>
        (left.message.at ?? missingAt).localeCompare(
          right.message.at ?? missingAt,
        ) || left.index - right.index,
    )
    .map((entry) => entry.message);
});

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
  void scrollToLatest("auto");
  void nextTick(syncComposerHeight);
  applySettingsDeepLink();
  window.addEventListener("popstate", applySettingsDeepLink);
  window.addEventListener("hashchange", applySettingsDeepLink);
  phoneLayoutMedia?.addEventListener("change", onPhoneLayoutChange);
  window.addEventListener("keydown", onRootKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener("popstate", applySettingsDeepLink);
  window.removeEventListener("hashchange", applySettingsDeepLink);
  phoneLayoutMedia?.removeEventListener("change", onPhoneLayoutChange);
  window.removeEventListener("keydown", onRootKeydown);
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
    // Choosing a Bot is what the drawer is for, so it closes behind the choice
    // rather than covering the conversation it just opened.
    closeNav();
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
        </header>

        <section
          ref="thread"
          class="thread"
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
              <!--
                Everything the Turn produced stacks in one column beside the
                avatar. The row holds exactly two children — avatar, column —
                so a bubble, a notice and a chip are stacked lines rather than
                side-by-side columns squeezing the reply to a few pixels.
              -->
              <div class="message-column">
                <div v-if="message.text" class="message-bubble">
                  <UiMarkdown :text="message.text" />
                </div>
                <!--
                Why the Turn ends where it does, under whatever it had already
                said rather than in place of it.
              -->
                <p v-if="message.notice" class="message-notice">
                  {{ message.notice }}
                </p>
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
                What the Bot did, while it is doing it. The chip is the
                conversation's whole account of an ordinary tool call: its
                name, whether it is running, and — when the User opens it —
                what it returned.
              -->
                <div
                  v-if="toolChipsOf(message).length > 0"
                  class="message-tools"
                >
                  <button
                    v-for="tool in toolChipsOf(message)"
                    :key="tool.id"
                    type="button"
                    class="tool-chip"
                    :class="`tool-chip-${toolChipState(tool, message)}`"
                    :aria-expanded="expandedTools.has(tool.id)"
                    @click="toggleTool(tool.id)"
                  >
                    <span class="tool-chip-name">{{
                      toolChipLabel(tool)
                    }}</span>
                    <span class="tool-chip-status">{{
                      toolChipStatus(tool, message)
                    }}</span>
                    <span
                      v-if="
                        expandedTools.has(tool.id) && tool.text !== undefined
                      "
                      class="tool-chip-result"
                      >{{ tool.text }}</span
                    >
                  </button>
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
              Try again
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
            @click="toggleRightPanel"
          >
            <UiIcon name="applets" size="sm" />
            <span class="applet-chip-name">Applet: {{ appletChip }}</span>
            <span class="applet-chip-action">Open</span>
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
          </div>
          <UiIconButton
            v-if="showStop"
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
                <header class="right-panel-header">
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
