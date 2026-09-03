/// <reference path="../env.d.ts" />

// The Audit Package's hosted client Contribution.
//
// "The hosted client renders backend state and submits commands. It does not
// become an alternate authority." Every read here is decoded at the seam
// before a component sees it, and the one write is a rebuild — which changes
// no durable fact, only the projection of facts the Bots already hold.
import type { ClientPlugin } from "@frockbot/client-core";
import { ref } from "vue";
import {
  decodeAuditRebuildReceiptV1,
  decodeClientAuditPageV1,
} from "../shared.js";
import AuditSection from "./AuditSection.vue";
import { auditStateKey, type AuditClientState } from "./state.js";
import { defineClientContribution } from "@frockbot/kernel-contracts/contributions";

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function queryString(
  botId: string,
  state: AuditClientState,
  cursor?: string,
): string {
  const params = new URLSearchParams({ botId });
  if (state.filters.kind) params.set("kind", state.filters.kind);
  if (state.filters.target) params.set("target", state.filters.target);
  if (cursor) params.set("before", cursor);
  return params.toString();
}

export const auditClientPlugin: ClientPlugin = (ctx) => {
  const request = (
    path: string,
    method?: "GET" | "POST",
    body?: string,
  ): Promise<unknown> => {
    if (!ctx.transport.hostedRequest) {
      throw new Error("Audit log is unavailable on this client");
    }
    return ctx.transport.hostedRequest(path, method, body);
  };
  const state = ref<AuditClientState>({
    entries: [],
    total: 0,
    indexState: "ready",
    filters: {},
    loaded: false,
    busy: false,
    async load(botId, filters) {
      state.value.busy = true;
      if (filters) state.value.filters = filters;
      try {
        const page = decodeClientAuditPageV1(
          await request(`/api/audit?${queryString(botId, state.value)}`),
        );
        state.value.botId = botId;
        state.value.entries = page.entries;
        state.value.total = page.total;
        state.value.nextCursor = page.page.nextCursor;
        state.value.indexState = page.indexState;
        state.value.loaded = true;
        state.value.error = undefined;
      } catch (error) {
        state.value.error = message(error, "Could not load audit log");
      } finally {
        state.value.busy = false;
      }
    },
    async loadMore(botId) {
      const cursor = state.value.nextCursor;
      if (!cursor) return;
      state.value.busy = true;
      try {
        const page = decodeClientAuditPageV1(
          await request(
            `/api/audit?${queryString(botId, state.value, cursor)}`,
          ),
        );
        state.value.entries = [...state.value.entries, ...page.entries];
        state.value.nextCursor = page.page.nextCursor;
        state.value.indexState = page.indexState;
        state.value.error = undefined;
      } catch (error) {
        state.value.error = message(error, "Could not load more audit entries");
      } finally {
        state.value.busy = false;
      }
    },
    async rebuild(botId) {
      state.value.busy = true;
      try {
        // The receipt is the point of the button, not a side effect of it: it
        // says how many entries the Bots' own runs actually account for, how
        // many outcomes the durable log cannot explain, and how many effects
        // the Computer host claims that no session event does.
        state.value.receipt = decodeAuditRebuildReceiptV1(
          await request("/api/audit/rebuild", "POST", JSON.stringify({})),
        );
        state.value.error = undefined;
      } catch (error) {
        state.value.error = message(error, "Could not rebuild audit log");
      } finally {
        state.value.busy = false;
      }
      await state.value.load(botId);
    },
    dismissReceipt() {
      state.value.receipt = undefined;
    },
  });

  return [
    ctx.provide(auditStateKey, state),
    ctx.slot({
      slot: "frockbot.bot-settings-sections",
      order: 20,
      component: AuditSection,
    }),
  ];
};

export default auditClientPlugin;

/**
 * The manifest's `client` entry, resolved by specifier. The application looks
 * this descriptor up in its Contribution table; it never branches on which
 * Package it belongs to.
 */
export const clientContribution = defineClientContribution<ClientPlugin>({
  specifier: "@frockbot/plugin-audit/client",
  plugin: auditClientPlugin,
});
