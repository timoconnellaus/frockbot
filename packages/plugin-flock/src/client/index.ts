import type { ClientPlugin } from "@frockbot/client-core";
import type { FrockBotWebData } from "@frockbot/plugin-shell/shared";
import { ref, watch, type Ref } from "vue";
import {
  decodeBotLifecycleDirectoryViewV1,
  decodeBotIdentityDirectoryViewV1,
  decodeBotLifecycleReceiptV1,
  decodeCreateBotCommandV1,
  decodeDirectoryViewV1,
  decodeFlockReceiptV1,
  decodeSheepIdentityViewV1,
  decodeUpdateSheepCommandV1,
  randomSheepRecipeV1,
  type CreateBotCommandV1,
} from "../shared.js";
// Vue slot implementations remain owned by the hosted Flock Contribution.
import FlockSidebar from "./FlockSidebar.vue";
import FlockOverlay from "./FlockOverlay.vue";
import FlockIdentity from "./FlockIdentity.vue";
import FlockAvatar from "./FlockAvatar.vue";
import FlockAvatarEditor from "./FlockAvatarEditor.vue";
import FlockCreateButton from "./FlockCreateButton.vue";
import FlockDangerZone from "./FlockDangerZone.vue";
import {
  decodeBotNotificationDirectoryViewV1,
  decodeBotUnreadDirectoryViewV1,
  decodeBotUnreadReceiptV1,
} from "@frockbot/plugin-shell/unread";
import {
  isBotFocusedV1,
  readViewerFocusV1,
  shouldNotifyForBotV1,
  suppressUnreadWhileFocusedV1,
} from "@frockbot/plugin-shell/focus";
import { showClientNotificationV1 } from "@frockbot/plugin-shell/client/notify";
import {
  claimNotificationDeliveryV1,
  deliveredNotificationKeyV1,
  releaseNotificationDeliveryV1,
} from "./delivered-notifications.js";
import {
  clearPendingCreate,
  clearPendingSheep,
  isDefinitiveFlockFailure,
  readPendingCreate,
  readPendingSheep,
  writePendingCreate,
  writePendingSheep,
} from "./pending-create.js";
import { flockWebDataKey, type FlockWebData } from "./state.js";
import "../../assets/layers.css";
import "./styles.css";
import { defineClientContribution } from "@frockbot/kernel-contracts/contributions";
import {
  clientFailureDetailV1,
  presentClientFailureV1,
} from "@frockbot/client-core";

function slug(name: string): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "bot";
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

function replacePreferredBot(botId?: string): void {
  let url: URL;
  try {
    url = new URL(window.location.href);
  } catch {
    throw new Error("Hosted application URL is invalid");
  }
  if (botId) url.searchParams.set("bot", botId);
  else url.searchParams.delete("bot");
  window.history.replaceState(window.history.state, "", url);
}

/**
 * How often the sidebar re-reads the unread fan-out and the pending intents of
 * Bots nobody is looking at. A poll refreshes badges; it never clears one —
 * "read" is an authenticated command the User's own selection sends.
 */
const UNREAD_POLL_INTERVAL_MS = 15_000;

/**
 * Notification permission has to start inside a browser gesture. Bot creation
 * records notification intent regardless of the browser's answer, so this
 * progressive enhancement is deliberately fire-and-forget.
 */
function requestNotificationPermissionFromCreateGesture(): void {
  if (
    typeof window === "undefined" ||
    !("Notification" in window) ||
    Notification.permission !== "default"
  ) {
    return;
  }
  void Notification.requestPermission().catch(() => undefined);
}

