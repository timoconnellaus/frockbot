// "every voice a Bot can be given is one this account can actually speak in",
// checked against the provider rather than assumed.
//
// Why this exists. On 2026-09-17 the curated catalog shipped fourteen
// ElevenLabs voice ids taken from the provider's well-known "premade" list.
// Nine of them did not exist on this deployment's account, and one of the
// five that did was under the wrong name. Nothing caught it: the voice tests
// script the model and the speech provider so they are deterministic and
// free, which is right, and means an unreachable voice id is invisible to
// every one of them. It is also invisible at runtime — an id the account
// cannot reach does not raise an error a person sees, it produces a sentence
// that never becomes sound.
//
// So the check has to talk to the account, which makes it a deploy-time
// check rather than a unit test. It runs where the key already is, and it
// skips rather than fails when there is no key, so it never blocks a
// contributor or a merge on a secret they do not have.
import {
  VOICE_BY_CHARACTER_V1,
  VOICE_CATALOG_V1,
  type VoiceOptionV1,
} from "../app/voice/voices.js";

/** One voice as the account lists it. */
export interface AccountVoiceV1 {
  voiceId: string;
  name: string;
}

/** What the audit found. Empty everywhere is a pass. */
export interface VoiceCatalogAuditV1 {
  /** Catalog voices the account cannot reach: these are silence. */
  missing: VoiceOptionV1[];
  /** Characters whose default voice is not in the catalog at all. */
  unmapped: string[];
  /** Catalog entries whose name has drifted from the account's own. */
  renamed: { voiceId: string; ours: string; theirs: string }[];
}

/**
 * Compares the shipped catalog with what the account holds.
 *
 * Pure, so the interesting part is testable without a key or a network. The
 * caller decides what is fatal; this only reports.
 */
export function voiceCatalogAuditV1(input: {
  catalog: readonly VoiceOptionV1[];
  byCharacter: Readonly<Record<string, string>>;
  account: readonly AccountVoiceV1[];
}): VoiceCatalogAuditV1 {
  const account = new Map(input.account.map((voice) => [voice.voiceId, voice]));
  const catalogIds = new Set(input.catalog.map((voice) => voice.voiceId));

  const missing = input.catalog.filter((voice) => !account.has(voice.voiceId));

  // A character pointing outside the catalog cannot be chosen away from in
  // settings either, so it is a defect even when the id happens to resolve.
  const unmapped = Object.entries(input.byCharacter)
    .filter(([, voiceId]) => !catalogIds.has(voiceId))
    .map(([characterId]) => characterId);

  // Not fatal on its own — the voice still speaks — but it is how a picker
  // ends up offering "Bella" and playing Sarah, so it is worth saying out
  // loud.
  //
  // Ours is the short form the picker shows and theirs is whatever the
  // account calls it, so a match is a prefix rather than an equality: the
  // account writes both "Sarah - Mature, Reassuring, Confident" and "Jason
  // Pike", and "Sarah" and "Jason" are right in each case. What is left after
  // that is a genuinely different person's name, which is the thing worth
  // reporting.
  const renamed: VoiceCatalogAuditV1["renamed"] = [];
  for (const voice of input.catalog) {
    const theirs = account.get(voice.voiceId);
    if (!theirs) continue;
    if (!namesAgreeV1(voice.name, theirs.name)) {
      renamed.push({
        voiceId: voice.voiceId,
        ours: voice.name,
        theirs: theirs.name,
      });
    }
  }

  return { missing, unmapped, renamed };
}

/**
 * Whether our short name for a voice is the same person as the account's.
 *
 * True when theirs begins with ours at a word boundary, which covers both the
 * descriptive tail the account adds ("Sarah - Mature, Reassuring") and a
 * surname it keeps ("Jason Pike").
 */
function namesAgreeV1(ours: string, theirs: string): boolean {
  const mine = ours.trim().toLowerCase();
  const yours = theirs.trim().toLowerCase();
  if (!mine) return false;
  if (yours === mine) return true;
  return (
    yours.startsWith(mine) && /[\s-]/.test(yours.charAt(mine.length) || "")
  );
}

/** Whether an audit should fail the job. A wrong name is reported, not fatal. */
export function voiceCatalogAuditFailsV1(audit: VoiceCatalogAuditV1): boolean {
  return audit.missing.length > 0 || audit.unmapped.length > 0;
}

/** The audit as the job prints it. */
export function voiceCatalogAuditReportV1(audit: VoiceCatalogAuditV1): string {
  const lines: string[] = [];
  for (const voice of audit.missing) {
    lines.push(
      `missing: ${voice.voiceId} (${voice.name}) is not on this account — ` +
        `a Bot given it would speak silence`,
    );
  }
  for (const characterId of audit.unmapped) {
    lines.push(
      `unmapped: character "${characterId}" defaults to a voice that is not ` +
        `in the catalog`,
    );
  }
  for (const drift of audit.renamed) {
    lines.push(
      `renamed: ${drift.voiceId} is "${drift.ours}" here and ` +
        `"${drift.theirs}" on the account`,
    );
  }
  return lines.join("\n");
}

/** Reads every voice the account can reach, following its pagination. */
export async function fetchAccountVoicesV1(
  apiKey: string,
  doFetch: typeof fetch = fetch,
): Promise<AccountVoiceV1[]> {
  const voices: AccountVoiceV1[] = [];
  for (let page = 0; page < 20; page += 1) {
    const response = await doFetch(
      `https://api.elevenlabs.io/v2/voices?page_size=100&page=${page}`,
      { headers: { "xi-api-key": apiKey } },
    );
    if (!response.ok) {
      throw new Error(
        `ElevenLabs refused the voice list (${response.status}). ` +
          `The key needs the voices_read permission.`,
      );
    }
    const body = (await response.json()) as {
      voices?: { voice_id?: string; name?: string }[];
      has_more?: boolean;
    };
    for (const voice of body.voices ?? []) {
      if (voice.voice_id) {
        voices.push({ voiceId: voice.voice_id, name: voice.name ?? "" });
      }
    }
    if (!body.has_more) break;
  }
  return voices;
}

async function main(): Promise<number> {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) {
    // Deliberately not a failure: most runs of this repo have no voice key,
    // and a check that cries wolf on every contributor is a check people
    // learn to ignore.
    console.log(
      "voice catalog: skipped, ELEVENLABS_API_KEY is not set in this environment",
    );
    return 0;
  }

  let account: AccountVoiceV1[];
  try {
    account = await fetchAccountVoicesV1(apiKey);
  } catch (error) {
    console.error(`voice catalog: could not read the account — ${error}`);
    return 1;
  }

  const audit = voiceCatalogAuditV1({
    catalog: VOICE_CATALOG_V1,
    byCharacter: VOICE_BY_CHARACTER_V1,
    account,
  });
  const report = voiceCatalogAuditReportV1(audit);
  if (report) console.error(report);

  if (voiceCatalogAuditFailsV1(audit)) {
    console.error(
      `voice catalog: ${audit.missing.length} of ${VOICE_CATALOG_V1.length} ` +
        `voices are unreachable on this account`,
    );
    return 1;
  }
  console.log(
    `voice catalog: all ${VOICE_CATALOG_V1.length} voices resolve, ` +
      `${Object.keys(VOICE_BY_CHARACTER_V1).length} characters mapped`,
  );
  return 0;
}

if (import.meta.main) process.exit(await main());
