/// <reference path="../env.d.ts" />

// The Routines hosted client Contribution.
//
// "The hosted client renders backend state and submits commands. It does not
// become an alternate authority." Every write here is one `POST` of one
// versioned command with its own idempotency key, and every read is decoded at
// the seam before a component sees it.
import type { ClientPlugin } from "@frockbot/client-core";
import { ref } from "vue";
import {
  decodeRoutineCommandReceiptV1,
  decodeRoutineInboxReceiptV1,
  decodeRoutineInboxViewV1,
  decodeRoutineListViewV1,
  decodeRoutineRunDetailViewV1,
  decodeRoutineRunListViewV1,
} from "../shared.js";
import RoutineInboxBadge from "./RoutineInboxBadge.vue";
import RoutinesSection from "./RoutinesSection.vue";
import RoutinesSummary from "./RoutinesSummary.vue";
import {
  routinesStateKey,
  type RoutineFormSubmissionV1,
  type RoutinesClientState,
} from "./state.js";
import { defineClientContribution } from "@frockbot/kernel-contracts/contributions";

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export const routinesClientPlugin: ClientPlugin = (ctx) => {
  const request = (
    path: string,
    method?: "GET" | "POST",
    body?: string,
  ): Promise<unknown> => {
    if (!ctx.transport.hostedRequest) {
      throw new Error("Routines are unavailable on this client");
    }
    return ctx.transport.hostedRequest(path, method, body);
  };
  const post = async (botId: string, command: unknown) => {
    const receipt = decodeRoutineCommandReceiptV1(
      await request(
        `/api/bots/${encodeURIComponent(botId)}/routines`,
        "POST",
        JSON.stringify(command),
      ),
    );
    // A minted key is on this receipt and on nothing else — no listing returns
    // it and no second request can. It is held only for as long as the section
    // is open.
    if (receipt.status === "applied" && receipt.hook) {
      state.value.mintedHook = receipt.hook;
    }
    return receipt;
  };
  const state = ref<RoutinesClientState>({
    routines: [],
    runs: {},
    runDetails: {},
    inbox: [],
    unacknowledged: 0,
    loaded: false,
    busy: false,
    async load(botId: string) {
      try {
        const view = decodeRoutineListViewV1(
          await request(`/api/bots/${encodeURIComponent(botId)}/routines`),
        );
        state.value.botId = botId;
        state.value.routines = view.routines;
        state.value.loaded = true;
        state.value.error = undefined;
      } catch (error) {
        state.value.error = message(error, "Could not load Routines");
      }
    },
    async loadRuns(botId: string, routineId: string) {
      try {
        const view = decodeRoutineRunListViewV1(
          await request(
            `/api/bots/${encodeURIComponent(botId)}/routines/${encodeURIComponent(routineId)}/runs`,
          ),
        );
        state.value.runs = { ...state.value.runs, [routineId]: view.entries };
        state.value.error = undefined;
      } catch (error) {
        state.value.error = message(error, "Could not load the run log");
      }
    },
    async loadRun(botId: string, routineId: string, runId: string) {
      try {
        const view = decodeRoutineRunDetailViewV1(
          await request(
            `/api/bots/${encodeURIComponent(botId)}/routines/${encodeURIComponent(routineId)}/runs/${encodeURIComponent(runId)}`,
          ),
        );
        state.value.runDetails = { ...state.value.runDetails, [runId]: view };
        state.value.error = undefined;
      } catch (error) {
        state.value.error = message(error, "Could not load the run");
      }
    },
    async loadInbox(botId: string) {
      try {
        const view = decodeRoutineInboxViewV1(
          await request(
            `/api/bots/${encodeURIComponent(botId)}/routines/inbox`,
          ),
        );
        state.value.inbox = view.entries;
        state.value.unacknowledged = view.unacknowledged;
        state.value.error = undefined;
      } catch (error) {
        state.value.error = message(error, "Could not load the inbox");
      }
    },
    async acknowledgeInbox(botId: string, entryIds: string[]) {
      state.value.busy = true;
      try {
        const receipt = decodeRoutineInboxReceiptV1(
          await request(
            `/api/bots/${encodeURIComponent(botId)}/routines/inbox`,
            "POST",
            JSON.stringify({
              schemaVersion: 1,
              commandId: crypto.randomUUID(),
              botId,
              type: "routine/acknowledge-inbox",
              entryIds,
            }),
          ),
        );
        state.value.inbox = receipt.inbox.entries;
        state.value.unacknowledged = receipt.inbox.unacknowledged;
        state.value.error = undefined;
      } catch (error) {
        state.value.error = message(error, "Could not acknowledge the inbox");
      } finally {
        state.value.busy = false;
      }
    },
    async save(botId: string, submission: RoutineFormSubmissionV1) {
      state.value.busy = true;
      try {
        await post(botId, {
          schemaVersion: 1,
          type: submission.routineId ? "routine/update" : "routine/create",
          commandId: crypto.randomUUID(),
          botId,
          ...(submission.routineId ? { routineId: submission.routineId } : {}),
          name: submission.name,
          prompt: submission.prompt,
          ...(submission.schedule === undefined
            ? {}
            : { schedule: submission.schedule }),
          ...(submission.trigger === undefined
            ? {}
            : { trigger: submission.trigger }),
          timezone: submission.timezone,
        });
        await state.value.load(botId);
      } catch (error) {
        state.value.error = message(error, "Could not save the Routine");
        throw error;
      } finally {
        state.value.busy = false;
      }
    },
    async setEnabled(botId: string, routineId: string, enabled: boolean) {
      state.value.busy = true;
      try {
        await post(botId, {
          schemaVersion: 1,
          type: enabled ? "routine/resume" : "routine/pause",
          commandId: crypto.randomUUID(),
          botId,
          routineId,
        });
        await state.value.load(botId);
      } catch (error) {
        state.value.error = message(error, "Could not change the Routine");
      } finally {
        state.value.busy = false;
      }
    },
    dismissHook() {
      state.value.mintedHook = undefined;
    },
    async rotateKey(botId: string, routineId: string) {
      state.value.busy = true;
      try {
        await post(botId, {
          schemaVersion: 1,
          type: "routine/rotate-key",
          commandId: crypto.randomUUID(),
          botId,
          routineId,
        });
        await state.value.load(botId);
      } catch (error) {
        state.value.error = message(error, "Could not mint a webhook key");
      } finally {
        state.value.busy = false;
      }
    },
    async revokeKey(botId: string, routineId: string) {
      state.value.busy = true;
      try {
        state.value.mintedHook = undefined;
        await post(botId, {
          schemaVersion: 1,
          type: "routine/revoke-key",
          commandId: crypto.randomUUID(),
          botId,
          routineId,
        });
        await state.value.load(botId);
      } catch (error) {
        state.value.error = message(error, "Could not revoke the webhook key");
      } finally {
        state.value.busy = false;
      }
    },
    async runNow(botId: string, routineId: string) {
      state.value.busy = true;
      try {
        await post(botId, {
          schemaVersion: 1,
          type: "routine/run",
          commandId: crypto.randomUUID(),
          botId,
          routineId,
        });
        await state.value.load(botId);
        await state.value.loadRuns(botId, routineId);
      } catch (error) {
        state.value.error = message(error, "Could not run the Routine");
      } finally {
        state.value.busy = false;
      }
    },
    async remove(botId: string, routineId: string) {
      state.value.busy = true;
      try {
        await post(botId, {
          schemaVersion: 1,
          type: "routine/delete",
          commandId: crypto.randomUUID(),
          botId,
          routineId,
        });
        await state.value.load(botId);
      } catch (error) {
        state.value.error = message(error, "Could not delete the Routine");
      } finally {
        state.value.busy = false;
      }
    },
  });

  return [
    ctx.provide(routinesStateKey, state),
    ctx.slot({
      slot: "frockbot.bot-settings-sections",
      order: 10,
      component: RoutinesSection,
    }),
    // The header is where a completion that never spoke becomes visible: an
    // automation Turn cannot reach the transcript, so the badge is the only
    // thing that says a firing finished.
    ctx.slot({
      slot: "frockbot.header-actions",
      order: 20,
      component: RoutineInboxBadge,
    }),
    // The default Bot panel gets the glance; the section above stays the place a
    // Routine is written.
    ctx.slot({
      slot: "frockbot.bot-panel-sections",
      order: 10,
      component: RoutinesSummary,
    }),
  ];
};

export default routinesClientPlugin;

/**
 * The manifest's `client` entry, resolved by specifier. The application looks
 * this descriptor up in its Contribution table; it never branches on which
 * Package it belongs to.
 */
export const clientContribution = defineClientContribution<ClientPlugin>({
  specifier: "@frockbot/plugin-routines/client",
  plugin: routinesClientPlugin,
});
