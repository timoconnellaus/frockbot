import { DurableObject } from "cloudflare:workers";
import type { SessionEvent } from "@frockbot/agent-core";
import type { StoredRun } from "./contracts.js";
import { appendedSessionEvents } from "./durable-session.js";

const RUN_PREFIX = "run:";
const ACTIVE_RUN_KEY = "active-run";
const LATEST_EVENTS_KEY = "latest-events";

export class BotState extends DurableObject<Record<string, never>> {
  async acceptRun(
    run: Omit<StoredRun, "events">,
  ): Promise<StoredRun["events"]> {
    const key = `${RUN_PREFIX}${run.runId}`;
    return this.ctx.storage.transaction(async (transaction) => {
      if (await transaction.get(key)) {
        throw new Error(`run "${run.runId}" already exists`);
      }
      if (await transaction.get(ACTIVE_RUN_KEY)) {
        throw new Error("bot already has an active run");
      }
      const latestEvents =
        (await transaction.get<StoredRun["events"]>(LATEST_EVENTS_KEY)) ?? [];
      await transaction.put({
        [key]: { ...run, events: [] } satisfies StoredRun,
        [ACTIVE_RUN_KEY]: run.runId,
      });
      return latestEvents;
    });
  }

  async completeRun(runId: string, events: SessionEvent[]): Promise<void> {
    const key = `${RUN_PREFIX}${runId}`;
    await this.ctx.storage.transaction(async (transaction) => {
      const [run, activeRunId, previousEvents] = await Promise.all([
        transaction.get<StoredRun>(key),
        transaction.get<string>(ACTIVE_RUN_KEY),
        transaction.get<StoredRun["events"]>(LATEST_EVENTS_KEY),
      ]);
      if (!run) throw new Error(`run "${runId}" was not accepted`);
      if (activeRunId !== runId) {
        throw new Error(`run "${runId}" is not active`);
      }
      const runEvents = appendedSessionEvents(previousEvents ?? [], events);
      await transaction.put({
        [key]: { ...run, events: runEvents },
        [LATEST_EVENTS_KEY]: events,
      });
      await transaction.delete(ACTIVE_RUN_KEY);
    });
  }

  async listRuns(): Promise<StoredRun[]> {
    const entries = await this.ctx.storage.list<StoredRun>({
      prefix: RUN_PREFIX,
    });
    return [...entries.values()].sort(
      (left, right) =>
        left.acceptedAt.localeCompare(right.acceptedAt) ||
        left.runId.localeCompare(right.runId),
    );
  }
}
