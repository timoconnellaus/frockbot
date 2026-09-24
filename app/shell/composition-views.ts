// The redacted hosted-client projection of the Bot's durable Composition
// generations. The durable record is kernel authority; what a User may see of
// it is Shell Package policy, so the projection lives here and never lets
// artifact bytes, manifest hashes, or loader identities cross the seam.
import {
  decodeCompositionCommandReceiptV1,
  decodeCompositionGenerationViewV1,
  MAX_COMPOSITION_FAILURE_PAGE_V1,
  MAX_COMPOSITION_GENERATION_PAGE_V1,
  type CompositionCommandReceiptV1,
  type CompositionGenerationListViewV1,
  type CompositionGenerationViewV1,
  type CompositionMemberViewV1,
  type CompositionProvenanceViewV1,
  type RevertCompositionCommandV1,
} from "@frockbot/core/configuration";
import type { BotIdentity } from "@frockbot/core/durable";
import {
  compositionFailureLogV1,
  currentUserCompositionV1,
  listUserCompositionGenerationsV1,
  readUserCompositionGenerationV1,
  revertUserCompositionV1,
} from "@frockbot/app/composition/bot";
import type { ShellBotStateV1 } from "./backend-state.js";
import type {
  CompositionFailureV1,
  CompositionQuarantineV1,
} from "@frockbot/core/durable";
import type {
  CompositionGenerationV1,
  CompositionMemberV1,
} from "@frockbot/core/durable";

/**
 * SEAM — plan Step 5 (authoring). Once the Bot object holds
 * `authorship:intent:<effectId>` / `artifact:<contentHash>` records, the Shell
 * Contribution supplies a reader that returns the recorded TypeScript source
 * for an isolate member. Until those records exist, no reader is supplied and a
 * generation view carries its member list alone.
 */
export type CompositionMemberSourceReaderV1 = (
  member: CompositionMemberV1,
) => Promise<string | undefined>;

function provenanceView(
  member: CompositionMemberV1,
): CompositionProvenanceViewV1 {
  const provenance = member.provenance;
  if (provenance.kind === "bot") {
    return {
      kind: "bot",
      botId: provenance.botId,
      sessionId: provenance.sessionId,
      turnId: provenance.turnId,
      runId: provenance.runId,
      authoredAt: provenance.authoredAt,
    };
  }
  // A seeded Plugin and one the account installed with its own command are
  // both the User's, and read as one kind: the difference between them is
  // where the artifact came from, not whose it is.
  return {
    kind: "user",
    userId: provenance.userId,
    authoredAt:
      provenance.kind === "installed"
        ? provenance.installedAt
        : provenance.authoredAt,
  };
}

export interface ProjectCompositionGenerationInput {
  botId: string;
  generation: CompositionGenerationV1;
  currentGenerationId: string;
  /** Omitted for the list projection: only a single generation carries source. */
  readMemberSource?: CompositionMemberSourceReaderV1;
  /** Recorded activation failures for this generation, oldest attempt first. */
  failures?: readonly CompositionFailureV1[];
  /** Present once three consecutive failures quarantined this generation. */
  quarantine?: CompositionQuarantineV1;
}

/** One durable generation as the hosted client may see it. */
export async function projectCompositionGenerationV1(
  input: ProjectCompositionGenerationInput,
): Promise<CompositionGenerationViewV1> {
  const members: CompositionMemberViewV1[] = [];
  for (const member of input.generation.members) {
    const source = member.artifact
      ? await input.readMemberSource?.(member)
      : undefined;
    members.push({
      packageId: member.packageId,
      version: member.version,
      provenance: provenanceView(member),
      ...(member.artifact ? { contentHash: member.artifact.contentHash } : {}),
      ...(source === undefined ? {} : { source }),
    });
  }
  // Diagnostics carry artifact content hashes and loader identities, so the
  // view keeps only the repairable half of a failure: when, where, and why.
  const failures = (input.failures ?? [])
    .slice(-MAX_COMPOSITION_FAILURE_PAGE_V1)
    .map((failure) => ({
      attempt: failure.attempt,
      at: failure.at,
      phase: failure.phase,
      message: failure.message,
    }));
  // Decoding the projection is the seam check: a field the view does not
  // declare cannot reach a client through this function.
  return decodeCompositionGenerationViewV1({
    schemaVersion: 1,
    botId: input.botId,
    generationId: input.generation.generationId,
    createdAt: input.generation.createdAt,
    status: input.generation.status,
    origin: input.generation.origin,
    isCurrent: input.generation.generationId === input.currentGenerationId,
    members,
    failures,
    ...(input.generation.summary === undefined
      ? {}
      : { summary: input.generation.summary }),
    ...(input.quarantine === undefined
      ? {}
      : {
          quarantine: {
            quarantinedAt: input.quarantine.quarantinedAt,
            reason: input.quarantine.reason,
            failures: input.quarantine.failures,
          },
        }),
    ...(input.generation.parentGenerationId === undefined
      ? {}
      : { parentGenerationId: input.generation.parentGenerationId }),
  });
}

