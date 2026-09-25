// Writing one Skill document into one of a Bot's instruction roots.
//
// The writer names who the write is attributed to. `skill_write` writes as the
// Bot, inside an admitted Turn whose Session and Turn the provenance names.
//
// "The kernel treats every Workspace file as data. Only Skills under a Bot's
// instruction roots — its own and its User's — written under the Bot's own
// authority or its User's, are loaded as instructions." Every writer this
// module admits is on the right side of that sentence, and
// `isLoadableSkillSourceV1` is still the one place it is decided — this module
// cannot widen it, because both roots it can write are derived from the owner
// rather than passed in, so there is no argument with which to name another
// User's root or another Bot's.
import type {
  WorkspaceFilesV1,
  WorkspaceWriteRequestV1,
} from "@frockbot/core/contracts";
import { sha256HexTextV1 } from "@frockbot/core/crypto";
import {
  botInstructionRootV1,
  countSkillDocumentsV1,
  countSkillReferencesV1,
  userInstructionRootV1,
  type SkillOwnerV1,
} from "./catalog.js";
import {
  renderSkillDocumentV1,
  skillDocumentPathV1,
  skillReferencePathV1,
  SKILL_MAX_REFERENCES,
} from "./skill-md.js";
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

/** Skill content hashes remain named for the Skill package at its seam. */
export const sha256HexV1 = sha256HexTextV1;

/**
 * Renders and writes one Skill, enforcing that root's quota on the way.
 *
 * A refusal is a value, never a throw: a quota breach, an unreadable root, or a
 * losing optimistic write are all outcomes a caller must record and report; the
 * Bot's tool reports them as a tool result the model reads.
 */
export async function writeSkillDocumentV1(
  files: WorkspaceFilesV1,
  owner: SkillOwnerV1,
  writer: SkillDocumentWriterV1,
  draft: SkillDocumentDraftV1,
  options: {
    /**
     * Which instruction root the Skill lands in: the Bot's own by default, or
     * the User-global root every Bot of that User shares. The writer is
     * unchanged either way — a Bot writing the shared root still records
     * itself, which is what lets a reading Bot be told whose Skill it is
     * following.
     */
    scope?: SkillQuotaScopeV1;
    quota?: SkillQuotaConfigV1;
    /**
     * Recorded intent, after the quota admits the write and strictly before it
     * runs. "Record durable execution intent before invoking an external side
     * effect" — the Bot's tool appends `skill/write-intent` here, so it cannot
     * be interrupted between deciding to write and having a record that it
     * tried.
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

/**
 * Writes one reference beside a Skill the same root already holds (ADR 0030).
 *
 * The path is derived, never passed: `skillReferencePathV1` composes it from
 * the Skill's slug and one file name, so a reference can only ever land inside
 * its own Skill's `references/` directory and a Bot cannot write an
 * instruction anywhere else by naming a path. The Skill itself must be there —
 * a reference with no `SKILL.md` above it is a file nothing can ever load, and
 * writing one would leave a Bot believing it had authored an instruction.
 *
 * The quota is the same one: a reference's bytes are bounded like a Skill's,
 * and the count it is checked against is the Skill's references rather than the
 * root's Skills, because a reference grows a Skill and not the catalog.
 */
export async function writeSkillReferenceV1(
  files: WorkspaceFilesV1,
  owner: SkillOwnerV1,
  writer: SkillDocumentWriterV1,
  draft: { slug: string; reference: string; text: string },
  options: {
    scope?: SkillQuotaScopeV1;
    quota?: SkillQuotaConfigV1;
    onIntent?(intent: { path: string; contentHash: string }): Promise<void>;
  } = {},
): Promise<SkillWriteOutcomeV1> {
  const quota = options.quota ?? SKILL_QUOTA_DEFAULTS_V1;
  const scope = options.scope ?? "bot";
  const root =
    scope === "user"
      ? userInstructionRootV1(owner)
      : botInstructionRootV1(owner);
  const documentPath = skillDocumentPathV1(draft.slug);
  let relativePath: string;
  try {
    relativePath = skillReferencePathV1(draft.slug, draft.reference);
  } catch (error) {
    return {
      status: "refused",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const document = await files.stat({ root, path: documentPath });
  if (document.status === "not-found") {
    return {
      status: "refused",
      reason: `no Skill "${draft.slug}" is written there yet; write its SKILL.md first`,
    };
  }
  if (document.status !== "ok") {
    return {
      status: "refused",
      reason: `the instruction root is unavailable: ${document.reason}`,
    };
  }
  const path = { root, path: relativePath };
  const existing = await files.stat(path);
  if (existing.status !== "ok" && existing.status !== "not-found") {
    return {
      status: "refused",
      reason: `the instruction root is unavailable: ${existing.reason}`,
    };
  }
  const counted = await countSkillReferencesV1(files, root, documentPath);
  if (counted.status !== "ok") {
    return {
      status: "refused",
      reason: `${counted.reason}, so the Skill's reference bound cannot be enforced`,
    };
  }
  if (existing.status !== "ok" && counted.count >= SKILL_MAX_REFERENCES) {
    return {
      status: "refused",
      reason: `Skill "${draft.slug}" holds ${counted.count} references; the bound is ${SKILL_MAX_REFERENCES}`,
    };
  }
  const bytes = new TextEncoder().encode(draft.text);
  const verdict = checkSkillQuotaV1(
    {
      bytes: bytes.byteLength,
      // A reference never grows the root's Skill count, so the count half of
      // the quota is satisfied by construction and the bytes half is not.
      existingSkills: 0,
      replaces: true,
      scope,
    },
    quota,
  );
  if (verdict.status === "refused") {
    return { status: "refused", reason: verdict.reason };
  }

  const contentHash = await sha256HexV1(draft.text);
  await options.onIntent?.({ path: relativePath, contentHash });

  const outcome = await files.write({
    path,
    bytes,
    writer,
    expectedGenerationId:
      existing.status === "ok" ? existing.entry.generation.generationId : null,
    mediaType: "text/markdown",
  });
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
