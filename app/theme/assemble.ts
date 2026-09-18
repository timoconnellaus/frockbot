// Silent `theme/assemble`: compile the named look, wrap it with any Plugin
// that declared the hook, persist the document, and tell the directory.
//
// Never called from a client `_select`. The paint path is the directory row;
// this writes the next row.

import type { BotIdentity } from "@frockbot/core/durable";
import {
  compileBotLookV1,
  decodeThemeDocumentV1,
  nextHourBoundaryV1,
  type AccountLookV1,
  type ThemeDocumentV1,
} from "@frockbot/core/theme";
import type { LoopEventPayloadMapV1 } from "@frockbot/core/contracts";
import type { FlockBotBackendContribution } from "@frockbot/app/flock/bot";
import type { BotLookV1, BotRegistrationV1, LookIdentityViewV1 } from "@frockbot/app/flock/shared";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import {
  readBotPluginRosterV1,
  withPluginWorkerV1,
  type BotPluginRosterV1,
} from "@frockbot/app/plugins/worker-bot";

/** When the next cadence assemble is owed. Absent means none. */
export const THEME_ASSEMBLE_DUE_KEY_V1 = "theme:assemble-due:v1";

/** How long one assemble may run inside the Plugin worker. */
export const THEME_ASSEMBLE_DEADLINE_MS_V1 = 10_000;

export function rosterDeclaresThemeAssembleV1(
  roster: BotPluginRosterV1,
): boolean {
  return roster.members.some(
    (member) =>
      roster.enabled.includes(member.packageId) &&
      member.descriptor.hooks.includes("theme/assemble"),
  );
}

export async function themeAssembleDeadlineV1(
  storage: {
    get<T>(key: string): Promise<T | undefined>;
  },
): Promise<number[]> {
  const due = await storage.get<unknown>(THEME_ASSEMBLE_DUE_KEY_V1);
  return typeof due === "number" && Number.isFinite(due) ? [due] : [];
}

export interface AssembleBotThemeHostV1 {
  flock: FlockBotBackendContribution;
  registration: BotRegistrationV1;
  appearance: AccountLookV1;
  timezone: string;
  now?: Date;
  /** Injected in tests; the Bot Durable Object mounts the worker. */
  roster?: BotPluginRosterV1;
  assemble?: (
    payload: LoopEventPayloadMapV1["theme/assemble"],
    original: ThemeDocumentV1,
  ) => Promise<ThemeDocumentV1>;
  mirror: (
    look: BotLookV1,
    document: ThemeDocumentV1 | undefined,
  ) => Promise<void>;
}

/**
 * Compiles this Bot's look, optionally wraps it, persists, and mirrors.
 *
 * A Plugin that throws or answers with a document the kernel refuses is
 * skipped; the last good document stays. No Plugin declaring the hook means
 * the stored document is dropped so the client compiles `look` locally —
 * Inherit + System can still follow the OS.
 */
export async function assembleBotThemeV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  host: AssembleBotThemeHostV1,
): Promise<LookIdentityViewV1> {
  const now = host.now ?? new Date();
  const timezone = host.timezone;
  const look = await host.flock.readLook(host.registration, identity.userId);
  const compiled = compileBotLookV1(look.look, host.appearance, true);
  const original = look.document ?? compiled;
  const roster = host.roster ?? (await readBotPluginRosterV1(state, identity));
  const declares = rosterDeclaresThemeAssembleV1(roster);
  let assembled = original;
  if (declares) {
    const payload: LoopEventPayloadMapV1["theme/assemble"] = {
      document: original,
      look: look.look,
      now: now.toISOString(),
      timezone,
    };
    if (host.assemble) {
      try {
        assembled = decodeThemeDocumentV1(
          await host.assemble(payload, original),
        );
      } catch {
        assembled = original;
      }
    } else {
      const outcome = await withPluginWorkerV1(
        state,
        identity,
        roster,
        {
          runId: `theme-assemble:${identity.botId}`,
          deadlineMs: THEME_ASSEMBLE_DEADLINE_MS_V1,
        },
        (worker) => worker.active.assembleTheme(payload, original),
      );
      if (outcome !== undefined && !("status" in outcome)) {
        try {
          assembled = decodeThemeDocumentV1(outcome);
        } catch {
          assembled = original;
        }
      }
    }
  }
  const document = declares ? assembled : undefined;
  const sameDocument =
    JSON.stringify(look.document) === JSON.stringify(document);
  const next = sameDocument
    ? look
    : await host.flock.persistAssembledDocument(
        host.registration,
        identity.userId,
        document,
      );
  await host.mirror(next.look, next.document);
  if (declares) {
    await state.ctx.storage.put(
      THEME_ASSEMBLE_DUE_KEY_V1,
      nextHourBoundaryV1(now, timezone),
    );
  } else {
    await state.ctx.storage.delete(THEME_ASSEMBLE_DUE_KEY_V1);
  }
  return next;
}
