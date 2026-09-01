// The Search Package's hosted client Contribution.
//
// It registers one surface on the shell's surface registry, one header
// control, and one keyboard shortcut. Everything it renders comes from
// `GET /api/search`, decoded at the seam; the client holds no index and
// assembles no deep link of its own.
import {
  clientSurfaceRegistryKey,
  type ClientPlugin,
} from "@frockbot/client-core";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { ref } from "vue";
import {
  decodeClientSearchRebuildReceiptV1,
  decodeClientSearchResultsV1,
  searchTurnAnchorV1,
  SEARCH_MAX_QUERY_LENGTH_V1,
} from "../shared.js";
import SearchBox from "./SearchBox.vue";
import SearchOverlay from "./SearchOverlay.vue";
import {
  searchKindsV1,
  searchWebDataKey,
  type SearchWebData,
} from "./state.js";
import "./styles.css";

export const SEARCH_SURFACE_ID = "search";

/**
 * How long the overlay waits for a deep-linked turn to render.
 *
 * A hit can name a Turn further back than the conversation's newest page, so
 * the anchor may never appear. Waiting a bounded moment and then leaving the
 * reader on the right Bot is the honest outcome; pretending to scroll is not.
 */
const ANCHOR_TIMEOUT_MS = 4_000;
const ANCHOR_POLL_MS = 100;

async function scrollToTurn(runId: string): Promise<boolean> {
  if (typeof document === "undefined") return false;
  const anchor = searchTurnAnchorV1(runId);
  const deadline = Date.now() + ANCHOR_TIMEOUT_MS;
  for (;;) {
    const element = document.getElementById(anchor);
    if (element) {
      element.scrollIntoView({ block: "center", behavior: "smooth" });
      return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, ANCHOR_POLL_MS));
  }
}

export const searchClientPlugin: ClientPlugin = (ctx) => {
  if (!ctx.transport.hostedRequest) {
    throw new Error("Search hosted transport is unavailable");
  }
  const request = ctx.transport.hostedRequest.bind(ctx.transport);
  const surfaces = ctx.inject(clientSurfaceRegistryKey);
  const shell = ctx.inject(frockBotWebDataKey);
  let queryGeneration = 0;

  const state = ref<SearchWebData>({
    query: "",
    loading: false,
    rebuilding: false,
    includeArchived: false,
    includeTools: false,
    indexState: "ready",
    setQuery(value) {
      state.value.query = value.slice(0, SEARCH_MAX_QUERY_LENGTH_V1);
    },
    setIncludeArchived(value) {
      state.value.includeArchived = value;
      void state.value.run();
    },
    setIncludeTools(value) {
      state.value.includeTools = value;
      void state.value.run();
    },
    async run() {
      const generation = ++queryGeneration;
      const query = state.value.query.trim();
      if (!query) {
        state.value.results = undefined;
        state.value.loading = false;
        state.value.error = undefined;
        return;
      }
      state.value.loading = true;
      state.value.error = undefined;
      try {
        const params = new URLSearchParams({ q: query });
        params.set("kinds", searchKindsV1(state.value.includeTools).join(","));
        if (state.value.includeArchived) params.set("includeArchived", "true");
        const results = decodeClientSearchResultsV1(
          await request(`/api/search?${params.toString()}`),
        );
        // A slower earlier query must never overwrite a newer answer.
        if (generation !== queryGeneration) return;
        state.value.results = results;
        state.value.indexState = results.indexState;
      } catch (error) {
        if (generation !== queryGeneration) return;
        state.value.error =
          error instanceof Error ? error.message : "Search failed";
      } finally {
        if (generation === queryGeneration) state.value.loading = false;
      }
    },
    async rebuild() {
      state.value.rebuilding = true;
      state.value.indexState = "rebuilding";
      state.value.error = undefined;
      try {
        const receipt = decodeClientSearchRebuildReceiptV1(
          await request("/api/search/rebuild", "POST", "{}"),
        );
        state.value.indexState = receipt.indexState;
        await state.value.run();
      } catch (error) {
        state.value.error =
          error instanceof Error ? error.message : "Rebuild failed";
      } finally {
        state.value.rebuilding = false;
      }
    },
    async openHit(botId, runId, deepLink) {
      surfaces.close();
      try {
        if (shell.value.activeBotId !== botId) {
          await shell.value.selectBot(botId);
        }
        // The link is the real URL the route handed back, so a reader can copy
        // it, and a reload lands on the same Bot and the same anchor.
        if (typeof window !== "undefined") {
          window.history.replaceState(
            window.history.state,
            "",
            new URL(deepLink, window.location.href),
          );
        }
        if (!(await scrollToTurn(runId))) {
          state.value.error =
            "That turn is further back than the loaded conversation; scroll up to reach it.";
        }
      } catch (error) {
        state.value.error =
          error instanceof Error ? error.message : "Could not open that turn";
      }
    },
    open() {
      surfaces.open(SEARCH_SURFACE_ID);
    },
    close() {
      surfaces.close();
    },
  });

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "k" && event.key !== "K") return;
    if (!event.metaKey && !event.ctrlKey) return;
    if (event.altKey) return;
    event.preventDefault();
    state.value.open();
  };
  if (typeof window !== "undefined") {
    window.addEventListener("keydown", onKeydown);
  }

  return [
    ctx.provide(searchWebDataKey, state),
    surfaces.register({
      id: SEARCH_SURFACE_ID,
      title: "Search",
      component: SearchOverlay,
    }),
    ctx.slot({
      slot: "frockbot.sidebar-top",
      order: 10,
      component: SearchBox,
    }),
    () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("keydown", onKeydown);
      }
    },
  ];
};

export default searchClientPlugin;
