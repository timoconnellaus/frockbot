// The Shell's Bot Durable Object contribution: the state every feature module
// takes, and the authority hook table that wires them into the kernel.
//
// Nothing is implemented here. Each hook is one line forwarding to the module
// that owns the answer, and the handful of methods below are the forwards the
// Durable Object and the recovery tests still reach through the object.

import { defineBotBackendContribution } from "@frockbot/core/contracts/contributions";
import type { SessionEvent } from "@frockbot/core/contracts";
import type { BotIdentity, OwnedBotTurnCommand } from "@frockbot/core/durable";
import { bootstrapCompositionGeneration } from "./backend-composition.js";
import type { BotSettingsViewV1 } from "@frockbot/core/configuration";
import {
  acknowledgeNotification,
  createFailureNotification,
  createNotification,
  listNotifications,
  supersededPackageRecords,
  terminalPackageRecords,
} from "@frockbot/app/notifications/bot";
import {
  deferScheduledWork,
  scheduledDeadlines,
  settleScheduledWork,
} from "@frockbot/app/routines/bot";
import {
  admittedBotSettingsV1,
  materializeBotSettingsV1,
  readBotSettingsV1,
} from "@frockbot/app/settings/bot";
import type { BotNotificationIntent } from "./backend-contracts.js";
import { ShellBotStateV1, type ShellBotBackendHost } from "./backend-state.js";
import { debugSnapshot } from "./debug.js";
import { type BotDebugSnapshotV1 } from "./debug-protocol.js";
import { validateIdentity } from "./identity.js";
import {
  announcementsFromSession,
  listConversations,
  listRunEventPage,
  listRuns,
  lookupRun,
  startConversation,
} from "./reads.js";
import type {
  ClientConversationListV1,
  ClientConversationOutcomeV1,
  ClientRunListV1,
  ClientRunLookupV1,
  ClientTurnV1,
} from "./run-protocol.js";
import {
  alarm,
  executeTurn,
  fenceRunAdmission,
  resolveAdmissionSnapshot,
  run,
} from "./turn.js";

export type { BotIdentity, OwnedBotTurnCommand };

export class ShellBotBackendContribution {
  readonly state: ShellBotStateV1;

  constructor(host: ShellBotBackendHost) {
    // The hook table is the wiring: each entry forwards to the feature module
    // that owns the answer, with this object's state as its first argument.
    this.state = new ShellBotStateV1(host, (state) => ({
      resolveAdmissionSnapshot: (command) =>
        resolveAdmissionSnapshot(state, command),
      bootstrapComposition: () =>
        Promise.resolve(
          bootstrapCompositionGeneration(new Date().toISOString()),
        ),
      admittedSnapshot: (transaction, resolved) =>
        admittedBotSettingsV1(transaction, resolved),
      executeTurn: (input) => executeTurn(state, input),
      notification: (snapshot, result) => createNotification(snapshot, result),
      failureNotification: (snapshot, failed) =>
        createFailureNotification(snapshot, failed),
      terminalRecords: (input) => terminalPackageRecords(input),
      supersededRecords: (input) => supersededPackageRecords(input),
      interruptTurn: (runId, reason) => state.turn.interrupt(runId, reason),
      scheduledDeadlines: (transaction) =>
        scheduledDeadlines(state, transaction),
      scheduledWorkInFlight: () => state.hostScheduled.inFlight?.() ?? false,
      deferScheduledWork: (transaction) =>
        deferScheduledWork(state, transaction),
      settleScheduledWork: () => settleScheduledWork(state),
    }));
  }

  /** @see materializeBotSettingsV1 — the Flock host mounts this Bot through it. */
  async materializeSettings(
    identity: BotIdentity,
    initial: { name: string; description?: string },
  ): Promise<BotSettingsViewV1> {
    return materializeBotSettingsV1(this.state, identity, initial);
  }

  async getSettings(identity: BotIdentity): Promise<BotSettingsViewV1> {
    return readBotSettingsV1(this.state, identity);
  }

  async listAnnouncements(): Promise<SessionEvent[]> {
    const sessionId = await this.state.authority.readConversationSessionId();
    const session = sessionId
      ? await this.state.authority.readSessionEvents(sessionId)
      : [];
    return announcementsFromSession(this.state, session);
  }

  async validateIdentity(identity: BotIdentity): Promise<void> {
    return validateIdentity(this.state, identity);
  }

  async run(command: OwnedBotTurnCommand): Promise<ClientTurnV1> {
    return run(this.state, command);
  }

  async alarm(): Promise<void> {
    return alarm(this.state);
  }

  async fenceRunAdmission(
    identity: BotIdentity,
    input: unknown,
  ): Promise<ClientRunLookupV1> {
    return fenceRunAdmission(this.state, identity, input);
  }

  async listNotifications(): Promise<BotNotificationIntent[]> {
    return listNotifications(this.state);
  }

  async acknowledgeNotification(notificationId: string): Promise<void> {
    return acknowledgeNotification(this.state, notificationId);
  }

  async listRuns(
    input: unknown = { schemaVersion: 1 },
  ): Promise<ClientRunListV1> {
    return listRuns(this.state, input);
  }

  async listConversations(): Promise<ClientConversationListV1> {
    return listConversations(this.state);
  }

  async startConversation(
    identity: BotIdentity,
  ): Promise<ClientConversationOutcomeV1> {
    return startConversation(this.state, identity);
  }

  async lookupRun(input: unknown): Promise<ClientRunLookupV1> {
    return lookupRun(this.state, input);
  }

  async listRunEventPage(cursor?: string): ReturnType<typeof listRunEventPage> {
    return listRunEventPage(this.state, cursor);
  }

  /** @see debugSnapshot in `debug.ts`. */
  async debugSnapshot(
    identity: BotIdentity,
    input: unknown = { schemaVersion: 1 },
  ): Promise<BotDebugSnapshotV1> {
    return debugSnapshot(
      this.state,
      identity,
      () => readBotSettingsV1(this.state, identity),
      input,
    );
  }
}

export function createShellBotBackendContribution(
  host: ShellBotBackendHost,
): ShellBotBackendContribution {
  return new ShellBotBackendContribution(host);
}

/**
 * What an application hands this Contribution: the conversation surface and the Bot's Composition, under the
 * Package's own key so one wide host object can satisfy every Package's slice
 * without their fields colliding.
 */
export interface ShellBotApplicationHostV1 {
  shell: ShellBotBackendHost;
}

/**
 * The manifest's `backend` entry, resolved by specifier. The
 * application looks this descriptor up in its Contribution table; it never
 * branches on which Package it belongs to.
 */
export const backendContribution = defineBotBackendContribution<
  ShellBotApplicationHostV1,
  ShellBotBackendContribution
>({
  specifier: "@frockbot/app/shell/backend",
  mount: (host, lifecycle) =>
    lifecycle.mount(createShellBotBackendContribution(host.shell)),
});
