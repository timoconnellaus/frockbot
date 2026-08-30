import type { ClientPlugin } from "@frockbot/client-core";
import type { FrockBotWebData } from "@frockbot/plugin-shell/shared";
import { ref, type Ref } from "vue";
import {
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

function replacePreferredBot(botId: string): void {
  let url: URL;
  try {
    url = new URL(window.location.href);
  } catch {
    throw new Error("Hosted application URL is invalid");
  }
  url.searchParams.set("bot", botId);
  window.history.replaceState(window.history.state, "", url);
}

export const flockClientPlugin: ClientPlugin = (ctx) => {
  if (!ctx.transport.hostedRequest)
    throw new Error("Flock hosted transport is unavailable");
  const request = ctx.transport.hostedRequest.bind(ctx.transport);
  let shell: Ref<FrockBotWebData> | undefined;
  let authenticatedUserId: string | undefined;
  let loadGeneration = 0;
  let selectionGeneration = 0;

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
    loading: false,
    draftName: "",
    draftSheep: randomSheepRecipeV1(),
    bindShell(value) {
      shell = value;
    },
    async load() {
      const generation = ++loadGeneration;
      state.value.loading = true;
      state.value.error = undefined;
      try {
        const userId = await requireAuthenticatedUserId();
        const directory = decodeDirectoryViewV1(await request("/api/bots"));
        if (generation !== loadGeneration) return;
        authenticatedUserId = userId;
        state.value.directory = directory;
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
                throw new Error(
                  receipt.failure ?? "Pending Bot creation was rejected",
                );
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
        if (generation !== loadGeneration) return;
        state.value.identities = Object.fromEntries(identities);
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
        const preferred = new URL(window.location.href).searchParams.get("bot");
        const preferredBot = preferred
          ? state.value.directory.bots.find((bot) => bot.botId === preferred)
          : undefined;
        if (preferred && !preferredBot) {
          state.value.openCreate();
          return;
        }
        const selected =
          preferredBot?.botId ?? state.value.directory.bots[0]?.botId;
        if (selected && shell) await state.value.select(selected);
        else if (!selected) state.value.openCreate();
      } catch (error) {
        state.value.error =
          error instanceof Error ? error.message : "Could not load your flock";
      } finally {
        if (generation === loadGeneration) state.value.loading = false;
      }
    },
    async select(botId) {
      const generation = ++selectionGeneration;
      if (!state.value.directory.bots.some((bot) => bot.botId === botId))
        throw new Error("Bot is not registered");
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
              receipt.failure ?? "Pending sheep update was rejected";
        } catch (error) {
          if (!isDefinitiveFlockFailure(error)) {
            state.value.error =
              "A previous sheep update could not be reconciled. Try again before editing.";
            return;
          }
          clearPendingSheep(userId, botId);
          reconciliationFailure =
            error instanceof Error
              ? error.message
              : "Pending sheep update was rejected";
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
              : "Could not reconcile the previous sheep update";
          return;
        }
      }
      state.value.draftSheep = structuredClone(identity.sheep);
      state.value.overlay = "edit";
      state.value.error = reconciliationFailure;
    },
    closeOverlay() {
      state.value.overlay = undefined;
      state.value.error = undefined;
    },
    reroll() {
      state.value.draftSheep = randomSheepRecipeV1();
    },
    async create() {
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
          throw new Error(receipt.failure ?? "Bot creation was rejected");
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
          throw new Error(receipt.failure ?? "Sheep update was rejected");
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
  return [
    ctx.provide(flockWebDataKey, state),
    ctx.slot({
      slot: "frockbot.sidebar-bots",
      order: 10,
      component: FlockSidebar,
    }),
    ctx.slot({ slot: "frockbot.overlays", order: 10, component: FlockOverlay }),
    ctx.slot({
      slot: "frockbot.bot-identity",
      order: 10,
      component: FlockIdentity,
    }),
  ];
};
export default flockClientPlugin;
