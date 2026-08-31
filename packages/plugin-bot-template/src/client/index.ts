/// <reference path="../env.d.ts" />

// The Bot Template hosted client Contribution.
//
// It mounts one section into `frockbot.bot-settings-sections`, the outlet the
// Settings Package already declares, so nothing in the settings surface has to
// know this Package exists. Every write is one `POST` of one versioned command
// with its own idempotency key, and every read is decoded at the seam before a
// component sees it: "The hosted client renders backend state and submits
// commands. It does not become an alternate authority."
import type { ClientPlugin } from "@frockbot/client-core";
import type { TemplateVisibilityV1 } from "@frockbot/template-core";
import { ref } from "vue";
import {
  decodeTemplateShareListViewV1,
  decodeTemplateShareReceiptV1,
} from "../shared.js";
import BotTemplateSection from "./BotTemplateSection.vue";
import { botTemplateStateKey, type BotTemplateClientState } from "./state.js";

const SHARES_PATH = "/api/bot-templates";

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export const botTemplateClientPlugin: ClientPlugin = (ctx) => {
  const request = (
    method?: "GET" | "POST",
    body?: string,
  ): Promise<unknown> => {
    if (!ctx.transport.hostedRequest) {
      throw new Error("Bot templates are unavailable on this client");
    }
    return ctx.transport.hostedRequest(SHARES_PATH, method, body);
  };

  const state = ref<BotTemplateClientState>({
    shares: [],
    loaded: false,
    busy: false,
    async load() {
      try {
        state.value.shares = decodeTemplateShareListViewV1(
          await request(),
        ).shares;
        state.value.loaded = true;
        state.value.error = undefined;
      } catch (error) {
        state.value.error = message(error, "Could not load template shares");
      }
    },
    async stage(botId: string) {
      state.value.busy = true;
      try {
        const receipt = decodeTemplateShareReceiptV1(
          await request(
            "POST",
            JSON.stringify({
              schemaVersion: 1,
              type: "template/stage",
              commandId: crypto.randomUUID(),
              botId,
            }),
          ),
        );
        state.value.summary = receipt.summary;
        state.value.openShareId = receipt.share.shareId;
        await state.value.load();
      } catch (error) {
        state.value.error = message(error, "Could not stage the template");
      } finally {
        state.value.busy = false;
      }
    },
    async setVisibility(shareId: string, visibility: TemplateVisibilityV1) {
      state.value.busy = true;
      try {
        decodeTemplateShareReceiptV1(
          await request(
            "POST",
            JSON.stringify({
              schemaVersion: 1,
              type: "template/set-visibility",
              commandId: crypto.randomUUID(),
              shareId,
              visibility,
            }),
          ),
        );
        await state.value.load();
      } catch (error) {
        state.value.error = message(error, "Could not change the visibility");
      } finally {
        state.value.busy = false;
      }
    },
    async revoke(shareId: string) {
      state.value.busy = true;
      try {
        decodeTemplateShareReceiptV1(
          await request(
            "POST",
            JSON.stringify({
              schemaVersion: 1,
              type: "template/revoke",
              commandId: crypto.randomUUID(),
              shareId,
            }),
          ),
        );
        await state.value.load();
      } catch (error) {
        state.value.error = message(error, "Could not revoke the share");
      } finally {
        state.value.busy = false;
      }
    },
  });

  return [
    ctx.provide(botTemplateStateKey, state),
    ctx.slot({
      slot: "frockbot.bot-settings-sections",
      order: 20,
      component: BotTemplateSection,
    }),
  ];
};

export default botTemplateClientPlugin;
