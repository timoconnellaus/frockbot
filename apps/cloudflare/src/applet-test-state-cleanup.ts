// Disposable pre-user cleanup for Bot-owned Applets (ADR 0027).
//
// A directory entry written before Applets had an owner Bot names nobody who
// may change it, and there is no honest owner to infer: the provenance names
// the creating Bot, which may since have been deleted, and a User-created
// Applet names no Bot at all. There are no users yet, so the entry is removed
// rather than decoded, its state and source are queued for the same cleanup a
// deletion uses, and a Composition generation still holding Applet members of
// the old shape is replaced by one holding the same Plugins and no Applets —
// the next Turn re-resolves Applets from the directory. Nothing else in the
// account is touched, and the receipt makes a second load free.
import {
  appletCleanupKey,
  compositionArtifactSetHashV1,
  compositionGenerationIdV1,
  compositionGenerationKey,
  compositionIndexKey,
  decodeAppletDirectoryEntryV1,
  decodeCompositionGenerationV1,
  decodeCompositionMemberV1,
  decodeCompositionPinV1,
  APPLET_DIRECTORY_ENTRY_PREFIX,
  APPLET_DIRECTORY_REVISION_KEY,
  COMPOSITION_CURRENT_KEY,
  COMPOSITION_GENERATION_PREFIX,
  COMPOSITION_LAST_KNOWN_GOOD_KEY,
  type CompositionGenerationV1,
} from "@frockbot/core/durable";
import { APPLET_ID_V1 } from "@frockbot/core/contracts";

export const BOT_OWNED_APPLETS_CLEANUP_RECEIPT_KEY =
  "maintenance:bot-owned-applets:2026-09-14";

function decodes(decode: () => unknown): boolean {
  try {
    decode();
    return true;
  } catch {
    return false;
  }
}

export async function cleanAppletTestStateV1(
  storage: DurableObjectStorage,
  now: Date = new Date(),
): Promise<void> {
  if (await storage.get(BOT_OWNED_APPLETS_CLEANUP_RECEIPT_KEY)) return;
  const at = now.toISOString();

  const legacyEntries = [
    ...(
      await storage.list<unknown>({ prefix: APPLET_DIRECTORY_ENTRY_PREFIX })
    ).entries(),
  ].filter(([, value]) => !decodes(() => decodeAppletDirectoryEntryV1(value)));

  // A generation that does not decode only because of its Applet members is
  // Applet data; one that does not decode for any other reason is left to the
  // Composition store's own handling.
  const legacyGenerations: { key: string; raw: Record<string, unknown> }[] = [];
  for (const [key, value] of await storage.list<unknown>({
    prefix: COMPOSITION_GENERATION_PREFIX,
  })) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const raw = value as Record<string, unknown>;
    if (!Array.isArray(raw.applets)) continue;
    if (decodes(() => decodeCompositionGenerationV1(raw))) continue;
    const withoutApplets = { ...raw };
    delete withoutApplets.applets;
    if (!decodes(() => decodeCompositionGenerationV1(withoutApplets))) continue;
    legacyGenerations.push({ key, raw });
  }

  const pinned = await storage.get<unknown>(COMPOSITION_CURRENT_KEY);
  const currentId =
    pinned === undefined ? undefined : decodeCompositionPinV1(pinned).generationId;
  const lastKnownGoodId = await storage.get<string>(
    COMPOSITION_LAST_KNOWN_GOOD_KEY,
  );
  const legacyIds = new Set(
    legacyGenerations.map(({ raw }) => raw.generationId as string),
  );
  const currentIsLegacy = currentId !== undefined && legacyIds.has(currentId);
  const lastKnownGoodIsLegacy =
    lastKnownGoodId !== undefined && legacyIds.has(lastKnownGoodId);

  // The account keeps running the Plugins it had: the replacement is the
  // pinned generation's own members, with the Applet list the next Turn
  // resolves again from the directory.
  let replacement: CompositionGenerationV1 | undefined;
  const pinnedLegacy = legacyGenerations.find(({ raw }) =>
    currentIsLegacy
      ? raw.generationId === currentId
      : raw.generationId === lastKnownGoodId,
  );
  if (pinnedLegacy && (currentIsLegacy || lastKnownGoodIsLegacy)) {
    const members = (pinnedLegacy.raw.members as unknown[]).map(
      (member, index) =>
        decodeCompositionMemberV1(
          member,
          `composition generation.members[${index}]`,
        ),
    );
    const artifactSetHash = await compositionArtifactSetHashV1(members);
    replacement = decodeCompositionGenerationV1({
      schemaVersion: 1,
      generationId: compositionGenerationIdV1(at, artifactSetHash),
      artifactSetHash,
      parentGenerationId: pinnedLegacy.raw.generationId,
      createdAt: at,
      origin: { kind: "bootstrap" },
      members,
      status: "active",
    });
  }

  await storage.transaction(async (tx) => {
    if (await tx.get(BOT_OWNED_APPLETS_CLEANUP_RECEIPT_KEY)) return;
    const writes: Record<string, unknown> = {};
    const deletes: string[] = [];
    for (const [key] of legacyEntries) {
      deletes.push(key);
      const appletId = key.slice(APPLET_DIRECTORY_ENTRY_PREFIX.length);
      if (APPLET_ID_V1.test(appletId)) {
        writes[appletCleanupKey(appletId)] = {
          schemaVersion: 1,
          appletId,
          recordedAt: at,
        };
      }
    }
    if (legacyEntries.length > 0) {
      writes[APPLET_DIRECTORY_REVISION_KEY] =
        ((await tx.get<number>(APPLET_DIRECTORY_REVISION_KEY)) ?? 0) + 1;
    }
    for (const { key, raw } of legacyGenerations) {
      deletes.push(key);
      if (typeof raw.createdAt === "string") {
        deletes.push(
          compositionIndexKey(raw.createdAt, raw.generationId as string),
        );
      }
    }
    if (replacement) {
      writes[compositionGenerationKey(replacement.generationId)] = replacement;
      writes[
        compositionIndexKey(replacement.createdAt, replacement.generationId)
      ] = replacement.generationId;
      if (currentIsLegacy) {
        writes[COMPOSITION_CURRENT_KEY] = {
          generationId: replacement.generationId,
          artifactSetHash: replacement.artifactSetHash,
        };
      }
      if (lastKnownGoodIsLegacy) {
        writes[COMPOSITION_LAST_KNOWN_GOOD_KEY] = replacement.generationId;
      }
    }
    if (deletes.length > 0) await tx.delete(deletes);
    await tx.put({
      ...writes,
      [BOT_OWNED_APPLETS_CLEANUP_RECEIPT_KEY]: {
        at,
        removedApplets: legacyEntries.length,
        removedGenerations: legacyGenerations.length,
        ...(replacement ? { replacement: replacement.generationId } : {}),
      },
    });
  });
}