/** Idempotency records for Composition commands this Package admits. */
const COMPOSITION_COMMAND_PREFIX = "composition-command:";

/**
 * The Bot's durable Composition generations, newest first. Bot-scoped: the
 * caller proves directory membership before this runs.
 */
export async function listCompositionGenerations(
  state: ShellBotStateV1,
  identity: BotIdentity,
  query: { limit: number; cursor?: string },
): Promise<CompositionGenerationListViewV1> {
  const failures = compositionFailureLogV1(state, identity);
  const current = await currentUserCompositionV1(state, identity);
  const page = await listUserCompositionGenerationsV1(state, identity, {
    limit: Math.min(query.limit, MAX_COMPOSITION_GENERATION_PAGE_V1),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  });
  return {
    schemaVersion: 1,
    botId: identity.botId,
    currentGenerationId: current.generationId,
    generations: await Promise.all(
      page.generations.map(async (generation: CompositionGenerationV1) =>
        projectCompositionGenerationV1({
          botId: identity.botId,
          generation,
          currentGenerationId: current.generationId,
          failures: await failures.list(generation.generationId),
          ...(await compositionQuarantineView(
            state,
            identity,
            generation.generationId,
          )),
        }),
      ),
    ),
    ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
  };
}

/** One generation, with the recorded source of each isolate member. */
export async function getCompositionGeneration(
  state: ShellBotStateV1,
  identity: BotIdentity,
  generationId: string,
): Promise<CompositionGenerationViewV1 | undefined> {
  const generation = await readUserCompositionGenerationV1(
    state,
    identity,
    generationId,
  );
  if (!generation) return undefined;
  const current = await currentUserCompositionV1(state, identity);
  return projectCompositionGenerationV1({
    botId: identity.botId,
    generation,
    currentGenerationId: current.generationId,
    failures: await compositionFailureLogV1(state, identity).list(generationId),
    ...(await compositionQuarantineView(state, identity, generationId)),
  });
}

/** Spread into a projection: absent unless the generation is quarantined. */
async function compositionQuarantineView(
  state: ShellBotStateV1,
  identity: BotIdentity,
  generationId: string,
): Promise<{ quarantine?: CompositionQuarantineV1 }> {
  const quarantine = await compositionFailureLogV1(state, identity).quarantine(
    generationId,
  );
  return quarantine === undefined ? {} : { quarantine };
}

/**
 * Reverting is a recorded generation, not a mutation: it proposes a new
 * pending generation carrying the target's members, which the next admitted
 * Turn activates. The command is idempotent on its `commandId`, and its
 * `expectedGenerationId` is the optimistic check that the User acted on the
 * Composition they were looking at.
 */
export async function revertComposition(
  state: ShellBotStateV1,
  identity: BotIdentity,
  command: RevertCompositionCommandV1,
): Promise<CompositionCommandReceiptV1> {
  if (command.botId !== identity.botId) {
    throw new Error("Composition revert command does not match its Bot");
  }
  const receiptKey = `${COMPOSITION_COMMAND_PREFIX}${command.commandId}`;
  const recorded =
    await state.ctx.storage.get<CompositionCommandReceiptV1>(receiptKey);
  if (recorded) return decodeCompositionCommandReceiptV1(recorded);
  const current = await currentUserCompositionV1(state, identity);
  const reject = async (
    failure: string,
  ): Promise<CompositionCommandReceiptV1> => {
    const receipt = decodeCompositionCommandReceiptV1({
      schemaVersion: 1,
      commandId: command.commandId,
      status: "rejected",
      failure,
      currentGenerationId: current.generationId,
    });
    await state.ctx.storage.put(receiptKey, receipt);
    return receipt;
  };
  if (current.generationId !== command.expectedGenerationId) {
    return reject(`composition generation is ${current.generationId}`);
  }
  let generationId: string;
  try {
    const reverted = await revertUserCompositionV1(
      state,
      identity,
      command.toGenerationId,
    );
    generationId = reverted.generationId;
  } catch (error) {
    return reject(
      error instanceof Error ? error.message : "Composition revert failed",
    );
  }
  const receipt = decodeCompositionCommandReceiptV1({
    schemaVersion: 1,
    commandId: command.commandId,
    status: "applied",
    generationId,
    currentGenerationId: current.generationId,
  });
  await state.ctx.storage.put(receiptKey, receipt);
  return receipt;
}
