// The Memory file format, both halves of it.
//
// GrokBot writes and injects a fact in two different shapes
// (`docs/research/grokbot-computer.md` §4.1b), and matching parity means
// matching both:
//
//   on disk    - (YYYY-MM-DD) <fact>
//   injected   - (learned YYYY-MM-DD) [via <bot>] <fact>
//
// `[note] ` and `[episode] ` are prefixes *on the fact text*, not separate
// files, so they survive a round trip through the disk form untouched.
//
// One shape this Package adds, which GrokBot has no equivalent for: a
// retraction. "a forget on a shared tier writes a retraction in the Bot's own
// shard — newest wins — never edits another shard", so a forget the Bot cannot
// perform by deleting a line it owns is recorded as `[forgotten] <fact>` in
// its own shard, and the reader drops the fact when the retraction is newer.
// It is deliberately the same line grammar: a Bot or a User reading the file
// with ordinary tools sees why the fact went away.

/** The marker a retraction carries, as a prefix on the fact text. */
export const MEMORY_FORGOTTEN_PREFIX = "[forgotten] ";

/** One fact, as it was parsed from a Memory file. */
export interface MemoryFactV1 {
  /** `YYYY-MM-DD`, the day the fact was recorded. */
  date: string;
  /** The fact text, including any `[note] `/`[episode] ` prefix. */
  text: string;
}

/** A fact together with where it came from, for rendering and precedence. */
export interface SourcedMemoryFactV1 extends MemoryFactV1 {
  /** The Bot whose shard holds it. */
  botId: string;
  /** The display name of that Bot, or its id when no name is known. */
  via: string;
  /** `profile.md` or a monthly log. */
  kind: "profile" | "log";
  /** The generation the line was read from; ordering's tiebreak. */
  generationId: string;
}

const FACT_LINE = /^-\s+\((\d{4}-\d{2}-\d{2})\)\s+(.*)$/;

/** `YYYY-MM-DD` in UTC. Memory dates are days, never instants. */
export function memoryDayV1(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The on-disk line for one fact. */
export function renderMemoryFactLineV1(fact: MemoryFactV1): string {
  return `- (${fact.date}) ${fact.text}`;
}

/**
 * Parses one Memory file. Lines that are not facts — a heading a User typed, a
 * blank line, a stray paragraph — are ignored rather than refused: a Memory
 * file is a file the User may edit by hand, and one malformed line must not
 * cost the Bot the rest of its Memory.
 */
export function parseMemoryFileV1(
  text: string,
  options: { maxFacts?: number } = {},
): MemoryFactV1[] {
  const maximum = options.maxFacts ?? 5_000;
  const facts: MemoryFactV1[] = [];
  for (const line of text.split("\n")) {
    if (facts.length >= maximum) break;
    const match = FACT_LINE.exec(line.trim());
    if (!match) continue;
    const body = (match[2] ?? "").trim();
    if (!body) continue;
    facts.push({ date: match[1] ?? "", text: body });
  }
  return facts;
}

/** Renders a whole Memory file from its facts, oldest first. */
export function renderMemoryFileV1(facts: MemoryFactV1[]): string {
  if (facts.length === 0) return "";
  return `${facts.map(renderMemoryFactLineV1).join("\n")}\n`;
}

/** The comparison key for "the same fact": trimmed, case-folded text. */
export function memoryFactKeyV1(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** True when a fact text is a retraction rather than an assertion. */
export function isMemoryRetractionV1(text: string): boolean {
  return text.startsWith(MEMORY_FORGOTTEN_PREFIX);
}

/** The fact a retraction retracts. */
export function retractedFactTextV1(text: string): string {
  return text.slice(MEMORY_FORGOTTEN_PREFIX.length).trim();
}

/** The retraction line for one fact. */
export function memoryRetractionTextV1(text: string): string {
  return `${MEMORY_FORGOTTEN_PREFIX}${text.trim()}`;
}

/**
 * Newest-wins resolution within one tier.
 *
 * "readers merge shards, newest fact wins on conflict". Newest is the day
 * first and the minted generation id second, because two Bots writing the same
 * fact on the same day still have an order — the generation ledger's — and
 * ordering by text or by shard would make the answer depend on the listing.
 *
 * A retraction is a fact like any other in that ordering: when the newest
 * entry for a key is `[forgotten] …`, the fact is gone; when a later
 * assertion follows it, the fact is back.
 */
export function resolveMemoryFactsV1(
  facts: SourcedMemoryFactV1[],
): SourcedMemoryFactV1[] {
  const newest = new Map<string, SourcedMemoryFactV1>();
  for (const fact of facts) {
    const asserted = isMemoryRetractionV1(fact.text)
      ? retractedFactTextV1(fact.text)
      : fact.text;
    const key = memoryFactKeyV1(asserted);
    const current = newest.get(key);
    if (!current || isNewerMemoryFactV1(fact, current)) newest.set(key, fact);
  }
  return [...newest.values()].filter(
    (fact) => !isMemoryRetractionV1(fact.text),
  );
}

/** Strictly newer: by day, then by the minted generation id. */
export function isNewerMemoryFactV1(
  candidate: SourcedMemoryFactV1,
  current: SourcedMemoryFactV1,
): boolean {
  if (candidate.date !== current.date) return candidate.date > current.date;
  return candidate.generationId > current.generationId;
}

/** Newest first: the order every rendered block lists facts in. */
export function sortMemoryFactsV1(
  facts: SourcedMemoryFactV1[],
): SourcedMemoryFactV1[] {
  return [...facts].sort((left, right) =>
    isNewerMemoryFactV1(left, right) ? -1 : 1,
  );
}

/** The injected line: `- (learned YYYY-MM-DD) [via <bot>] <fact>`. */
export function renderInjectedFactLineV1(
  fact: { date: string; text: string; via?: string },
  clamp: number,
): string {
  const via = fact.via ? `[via ${fact.via}] ` : "";
  const text =
    fact.text.length > clamp ? `${fact.text.slice(0, clamp - 1)}…` : fact.text;
  return `- (learned ${fact.date}) ${via}${text}`;
}
