// The common loader for Skills whose bytes live in an immutable artifact.
//
// Managed and Plugin Skills differ only in identity: source, ref, synthetic
// path, and attribution. Their document grammar and resource limits do not.
// Keeping those checks here means a first-party artifact and an untrusted
// Plugin artifact cannot drift into accepting different instruction shapes.
import {
  ARTIFACT_SKILLS_MAX_TOTAL_BYTES_V1,
  type SkillRefV1,
  type SkillRefSourceV1,
} from "@frockbot/core/contracts";
import { sha256HexTextV1 } from "@frockbot/core/crypto";
import type { LoadedSkillV1, SkillRefusalV1 } from "./catalog.js";
import {
  isSkillReferenceNameV1,
  isSkillSlugV1,
  parseSkillDocumentV1,
  skillReferencePathForV1,
  SKILL_MAX_FILE_BYTES,
  SKILL_MAX_REFERENCES,
} from "./skill-md.js";

export interface ArtifactSkillDocumentV1 {
  slug: string;
  text: string;
  references?: readonly { path: string; text: string }[];
}

export interface ArtifactSkillIdentityV1 {
  source: Extract<SkillRefSourceV1, "managed" | "plugin">;
  ref: SkillRefV1;
  path: string;
  attribution: string;
}

interface ValidatedArtifactSkillV1 {
  document: ArtifactSkillDocumentV1;
  identity: ArtifactSkillIdentityV1;
  parsed: Extract<ReturnType<typeof parseSkillDocumentV1>, { status: "ok" }>;
}

const encoder = new TextEncoder();

function bytes(text: string): number {
  return encoder.encode(text).byteLength;
}

function artifactBytes(documents: readonly ArtifactSkillDocumentV1[]): number {
  return documents.reduce(
    (total, document) =>
      total +
      bytes(document.text) +
      (document.references ?? []).reduce(
        (referenceTotal, reference) => referenceTotal + bytes(reference.text),
        0,
      ),
    0,
  );
}

/**
 * Loads one artifact group's Skills.
 *
 * Validation is deliberately specific before aggregate: slug, document,
 * reference count, then each reference's name before its byte size. A
 * malformed file keeps its precise refusal even when other valid files make
 * the artifact too large. The aggregate bound then refuses every otherwise
 * valid Skill together, matching the descriptor rule that an artifact is one
 * bounded unit.
 */
export async function loadArtifactSkillsV1(
  documents: readonly ArtifactSkillDocumentV1[],
  identityFor: (document: ArtifactSkillDocumentV1) => ArtifactSkillIdentityV1,
): Promise<{ skills: LoadedSkillV1[]; refusals: SkillRefusalV1[] }> {
  const validated: ValidatedArtifactSkillV1[] = [];
  const refusals: SkillRefusalV1[] = [];

  for (const document of documents) {
    const identity = identityFor(document);
    if (!isSkillSlugV1(document.slug)) {
      refusals.push({
        path: identity.path,
        kind: "malformed",
        reason: `the artifact Skill slug "${document.slug}" is not a well-formed slug`,
      });
      continue;
    }
    const parsed = parseSkillDocumentV1(document.text);
    if (parsed.status !== "ok") {
      refusals.push({
        path: identity.path,
        kind: "malformed",
        reason: parsed.reason,
      });
      continue;
    }
    const references = document.references ?? [];
    if (references.length > SKILL_MAX_REFERENCES) {
      refusals.push({
        path: identity.path,
        kind: "oversized",
        reason: `the Skill offers ${references.length} references; the bound is ${SKILL_MAX_REFERENCES}`,
      });
      continue;
    }
    const malformed = references.find(
      (reference) => !isSkillReferenceNameV1(reference.path),
    );
    if (malformed) {
      refusals.push({
        path: identity.path,
        kind: "malformed",
        reason: `its reference "${malformed.path}" is not a single .md file name`,
      });
      continue;
    }
    const oversized = references.find(
      (reference) => bytes(reference.text) > SKILL_MAX_FILE_BYTES,
    );
    if (oversized) {
      const size = bytes(oversized.text);
      refusals.push({
        path: identity.path,
        kind: "oversized",
        reason: `its reference ${oversized.path} is ${size} bytes; the bound is ${SKILL_MAX_FILE_BYTES}`,
      });
      continue;
    }
    validated.push({ document, identity, parsed });
  }

  const total = artifactBytes(documents);
  if (total > ARTIFACT_SKILLS_MAX_TOTAL_BYTES_V1) {
    refusals.push(
      ...validated.map(({ identity }) => ({
        path: identity.path,
        kind: "oversized" as const,
        reason: `the artifact carries ${total} bytes of Skill text; the bound is ${ARTIFACT_SKILLS_MAX_TOTAL_BYTES_V1}`,
      })),
    );
    return { skills: [], refusals };
  }

  const skills: LoadedSkillV1[] = [];
  for (const { document, identity, parsed } of validated) {
    const references = await Promise.all(
      (document.references ?? []).map(async (reference) => ({
        path: skillReferencePathForV1(identity.path, reference.path),
        by: identity.attribution,
        generationId: await sha256HexTextV1(reference.text),
        text: reference.text,
      })),
    );
    const contentHash = await sha256HexTextV1(document.text);
    skills.push({
      path: identity.path,
      source: identity.source,
      ref: identity.ref,
      by: identity.attribution,
      name: parsed.document.name,
      description: parsed.document.description,
      body: parsed.document.body,
      references,
      generationId: contentHash,
      contentHash,
    });
  }
  return { skills, refusals };
}
