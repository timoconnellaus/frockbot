import {
  type CompositionMemberV1,
  type FrockBotManifest,
  decodeFrockBotManifest,
} from "@frockbot/kernel-composition";

/**
 * Where a Composition member's manifest can be found. `stored` is
 * `authorship:manifest:<hash>` — written by the authoring path and by a
 * Catalog install, so it covers every member a Bot or its User put into the
 * Composition. `application` is the compiled-in manifest of a first-party
 * artifact-backed member (ADR 0022 decision 8), which came from neither and is
 * already in this bundle. Two *places*, never two answers: the `manifestHash`
 * decides in both.
 */
export interface CompositionManifestSourcesV1 {
  stored(manifestHash: string): Promise<{ manifest: unknown } | undefined>;
  application(member: CompositionMemberV1): Promise<unknown | undefined>;
}

/**
 * A member's manifest **as the stored document** — byte-for-byte what its
 * `manifestHash` was taken over.
 *
 * This is the seam that broke every Bot-authored Package. Authoring hashes
 * `canonicalJson(rawManifest)` and stores `rawManifest` verbatim; the mount
 * re-hashes whatever it is handed and refuses a mismatch
 * (`botIsolatePackageDescriptorV1`). Returning a *decoded* manifest here put a
 * rebuilt object on the mount's side of that comparison — `decodeV5` always
 * writes a `configuration` key, among other things — so the two hashes could
 * never agree, and every authored Package failed with `stored manifest failed
 * hash verification` while first-party members (which were already read raw)
 * mounted fine.
 *
 * Callers that want the typed shape decode it themselves, downstream of the
 * hash check.
 */
export async function compositionMemberManifestDocumentV1(
  member: CompositionMemberV1,
  sources: CompositionManifestSourcesV1,
): Promise<unknown | undefined> {
  const stored = await sources.stored(member.manifestHash);
  if (stored) return stored.manifest;
  return await sources.application(member);
}

/** The same manifest as the typed shape, for readers that are not mounts. */
export async function compositionMemberManifestV1(
  member: CompositionMemberV1,
  sources: CompositionManifestSourcesV1,
): Promise<FrockBotManifest | undefined> {
  const document = await compositionMemberManifestDocumentV1(member, sources);
  if (document === undefined) return undefined;
  return decodeFrockBotManifest(document);
}
