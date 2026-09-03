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
import {
  decodeBotNotificationDirectoryViewV1,
  decodeBotUnreadDirectoryViewV1,
  decodeBotUnreadReceiptV1,
} from "@frockbot/plugin-shell/unread";
import { showClientNotificationV1 } from "@frockbot/plugin-shell/client/notify";
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
  /** Stops the watcher that keeps a renamed Bot's sidebar row in step. */
  let stopNameWatch: (() => void) | undefined;
  let authenticatedUserId: string | undefined;
  let loadGeneration = 0;
  let selectionGeneration = 0;
  /** Intents already shown by this page, so a poll cannot show one twice. */
  const deliveredNotifications = new Set<string>();

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
    draftName: "",
    draftSheep: randomSheepRecipeV1(),
    bindShell(value) {
      shell = value;
      // A rename is saved on the Bot's own settings, and the sidebar reads a
      // directory it loaded once — so the row kept the old name until the page
      // was reloaded. The row follows the settings the Shell is already
      // holding rather than waiting for a second read of the directory.
      stopNameWatch?.();
      stopNameWatch = watch(
        () => value.value.botSettings?.profile.name,
        (name) => {
          const botId = value.value.botSettings?.botId;
          if (!botId || !name) return;
          const profile = state.value.profiles[botId];
          if (!profile || profile.name === name) return;
          state.value.profiles = {
            ...state.value.profiles,
            [botId]: { ...profile, name },
          };
        },
      );
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
        state.value.error =
          error instanceof Error ? error.message : "Could not load your flock";
      } finally {
        if (generation === loadGeneration) state.value.loading = false;
      }
    },
    async refreshUnread() {
      const directory = decodeBotUnreadDirectoryViewV1(
        await request("/api/bots/unread"),
      );
      state.value.unread = Object.fromEntries(
        directory.unread.map((view) => [view.botId, view]),
      );
      // A Turn that settles in the conversation the User is looking at has
      // been read by the time it arrives, so the badge that counted it is
      // wrong the instant it appears. Reading up to it is still the explicit
      // authenticated command; what the poll refreshed is only which cursor it
      // names. Every other Bot's badge is left exactly as the fan-out said.
      const openBotId = shell?.value.activeBotId;
      if (
        openBotId &&
        (state.value.unread[openBotId]?.count ?? 0) > 0 &&
        !state.value.unread[openBotId]?.manuallyUnread &&
        typeof document !== "undefined" &&
        document.visibilityState === "visible" &&
        document.hasFocus()
      ) {
        try {
          await state.value.markRead(openBotId);
        } catch {
          // The badge stays until the next poll; nothing durable is lost.
        }
      }
    },
    async markRead(botId) {
      const cursor = state.value.unread[botId]?.lastActivityCursor;
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
      // Selecting a thread while looking at it is what "read" means. A
      // background poll that refreshed the same runs must never do this.
      if (
        generation === selectionGeneration &&
        typeof document !== "undefined" &&
        document.visibilityState === "visible"
      ) {
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
        await state.value.load();
      } catch (error) {
        state.value.error =
          error instanceof Error ? error.message : "Could not archive Bot";
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
        await state.value.load();
      } catch (error) {
        state.value.error =
          error instanceof Error ? error.message : "Could not restore Bot";
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
          state.value.error =
            error instanceof Error
              ? error.message
              : "Couldn't finish saving your last change.";
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
        state.value.overlay = undefined;
        await state.value.load();
        await state.value.select(command.botId);
      } catch (error) {
        if (isDefinitiveFlockFailure(error) && authenticatedUserId)
          clearPendingCreate(authenticatedUserId);
        state.value.error =
          error instanceof Error ? error.message : "Could not create Bot";
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
        state.value.error =
          error instanceof Error ? error.message : "Could not save sheep";
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
    for (const intent of directory.notifications) {
      // The open Bot's intents belong to the Shell: it projects the Turn into
      // the conversation and acknowledges it there.
      if (intent.botId === shell?.value.activeBotId) continue;
      const key = `${intent.botId}:${intent.notificationId}`;
      if (deliveredNotifications.has(key)) {
        continue;
      }
      const delivery = await showClientNotificationV1({
        title: intent.title,
        body: intent.body,
      });
      if (delivery === "unavailable") continue;
      deliveredNotifications.add(key);
      await acknowledge(intent);
    }
  }

  const poll = setInterval(() => {
    if (!state.value.directory.bots.length) return;
    void (async () => {
      try {
        await state.value.refreshUnread();
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