export const flockClientPlugin: ClientPlugin = (ctx) => {
  if (!ctx.transport.hostedRequest)
    throw new Error("Flock hosted transport is unavailable");
  const request = ctx.transport.hostedRequest.bind(ctx.transport);
  let shell: Ref<FrockBotWebData> | undefined;
  /** Stops the watcher that keeps an edited Bot's sidebar row in step. */
  let stopNameWatch: (() => void) | undefined;
  /** Stops the watcher that refreshes the row on the transcript's own beat. */
  let stopTranscriptWatch: (() => void) | undefined;
  /** Stops the visibility/focus listeners that re-decide what is being read. */
  let stopFocusListeners: (() => void) | undefined;
  let authenticatedUserId: string | undefined;
  let loadGeneration = 0;
  let selectionGeneration = 0;
  /** Intents already shown by this page, so a poll cannot show one twice. */
  const deliveredNotifications = new Set<string>();
  /** The refresh currently in flight, so overlapping beats collapse into one. */
  let unreadRefresh: Promise<void> | undefined;
  /** A beat that arrived while one was in flight, replayed once it finishes. */
  let unreadRefreshQueued = false;
  /**
   * The last flock the unread read disagreed with, so one disagreement is one
   * reload and not a reload on every beat.
   */
  let reconciledFlockSignature: string | undefined;

  /**
   * One unread read at a time, with at most one more behind it.
   *
   * A Turn produces several beats — its line appears, it streams, it settles —
   * and each is a reason to re-read the row. Firing a request per beat would
   * make the sidebar noisier than the transcript it is following, and
   * out-of-order replies could put an older row back. Collapsing to one
   * in-flight read plus one pending replay keeps the last beat authoritative.
   * A failure is a refresh that did not happen: the poll tries again.
   */
  function refreshUnreadCoalesced(): Promise<void> {
    if (unreadRefresh) {
      unreadRefreshQueued = true;
      return unreadRefresh;
    }
    unreadRefresh = (async () => {
      try {
        await state.value.refreshUnread();
      } catch {
        // A refresh is never authority; the poll retries and nothing is lost.
      } finally {
        unreadRefresh = undefined;
      }
      if (unreadRefreshQueued) {
        unreadRefreshQueued = false;
        await refreshUnreadCoalesced();
      }
    })();
    return unreadRefresh;
  }

  async function requireAuthenticatedUserId(): Promise<string> {
    if (!ctx.transport.readAuthenticatedUserId)
      throw new Error("Authenticated User identity is unavailable");
    const userId = await ctx.transport.readAuthenticatedUserId();
    if (!userId) throw new Error("Authenticated User identity is unavailable");
    return userId;
  }
  const state = ref<FlockWebData>({
    directory: { schemaVersion: 1, revision: 0, bots: [] },
    identities: {},
    profiles: {},
    unread: {},
    lifecycles: {},
    showArchived: false,
    showHidden: false,
    loading: false,
    loaded: false,
    draftName: "",
    draftSheep: randomSheepRecipeV1(),
    bindShell(value) {
      shell = value;
      // A rename — or a pin — is saved on the Bot's own settings, and the
      // sidebar reads a directory it loaded once, so the row kept the old name
      // until the page was reloaded. The row follows the settings the Shell is
      // already holding rather than waiting for a second read of the directory.
      stopNameWatch?.();
      stopNameWatch = watch(
        () => {
          const profile = value.value.botSettings?.profile;
          return `${profile?.name ?? ""}\u0000${profile?.pinnedAt ?? ""}`;
        },
        () => {
          const settings = value.value.botSettings;
          const botId = settings?.botId;
          if (!botId || !settings?.profile.name) return;
          const profile = state.value.profiles[botId];
          if (!profile) return;
          const pinnedAt = settings.profile.pinnedAt;
          if (
            profile.name === settings.profile.name &&
            profile.pinnedAt === pinnedAt
          )
            return;
          // Unpinning removes the field rather than blanking it, so the
          // identity the sidebar reads keeps the shape its decoder produces.
          const { pinnedAt: _previous, ...rest } = profile;
          state.value.profiles = {
            ...state.value.profiles,
            [botId]: {
              ...rest,
              name: settings.profile.name,
              ...(pinnedAt === undefined ? {} : { pinnedAt }),
            },
          };
        },
      );
      // The row and the transcript are two renderings of the same Turn, so
      // they have to move together. The poll below is a floor — a Bot nobody
      // is looking at still gets its badge within a tick — but the open Bot's
      // own conversation already knows the instant a line lands or a Turn
      // settles, and a row that reads "No messages yet" over a reply the User
      // is looking at is the poll's latency made visible. The signal is
      // per-line, never per-token: the newest line's identity and status, the
      // number of lines, and whether a Turn is in flight.
      stopTranscriptWatch?.();
      stopTranscriptWatch = watch(
        () => {
          const web = value.value;
          // A host that has not projected a transcript yet — the first paint,
          // and every test double — contributes no beat rather than throwing.
          const messages = web.messages ?? [];
          const last = messages[messages.length - 1];
          return [
            web.activeBotId ?? "",
            web.activeRunId ?? "",
            messages.length,
            last?.id ?? "",
            last?.status ?? "",
          ].join(":");
        },
        () => {
          void refreshUnreadCoalesced();
        },
      );
      // Coming back to the window is the other moment the answer changes.
      // Nothing about the transcript moved — the Bot replied while the tab was
      // hidden, and both the badge and the notification were right to appear —
      // but the User is now looking at that very chat, so the badge has to go
      // without waiting for a poll. The same beat covers looking away: the row
      // the rule was suppressing becomes an honest badge again.
      if (typeof document !== "undefined" && !stopFocusListeners) {
        const refresh = (): void => {
          if (!state.value.directory.bots.length) return;
          void refreshUnreadCoalesced();
        };
        document.addEventListener("visibilitychange", refresh);
        window.addEventListener("focus", refresh);
        window.addEventListener("blur", refresh);
        stopFocusListeners = () => {
          document.removeEventListener("visibilitychange", refresh);
          window.removeEventListener("focus", refresh);
          window.removeEventListener("blur", refresh);
        };
      }
    },
    async load() {
      const generation = ++loadGeneration;
      state.value.loading = true;
      state.value.error = undefined;
      try {
        const userId = await requireAuthenticatedUserId();
        const [directory, lifecycleDirectory] = await Promise.all([
          request("/api/bots").then(decodeDirectoryViewV1),
          request("/api/bots/lifecycles").then(
            decodeBotLifecycleDirectoryViewV1,
          ),
        ]);
        if (generation !== loadGeneration) return;
        authenticatedUserId = userId;
        state.value.directory = directory;
        state.value.loaded = true;
        if (shell) shell.value.botsUnavailable = false;
        state.value.lifecycles = Object.fromEntries(
          lifecycleDirectory.lifecycles.map((item) => [
            item.botId,
            item.status,
          ]),
        );
        const pending = readPendingCreate(userId);
        if (pending) {
          if (directory.bots.some((bot) => bot.botId === pending.botId)) {
            clearPendingCreate(userId);
          } else {
            let receipt;
            try {
              receipt = decodeFlockReceiptV1(
                await request("/api/bots", "POST", JSON.stringify(pending)),
              );
            } catch (error) {
              if (isDefinitiveFlockFailure(error)) {
                clearPendingCreate(userId);
                throw error;
              }
            }
            if (receipt) {
              clearPendingCreate(userId);
              if (receipt.status === "rejected")
                throw new Error(receipt.failure ?? "Couldn't create the Bot.");
            }
            state.value.directory = decodeDirectoryViewV1(
              await request("/api/bots"),
            );
            if (
              state.value.directory.bots.some(
                (bot) => bot.botId === pending.botId,
              )
            )
              clearPendingCreate(userId);
          }
        }
        const identities = await Promise.all(
          state.value.directory.bots.map(
            async (bot) =>
              [
                bot.botId,
                decodeSheepIdentityViewV1(
                  await request(
                    `/api/bots/${encodeURIComponent(bot.botId)}/sheep`,
                  ),
                ),
              ] as const,
          ),
        );
        const profiles = decodeBotIdentityDirectoryViewV1(
          await request("/api/bots/identities"),
        );
        if (generation !== loadGeneration) return;
        state.value.identities = Object.fromEntries(identities);
        state.value.profiles = Object.fromEntries(
          profiles.identities.map((profile) => [profile.botId, profile]),
        );
        for (const [botId, identity] of identities) {
          const pendingSheep = readPendingSheep(userId, botId);
          if (
            pendingSheep &&
            identity.revision > pendingSheep.expectedRevision &&
            JSON.stringify(identity.sheep) ===
              JSON.stringify(pendingSheep.sheep)
          )
            clearPendingSheep(userId, botId);
        }
        try {
          await state.value.refreshUnread();
        } catch {
          // A badge that cannot be read never blocks the flock from loading.
        }
        if (generation !== loadGeneration) return;
        const preferred = new URL(window.location.href).searchParams.get("bot");
        const activeBots = state.value.directory.bots.filter(
          (bot) => state.value.lifecycles[bot.botId] !== "archived",
        );
        const preferredBot = preferred
          ? activeBots.find((bot) => bot.botId === preferred)
          : undefined;
        const selected = preferredBot?.botId ?? activeBots[0]?.botId;
        if (preferred && !preferredBot) replacePreferredBot(selected);
        if (selected && shell) await state.value.select(selected);
        // Only a User with no Bots at all is asked to make one. Archiving your
        // last Bot leaves you with an archived list to restore from, and a
        // dialog opening over it puts its backdrop between you and Restore.
        else if (!selected && state.value.directory.bots.length === 0)
          state.value.openCreate();
      } catch (error) {
        // The list already on screen is the last thing known to be true, so a
        // failed refresh leaves it alone and says so instead. A transport
        // failure that emptied the sidebar would read as data loss.
        state.value.error = presentClientFailureV1(error, "load your Bots");
        console.debug("flock load failed", clientFailureDetailV1(error));
        // Tell the workspace the list is unknown, so it stops offering the
        // first-run empty state to a User who may already have Bots.
        if (shell && !state.value.loaded) shell.value.botsUnavailable = true;
      } finally {
        if (generation === loadGeneration) state.value.loading = false;
      }
    },
    async refreshUnread() {
      const directory = decodeBotUnreadDirectoryViewV1(
        await request("/api/bots/unread"),
      );
      // The unread read fans out over the whole non-archived flock, so it is
      // also this tab's cheapest view of which Bots still exist. A Bot deleted
      // or created from another tab or the phone leaves this tab's list
      // stale, and a stale list can keep the conversation open on a Bot the
      // server no longer has — every read of it answers 404 and the person
      // cannot chat (2026-09-05: a day-old tab on a deleted Bob). A flock
      // that differs from the list on screen is read again, which also moves
      // the selection off a Bot that is gone. One disagreement is one reload.
      if (state.value.loaded) {
        const known = new Set(
          state.value.directory.bots
            .map((bot) => bot.botId)
            .filter((botId) => state.value.lifecycles[botId] !== "archived"),
        );
        const seen = new Set(directory.unread.map((view) => view.botId));
        const differs =
          known.size !== seen.size ||
          [...seen].some((botId) => !known.has(botId));
        const signature = [...seen].sort().join("\n");
        if (differs && signature !== reconciledFlockSignature) {
          reconciledFlockSignature = signature;
          await state.value.load();
          return;
        }
        if (!differs) reconciledFlockSignature = undefined;
      }
      // A Turn that settles in the conversation the User is looking at has
      // been read by the time it arrives, so the badge that counted it is
      // wrong the instant it appears — and painting it for the beat before the
      // receipt lands is exactly the flicker the rule forbids. The row for a
      // focused Bot therefore renders no count at all, whatever the fan-out
      // says. Every other Bot's badge is left exactly as it came.
      const focus = readViewerFocusV1(shell?.value.activeBotId);
      state.value.unread = Object.fromEntries(
        directory.unread.map((view) => [
          view.botId,
          isBotFocusedV1(focus, view.botId)
            ? suppressUnreadWhileFocusedV1(view)
            : view,
        ]),
      );
      // Suppression is what the row shows; the read receipt is what makes it
      // stay shown — on the next reload, and in the other tab. It is still the
      // explicit authenticated command, never a side effect of the read.
      const openBotId = focus.activeBotId;
      if (
        openBotId &&
        isBotFocusedV1(focus, openBotId) &&
        (directory.unread.find((view) => view.botId === openBotId)?.count ??
          0) > 0 &&
        !state.value.unread[openBotId]?.manuallyUnread
      ) {
        try {
          await state.value.markRead(openBotId);
        } catch {
          // The badge stays until the next poll; nothing durable is lost.
        }
      }
    },
    async markRead(botId) {
      let cursor = state.value.unread[botId]?.lastActivityCursor;
      // Only when this page has never seen the Bot's row at all. A row that is
      // present without a cursor is a Bot nothing has ever settled on — a Bot
      // just created, most often — and asking again would put a round trip in
      // front of every first open to learn what it already knows.
      if (!cursor && !state.value.unread[botId]) {
        // Opening a chat has to clear its badge even when this page has not
        // read the fan-out yet: the first click after a reload. One read names
        // the cursor; without it the badge sat there until the next poll.
        try {
          const directory = decodeBotUnreadDirectoryViewV1(
            await request("/api/bots/unread"),
          );
          for (const view of directory.unread) {
            state.value.unread[view.botId] ??= view;
            if (view.botId === botId) cursor = view.lastActivityCursor;
          }
        } catch {
          // Fall through: with no cursor there is nothing to read up to.
        }
      }
      // Nothing has ever settled on this Bot: there is no cursor to read up to.
      if (!cursor) return;
      const receipt = decodeBotUnreadReceiptV1(
        await request(
          `/api/bots/${encodeURIComponent(botId)}/unread`,
          "POST",
          JSON.stringify({
            schemaVersion: 1,
            type: "bot/mark-read",
            commandId: crypto.randomUUID(),
            botId,
            upToCursor: cursor,
          }),
        ),
      );
      state.value.unread[botId] = receipt.unread;
    },
    async markUnread(botId) {
      const receipt = decodeBotUnreadReceiptV1(
        await request(
          `/api/bots/${encodeURIComponent(botId)}/unread`,
          "POST",
          JSON.stringify({
            schemaVersion: 1,
            type: "bot/mark-unread",
            commandId: crypto.randomUUID(),
            botId,
          }),
        ),
      );
      state.value.unread[botId] = receipt.unread;
    },
    async select(botId) {
      const generation = ++selectionGeneration;
      if (!state.value.directory.bots.some((bot) => bot.botId === botId))
        throw new Error("Bot is not registered");
      if (state.value.lifecycles[botId] === "archived")
        throw new Error("Bot is archived");
      if (!state.value.identities[botId]) {
        const identity = decodeSheepIdentityViewV1(
          await request(`/api/bots/${encodeURIComponent(botId)}/sheep`),
        );
        if (generation !== selectionGeneration) return;
        state.value.identities[botId] = identity;
      }
      if (generation !== selectionGeneration) return;
      if (!shell) throw new Error("Shell selection is unavailable");
      await shell.value.selectBot(botId);
      // Selecting a thread while looking at it is what "read" means, and it
      // is the whole of "opening a chat clears its badge". Focus is not
      // required — opening is the User's own act, and a window that has just
      // been clicked may not report focus yet — but a visible tab is: a page
      // restoring `?bot=` in a background tab has not been read.
      if (generation === selectionGeneration && readViewerFocusV1().visible) {
        // The row clears now rather than on the next poll, so the badge never
        // outlives the click. The receipt below is what makes it durable.
        const view = state.value.unread[botId];
        if (view)
          state.value.unread[botId] = suppressUnreadWhileFocusedV1(view);
        try {
          await state.value.markRead(botId);
        } catch {
          // The badge stays until the next selection; nothing durable is lost.
        }
      }
    },
    openCreate() {
      const pending = authenticatedUserId
        ? readPendingCreate(authenticatedUserId)
        : undefined;
      state.value.draftName = pending?.name ?? "";
      state.value.draftSheep = pending?.sheep
        ? structuredClone(pending.sheep)
        : randomSheepRecipeV1();
      state.value.overlay = "create";
      state.value.error = undefined;
    },
    toggleHidden() {
      state.value.showHidden = !state.value.showHidden;
    },
    toggleArchived() {
      state.value.showArchived = !state.value.showArchived;
    },
    openArchive(botId) {
      if (state.value.lifecycles[botId] === "archived") return;
      state.value.lifecyclePending = botId;
      state.value.overlay = "archive";
      state.value.error = undefined;
    },
    async archive() {
      const botId = state.value.lifecyclePending;
      if (!botId) return;
      try {
        const receipt = decodeBotLifecycleReceiptV1(
          await request(
            `/api/bots/${encodeURIComponent(botId)}/lifecycle`,
            "POST",
            JSON.stringify({
              schemaVersion: 1,
              type: "bot/archive",
              commandId: crypto.randomUUID(),
              botId,
            }),
          ),
        );
        if (receipt.status === "rejected")
          throw new Error(receipt.failure ?? "Couldn't archive this Bot.");
        if (receipt.status === "pending") {
          state.value.error = "Still archiving — this will finish shortly.";
          return;
        }
        state.value.overlay = undefined;
        state.value.lifecyclePending = undefined;
        // An archived Bot's transcript is no longer something to open
        // instantly: the next time it is read it is read from the Bot.
        shell?.value.transcripts.forget(botId);
        await state.value.load();
      } catch (error) {
        state.value.error = presentClientFailureV1(error, "archive this Bot");
        console.debug("bot archive failed", clientFailureDetailV1(error));
      }
    },
    openDelete(botId) {
      if (!state.value.directory.bots.some((bot) => bot.botId === botId))
        return;
      state.value.lifecyclePending = botId;
      state.value.overlay = "delete";
      state.value.error = undefined;
    },
    async deleteBot() {
      const botId = state.value.lifecyclePending;
      if (!botId) return;
      try {
        const receipt = decodeBotLifecycleReceiptV1(
          await request(
            `/api/bots/${encodeURIComponent(botId)}/lifecycle`,
            "POST",
            JSON.stringify({
              schemaVersion: 1,
              type: "bot/delete",
              commandId: crypto.randomUUID(),
              botId,
            }),
          ),
        );
        if (receipt.status === "rejected")
          throw new Error(receipt.failure ?? "Couldn't delete this Bot.");
        if (receipt.status === "pending") {
          state.value.error = "Still deleting — this will finish shortly.";
          return;
        }
        state.value.overlay = undefined;
        state.value.lifecyclePending = undefined;
        // An archived Bot's cached transcript is merely stale; a deleted one's
        // is a lie, and there is no Bot left to read it from again.
        shell?.value.transcripts.forget(botId);
        // Move off the deleted Bot before anything else. Selecting aborts the
        // Shell's in-flight reads for it, and every one of those is now a 404
        // waiting to happen: the panels poll the Bot the User is looking at,
        // and that Bot has just stopped existing.
        const next = state.value.directory.bots.find(
          (bot) =>
            bot.botId !== botId &&
            state.value.lifecycles[bot.botId] !== "archived",
        );
        if (next && shell?.value.activeBotId === botId)
          await state.value.select(next.botId);
        // The Bot is gone from the directory, so the reload re-derives the
        // list, the selection and the `?bot=` parameter without a page reload.
        await state.value.load();
      } catch (error) {
        state.value.error = presentClientFailureV1(error, "delete this Bot");
        console.debug("bot delete failed", clientFailureDetailV1(error));
      }
    },
    async restore(botId) {
      try {
        const receipt = decodeBotLifecycleReceiptV1(
          await request(
            `/api/bots/${encodeURIComponent(botId)}/lifecycle`,
            "POST",
            JSON.stringify({
              schemaVersion: 1,
              type: "bot/restore",
              commandId: crypto.randomUUID(),
              botId,
            }),
          ),
        );
        if (receipt.status === "rejected")
          throw new Error(receipt.failure ?? "Couldn't restore this Bot.");
        if (receipt.status === "pending") {
          state.value.error = "Still restoring — this will finish shortly.";
          return;
        }
        shell?.value.transcripts.forget(botId);
        await state.value.load();
      } catch (error) {
        state.value.error = presentClientFailureV1(error, "restore this Bot");
        console.debug("bot restore failed", clientFailureDetailV1(error));
      }
    },
    async openEdit() {
      const botId = shell?.value.activeBotId;
      let identity = botId ? state.value.identities[botId] : undefined;
      if (!identity || !botId) return;
      const userId = await requireAuthenticatedUserId();
      authenticatedUserId = userId;
      const pending = readPendingSheep(userId, botId);
      let reconciliationFailure: string | undefined;
      if (pending) {
        try {
          const receipt = decodeFlockReceiptV1(
            await request(
              `/api/bots/${encodeURIComponent(botId)}/sheep`,
              "POST",
              JSON.stringify(pending),
            ),
          );
          clearPendingSheep(userId, botId);
          if (receipt.status === "rejected")
            reconciliationFailure =
              receipt.failure ?? "Couldn't save the sheep.";
        } catch (error) {
          if (!isDefinitiveFlockFailure(error)) {
            state.value.error =
              "Your last change to this sheep didn't save. Try again.";
            return;
          }
          clearPendingSheep(userId, botId);
          reconciliationFailure =
            error instanceof Error ? error.message : "Couldn't save the sheep.";
        }
        try {
          identity = decodeSheepIdentityViewV1(
            await request(`/api/bots/${encodeURIComponent(botId)}/sheep`),
          );
          state.value.identities[botId] = identity;
        } catch (error) {
          state.value.error = presentClientFailureV1(error, "load this sheep");
          console.debug("sheep refresh failed", clientFailureDetailV1(error));
          return;
        }
      }
      state.value.draftSheep = structuredClone(identity.sheep);
      state.value.overlay = "edit";
      state.value.error = reconciliationFailure;
    },
    closeOverlay() {
      state.value.overlay = undefined;
      state.value.lifecyclePending = undefined;
      state.value.error = undefined;
    },
    reroll() {
      state.value.draftSheep = randomSheepRecipeV1();
    },
    async create() {
      requestNotificationPermissionFromCreateGesture();
      try {
        const userId = await requireAuthenticatedUserId();
        authenticatedUserId = userId;
        const command =
          readPendingCreate(userId) ??
          decodeCreateBotCommandV1({
            schemaVersion: 1,
            type: "bot/create",
            commandId: crypto.randomUUID(),
            expectedRevision: state.value.directory.revision,
            botId: slug(state.value.draftName),
            name: state.value.draftName,
            sheep: state.value.draftSheep,
          } satisfies CreateBotCommandV1);
        writePendingCreate(userId, command);
        const receipt = decodeFlockReceiptV1(
          await request("/api/bots", "POST", JSON.stringify(command)),
        );
        if (receipt.status === "rejected") {
          clearPendingCreate(userId);
          throw new Error(receipt.failure ?? "Couldn't create the Bot.");
        }
        clearPendingCreate(userId);
        replacePreferredBot(command.botId);
        // The list first, the dialog last. Tearing the dialog down before the
        // reload landed showed the User the first-run empty state — "No Bots
        // yet. Add your first sheep." — for the Bot they had just added.
        await state.value.load();
        await state.value.select(command.botId);
        state.value.overlay = undefined;
      } catch (error) {
        if (isDefinitiveFlockFailure(error) && authenticatedUserId)
          clearPendingCreate(authenticatedUserId);
        state.value.error = presentClientFailureV1(error, "create the Bot");
        console.debug("bot creation failed", clientFailureDetailV1(error));
      }
    },
    async saveSheep() {
      const botId = shell?.value.activeBotId;
      if (!botId) return;
      const current = state.value.identities[botId];
      if (!current) return;
      try {
        const userId = await requireAuthenticatedUserId();
        authenticatedUserId = userId;
        const command =
          readPendingSheep(userId, botId) ??
          decodeUpdateSheepCommandV1({
            schemaVersion: 1,
            type: "bot/update-sheep",
            commandId: crypto.randomUUID(),
            expectedRevision: current.revision,
            botId,
            sheep: state.value.draftSheep,
          });
        writePendingSheep(userId, command);
        const receipt = decodeFlockReceiptV1(
          await request(
            `/api/bots/${encodeURIComponent(botId)}/sheep`,
            "POST",
            JSON.stringify(command),
          ),
        );
        if (receipt.status === "rejected") {
          clearPendingSheep(userId, botId);
          throw new Error(receipt.failure ?? "Couldn't save the sheep.");
        }
        clearPendingSheep(userId, botId);
        state.value.identities[botId] = decodeSheepIdentityViewV1(
          await request(`/api/bots/${encodeURIComponent(botId)}/sheep`),
        );
        state.value.overlay = undefined;
      } catch (error) {
        if (authenticatedUserId) {
          if (isDefinitiveFlockFailure(error))
            clearPendingSheep(authenticatedUserId, botId);
          try {
            const refreshed = decodeSheepIdentityViewV1(
              await request(`/api/bots/${encodeURIComponent(botId)}/sheep`),
            );
            state.value.identities[botId] = refreshed;
            const pending = readPendingSheep(authenticatedUserId, botId);
            if (
              pending &&
              refreshed.revision > pending.expectedRevision &&
              JSON.stringify(refreshed.sheep) === JSON.stringify(pending.sheep)
            ) {
              clearPendingSheep(authenticatedUserId, botId);
              state.value.overlay = undefined;
              return;
            }
          } catch {
            /* Keep the exact pending command when reconciliation is uncertain. */
          }
        }
        state.value.error = presentClientFailureV1(error, "save the sheep");
        console.debug("sheep save failed", clientFailureDetailV1(error));
      }
    },
  });
  /**
   * The fan-out half of the notification story: a Turn that settles on a Bot
   * the User is not looking at raises its intent here, through the same seam
   * the open Bot's intents use, and is acknowledged per Bot afterwards.
   */
  async function deliverBackgroundNotifications(): Promise<void> {
    const directory = decodeBotNotificationDirectoryViewV1(
      await request("/api/bots/notifications"),
    );
    const acknowledge = (intent: { botId: string; notificationId: string }) =>
      request(
        `/api/bots/${encodeURIComponent(intent.botId)}/notifications`,
        "POST",
        JSON.stringify({
          schemaVersion: 1,
          action: "acknowledge",
          notificationId: intent.notificationId,
        }),
      );
    const focus = readViewerFocusV1(shell?.value.activeBotId);
    for (const intent of directory.notifications) {
      // The open Bot's intents belong to the Shell: it projects the Turn into
      // the conversation, decides whether the tab was being looked at, and
      // acknowledges it there. Deciding again here would be a second answer to
      // the same question, and a second notification when they disagreed.
      if (intent.botId === focus.activeBotId) continue;
      // Every other Bot is out of focus by definition — the sentence this
      // implements — so the intent is one notification, once.
      if (!shouldNotifyForBotV1(focus, intent.botId)) continue;
      const key = deliveredNotificationKeyV1(
        intent.botId,
        intent.notificationId,
      );
      if (deliveredNotifications.has(key)) continue;
      // Claimed before it is shown, and claimed in storage every tab of this
      // browser shares: the acknowledgement that finally closes the intent
      // lands after the notification, and a second tab polling in that gap
      // used to speak the same message twice.
      if (!claimNotificationDeliveryV1(key)) {
        deliveredNotifications.add(key);
        continue;
      }
      deliveredNotifications.add(key);
      const delivery = await showClientNotificationV1({
        title: intent.title,
        body: intent.body,
      });
      if (delivery === "unavailable") {
        // Nothing was said, so nothing was spent: the intent stays pending and
        // is spoken once the User grants permission.
        deliveredNotifications.delete(key);
        releaseNotificationDeliveryV1(key);
        continue;
      }
      await acknowledge(intent);
    }
  }

  const poll = setInterval(() => {
    if (!state.value.directory.bots.length) return;
    void (async () => {
      try {
        await refreshUnreadCoalesced();
        await deliverBackgroundNotifications();
      } catch {
        // A poll is a refresh, not authority: the next tick tries again and
        // nothing the User did is lost by a failed one.
      }
    })();
  }, UNREAD_POLL_INTERVAL_MS);

  return [
    () => clearInterval(poll),
    () => stopNameWatch?.(),
    () => stopTranscriptWatch?.(),
    () => stopFocusListeners?.(),
    ctx.provide(flockWebDataKey, state),
    ctx.slot({
      slot: "frockbot.sidebar-bots",
      order: 10,
      component: FlockSidebar,
    }),
    ctx.slot({ slot: "frockbot.overlays", order: 10, component: FlockOverlay }),
    ctx.slot({
      slot: "frockbot.sidebar-top",
      order: 20,
      component: FlockCreateButton,
    }),
    ctx.slot({
      slot: "frockbot.bot-identity",
      order: 10,
      component: FlockIdentity,
    }),
    ctx.slot({
      slot: "frockbot.bot-avatar",
      order: 10,
      component: FlockAvatar,
    }),
    ctx.slot({
      slot: "frockbot.bot-avatar-editor",
      order: 10,
      component: FlockAvatarEditor,
    }),
    // Last on the Bot's settings screen, below every setting it could still
    // change: the one action that ends the Bot.
    ctx.slot({
      slot: "frockbot.bot-settings-primary-sections",
      order: 900,
      component: FlockDangerZone,
    }),
  ];
};
export default flockClientPlugin;

/**
 * The manifest's `client` entry, resolved by specifier. The application looks
 * this descriptor up in its Contribution table; it never branches on which
 * Package it belongs to.
 */
export const clientContribution = defineClientContribution<ClientPlugin>({
  specifier: "@frockbot/plugin-flock/client",
  plugin: flockClientPlugin,
});
