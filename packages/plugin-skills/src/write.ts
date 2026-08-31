// Writing one Skill document into one of a Bot's instruction roots.
//
// Two callers reach this, and they differ in exactly one thing: who the write
// is attributed to. `skill_write` writes as the Bot, inside an admitted Turn
// whose Session and Turn the provenance names. Importing a Bot template writes
// as the importing *User*, because a template is prose their User chose to
// materialize and no Turn of the new Bot has run yet.
//
// "The kernel treats every Workspace file as data. Only Skills under a Bot's
// instruction roots — its own and its User's — written under the Bot's own
// authority or its User's, are loaded as instructions." Both writers this
// module admits are on the right side of that sentence, and
// `isLoadableSkillSourceV1` is still the one place it is decided — this module
// cannot widen it, because both roots it can write are derived from the owner
// rather than passed in, so there is no argument with which to name another
// User's root or another Bot's.
import type {
  WorkspaceFilesV1,
  WorkspaceWriteRequestV1,
} from "@frockbot/kernel-contracts";
import {
  botInstructionRootV1,
  countSkillDocumentsV1,
  userInstructionRootV1,
  type SkillOwnerV1,
} from "./catalog.js";
import { renderSkillDocumentV1, skillDocumentPathV1 } from "./skill-md.js";
import {
  checkSkillQuotaV1,
  skillCountLimitV1,
  SKILL_QUOTA_DEFAULTS_V1,
  type SkillQuotaConfigV1,
  type SkillQuotaScopeV1,
} from "./quota.js";

/** Who a Skill write is attributed to. Only these two are loadable. */
export type SkillDocumentWriterV1 =
  | { kind: "user"; userId: string }
  | {
      kind: "bot";
      botId: string;
      sessionId: string;
      turnId: string;
      runId: string;
    };

export interface SkillDocumentDraftV1 {
  slug: string;
  name: string;
  description: string;
  body: string;
}

export type SkillWriteOutcomeV1 =
  | {
      status: "written";
      path: string;
      generationId: string;
      contentHash: string;
      /** True when the write superseded an existing generation at that path. */
      replaced: boolean;
    }
  | { status: "refused"; reason: string };

export async function sha256HexV1(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Renders and writes one Skill, enforcing that root's quota on the way.
 *
 * A refusal is a value, never a throw: a quota breach, an unreadable root, or a
 * losing optimistic write are all outcomes a caller must record and report, and
 * the two callers report them very differently — one as a tool result the model
 * reads, one as a repairable step on a durable import record.
 */
export async function writeSkillDocumentV1(
  files: WorkspaceFilesV1,
  owner: SkillOwnerV1,
  writer: SkillDocumentWriterV1,
  draft: SkillDocumentDraftV1,
  options: {
    /**
     * Which instruction root the Skill lands in: the Bot's own by default, or
     * the User-global root every Bot of that User shares (ADR 0016). The
     * writer is unchanged either way — a Bot writing the shared root still
     * records itself, which is what lets a reading Bot be told whose Skill it
     * is following.
     */
    scope?: SkillQuotaScopeV1;
    quota?: SkillQuotaConfigV1;
    /**
     * Recorded intent, after the quota admits the write and strictly before it
     * runs. "Record durable execution intent before invoking an external side
     * effect" — the Bot's tool appends `skill/write-intent` here, and the
     * import saga marks its step in flight, so neither can be interrupted
     * between deciding to write and having a record that it tried.
     */
    onIntent?(intent: { path: string; contentHash: string }): Promise<void>;
  } = {},
): Promise<SkillWriteOutcomeV1> {
  const quota = options.quota ?? SKILL_QUOTA_DEFAULTS_V1;
  const scope = options.scope ?? "bot";
  const root =
    scope === "user"
      ? userInstructionRootV1(owner)
      : botInstructionRootV1(owner);
  const relativePath = skillDocumentPathV1(draft.slug);
  const path = { root, path: relativePath };
  const text = renderSkillDocumentV1({
    name: draft.name,
    description: draft.description,
    body: draft.body,
  });
  const bytes = new TextEncoder().encode(text);

  const existing = await files.stat(path);
  if (existing.status !== "ok" && existing.status !== "not-found") {
    return {
      status: "refused",
      reason: `the instruction root is unavailable: ${existing.reason}`,
    };
  }
  // The count is paged to completion, and a listing that cannot be read is a
  // refusal rather than a zero: a quota that falls open is not a quota.
  const counted = await countSkillDocumentsV1(files, path.root, {
    stopAfter: skillCountLimitV1(scope, quota),
  });
  if (counted.status !== "ok") {
    return {
      status: "refused",
      reason: `${counted.reason}, so the per-${
        scope === "user" ? "User" : "Bot"
      } Skill quota cannot be enforced`,
    };
  }
  const verdict = checkSkillQuotaV1(
    {
      bytes: bytes.byteLength,
      existingSkills: counted.count,
      replaces: existing.status === "ok",
      scope,
    },
    quota,
  );
  if (verdict.status === "refused") {
    return { status: "refused", reason: verdict.reason };
  }

  const contentHash = await sha256HexV1(text);
  await options.onIntent?.({ path: relativePath, contentHash });

  const request: WorkspaceWriteRequestV1 = {
    path,
    bytes,
    writer,
    expectedGenerationId:
      existing.status === "ok" ? existing.entry.generation.generationId : null,
    mediaType: "text/markdown",
  };
  const outcome = await files.write(request);
  if (outcome.status !== "ok") {
    return {
      status: "refused",
      reason: `the write was ${outcome.status}: ${outcome.reason}`,
    };
  }
  return {
    status: "written",
    path: relativePath,
    generationId: outcome.generation.generationId,
    contentHash,
    replaced: existing.status === "ok",
  };
}
