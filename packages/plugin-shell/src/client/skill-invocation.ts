// The composer's Skill-invocation state, as a pure store.
//
// GrokBot's users invoke a Skill with `/` or `@`
// (`docs/research/grokbot-computer.md` §2.8). Selecting one does *not* paste
// its text into the message: it attaches a ref, and the backend expands the
// body it resolves at the exact generation the Turn loads. That distinction is
// the whole point — a pasted body is a message the User could edit into
// something the Skill never said, while a ref is a name the Bot resolves.
//
// Everything here is framework-free so the ranking, the keyboard model and the
// three-chip bound are testable without mounting a component. The Vue
// component owns focus and rendering; it owns no rules.
import {
  formatSkillRefV1,
  MAX_INVOKED_SKILLS_V1,
  type SkillRefV1,
} from "@frockbot/kernel-contracts";
import type { ClientSkillCatalogEntryV1 } from "../skill-protocol.js";

/** The characters that open the popover, in GrokBot's shape. */
export const SKILL_TRIGGER_CHARACTERS_V1 = ["/", "@"] as const;

/** The open popover: which trigger opened it, and what has been typed since. */
export interface SkillPopoverStateV1 {
  trigger: "/" | "@";
  /** Index in the text where the trigger character sits. */
  at: number;
  query: string;
}

/** One ranked candidate the popover offers. */
export interface SkillCandidateV1 {
  entry: ClientSkillCatalogEntryV1;
  /** Lower sorts first. Exposed so a test can assert the ordering's reason. */
  rank: number;
}

function matchScore(entry: ClientSkillCatalogEntryV1, query: string): number {
  // 0 is "no query": everything matches and the catalog's own order stands.
  if (!query) return 0;
  const needle = query.toLowerCase();
  const slug = entry.skill.slug.toLowerCase();
  const name = entry.name.toLowerCase();
  const description = entry.description.toLowerCase();
  if (slug === needle || name === needle) return 1;
  if (slug.startsWith(needle) || name.startsWith(needle)) return 2;
  if (slug.includes(needle) || name.includes(needle)) return 3;
  if (description.includes(needle)) return 4;
  return Number.POSITIVE_INFINITY;
}

/**
 * The candidates a query offers, best first.
 *
 * Ties break on the canonical ref rather than on catalog order, so the list a
 * User navigates with the arrow keys does not reshuffle when the backend
 * happens to enumerate the instruction root in a different order.
 */
export function rankSkillCandidatesV1(
  catalog: readonly ClientSkillCatalogEntryV1[],
  query: string,
  options: { exclude?: readonly SkillRefV1[] } = {},
): SkillCandidateV1[] {
  const excluded = new Set(
    (options.exclude ?? []).map((ref) => formatSkillRefV1(ref)),
  );
  return catalog
    .filter((entry) => !excluded.has(entry.ref))
    .map((entry) => ({ entry, rank: matchScore(entry, query) }))
    .filter((candidate) => Number.isFinite(candidate.rank))
    .sort(
      (left, right) =>
        left.rank - right.rank || left.entry.ref.localeCompare(right.entry.ref),
    );
}

/**
 * Reads the open popover out of the composer's text and caret.
 *
 * A trigger opens the popover only at the start of the message or after
 * whitespace, so an email address or a path in prose does not turn into a Skill
 * picker, and any whitespace after the trigger closes it again.
 */
export function skillPopoverForV1(
  text: string,
  caret: number,
): SkillPopoverStateV1 | undefined {
  const position = Math.max(0, Math.min(caret, text.length));
  for (let index = position - 1; index >= 0; index -= 1) {
    const character = text[index] ?? "";
    if (/\s/u.test(character)) return undefined;
    if (character === "/" || character === "@") {
      const before = index === 0 ? "" : (text[index - 1] ?? "");
      if (before !== "" && !/\s/u.test(before)) return undefined;
      return {
        trigger: character,
        at: index,
        query: text.slice(index + 1, position),
      };
    }
  }
  return undefined;
}

/** The text after a selection: the trigger and its query are removed. */
export function textWithoutSkillTriggerV1(
  text: string,
  popover: SkillPopoverStateV1,
  caret: number,
): { text: string; caret: number } {
  const end = Math.max(popover.at, Math.min(caret, text.length));
  return {
    text: `${text.slice(0, popover.at)}${text.slice(end)}`,
    caret: popover.at,
  };
}

/**
 * The attached refs, bounded and ordered.
 *
 * Deep and small: `attach`, `detach` and `take` are the only ways the list
 * changes, so the composer can never submit more refs than the decoder admits
 * and can never submit the same one twice.
 */
export class SkillAttachmentStore {
  #attached: ClientSkillCatalogEntryV1[] = [];

  attached(): readonly ClientSkillCatalogEntryV1[] {
    return this.#attached;
  }

  refs(): SkillRefV1[] {
    return this.#attached.map((entry) => entry.skill);
  }

  full(): boolean {
    return this.#attached.length >= MAX_INVOKED_SKILLS_V1;
  }

  /** True when the entry was attached; false when it was full or a duplicate. */
  attach(entry: ClientSkillCatalogEntryV1): boolean {
    if (this.full()) return false;
    if (this.#attached.some((existing) => existing.ref === entry.ref)) {
      return false;
    }
    this.#attached = [...this.#attached, entry];
    return true;
  }

  detach(ref: string): void {
    this.#attached = this.#attached.filter((entry) => entry.ref !== ref);
  }

  /** Empties the store and hands back what it held, for one submission. */
  take(): SkillRefV1[] {
    const refs = this.refs();
    this.#attached = [];
    return refs;
  }

  /** Puts a rejected submission's refs back, so nothing is lost on failure. */
  restore(entries: readonly ClientSkillCatalogEntryV1[]): void {
    this.#attached = entries.slice(0, MAX_INVOKED_SKILLS_V1);
  }
}

/** Moves the popover's highlight, wrapping at both ends. */
export function nextSkillHighlightV1(
  highlighted: number,
  count: number,
  direction: 1 | -1,
): number {
  if (count <= 0) return 0;
  return (highlighted + direction + count) % count;
}
