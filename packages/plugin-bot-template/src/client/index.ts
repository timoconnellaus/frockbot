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
  decodeTemplateImportListViewV1,
  decodeTemplateImportRecordV1,
  decodeTemplateShareListViewV1,
  decodeTemplateShareReceiptV1,
} from "../shared.js";
import BotTemplateImportSection from "./BotTemplateImportSection.vue";
import BotTemplateSection from "./BotTemplateSection.vue";
import { botTemplateStateKey, type BotTemplateClientState } from "./state.js";

const SHARES_PATH = "/api/bot-templates";
const IMPORTS_PATH = "/api/bot-template-imports";

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export const botTemplateClientPlugin: ClientPlugin = (ctx) => {
  const call = (
    path: string,
    method?: "GET" | "POST",
    body?: string,
  ): Promise<unknown> => {
    if (!ctx.transport.hostedRequest) {
      throw new Error("Bot templates are unavailable on this client");
    }
    return ctx.transport.hostedRequest(path, method, body);
  };
  const request = (method?: "GET" | "POST", body?: string): Promise<unknown> =>
    call(SHARES_PATH, method, body);

  const state = ref<BotTemplateClientState>({
    shares: [],
    imports: [],
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
    async loadImports() {
      try {
        state.value.imports = decodeTemplateImportListViewV1(
          await call(IMPORTS_PATH),
        ).imports;
        state.value.importError = undefined;
      } catch (error) {
        state.value.importError = message(error, "Could not load imports");
      }
    },
    async planImport(shareId: string) {
      state.value.busy = true;
      try {
        // Planning is a read. It opens the review card and applies nothing:
        // only `applyImport` below writes, and only the User calls it.
        const record = decodeTemplateImportRecordV1(
          await call(
            IMPORTS_PATH,
            "POST",
            JSON.stringify({
              schemaVersion: 1,
              type: "template/plan-import",
              commandId: crypto.randomUUID(),
              shareId,
            }),
          ),
        );
        state.value.reviewing = record;
        state.value.importError = undefined;
        await state.value.loadImports();
      } catch (error) {
        state.value.importError = message(
          error,
          "Could not read that template",
        );
      } finally {
        state.value.busy = false;
      }
    },
    async applyImport(importId: string) {
      state.value.busy = true;
      try {
        const record = decodeTemplateImportRecordV1(
          await call(
            IMPORTS_PATH,
            "POST",
            JSON.stringify({
              schemaVersion: 1,
              type: "template/apply-import",
              commandId: crypto.randomUUID(),
              importId,
            }),
          ),
        );
        state.value.reviewing = record;
        state.value.importError = undefined;
        await state.value.loadImports();
      } catch (error) {
        state.value.importError = message(error, "Could not import the Bot");
      } finally {
        state.value.busy = false;
      }
    },
    dismissReview() {
      state.value.reviewing = undefined;
    },
  });

  return [
    ctx.provide(botTemplateStateKey, state),
    ctx.slot({
      slot: "frockbot.bot-settings-sections",
      order: 20,
      component: BotTemplateSection,
    }),
    ctx.slot({
      slot: "frockbot.bot-settings-sections",
      order: 21,
      component: BotTemplateImportSection,
    }),
  ];
};

export default botTemplateClientPlugin;
