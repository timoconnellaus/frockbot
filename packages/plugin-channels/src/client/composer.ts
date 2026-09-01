// The Channel composer, as a store with no framework in it.
//
// The same shape `plugin-shell`'s `ComposerDraftStore` has, for the same
// reason: a submission that is refused must not lose what the person typed,
// and a draft belongs to the room it was typed in rather than to whichever
// room happens to be open when the answer comes back. A Channel adds one
// thing a Bot's chat does not have — the room can be closed, and a post to a
// closed room is refused — so the store carries the refusal as state the
// surface renders rather than as an exception the caller may or may not catch.
//
// Nothing here is reactive and nothing here talks to a transport. It is a
// reducer over "what has the person typed, what is in flight, and what came
// back", which is what makes it testable without a DOM.

/** One submission in flight, and the draft it took with it. */
export interface ChannelSubmissionV1 {
  channelId: string;
  generation: number;
  text: string;
  /** The idempotency key the post carries. Stable across a retry. */
  commandId: string;
}

export class ChannelComposerStore {
  readonly #drafts = new Map<string, string>();
  readonly #generations = new Map<string, number>();
  readonly #inFlight = new Map<string, ChannelSubmissionV1>();
  readonly #failures = new Map<string, string>();
  readonly #newCommandId: () => string;

  constructor(options: { newCommandId?(): string } = {}) {
    this.#newCommandId =
      options.newCommandId ?? (() => crypto.randomUUID() as string);
  }

  draftFor(channelId: string): string {
    return this.#drafts.get(channelId) ?? "";
  }

  setDraft(channelId: string, draft: string): void {
    this.#drafts.set(channelId, draft);
    // Typing is the person's answer to a refusal; the message goes with it.
    this.#failures.delete(channelId);
  }

  failureFor(channelId: string): string | undefined {
    return this.#failures.get(channelId);
  }

  /** True while a post for this room has been begun and not yet settled. */
  busy(channelId: string): boolean {
    return this.#inFlight.has(channelId);
  }

  /**
   * Take the draft and hand back the token the post is made under.
   *
   * The draft is cleared here, not when the post succeeds: the person has sent
   * it, and a composer that kept the text until the round trip finished would
   * send it twice on a double return. `reject` is what puts it back.
   *
   * A second `begin` for a room that is already posting is refused rather than
   * queued — one composer, one message in flight — and returns nothing.
   */
  begin(channelId: string, text: string): ChannelSubmissionV1 | undefined {
    if (this.#inFlight.has(channelId)) return undefined;
    const trimmed = text.trim();
    if (trimmed.length === 0) return undefined;
    const generation = (this.#generations.get(channelId) ?? 0) + 1;
    this.#generations.set(channelId, generation);
    this.#drafts.set(channelId, "");
    this.#failures.delete(channelId);
    const submission: ChannelSubmissionV1 = {
      channelId,
      generation,
      text: trimmed,
      commandId: this.#newCommandId(),
    };
    this.#inFlight.set(channelId, submission);
    return submission;
  }

  /** The post landed. Nothing is restored; the thread carries the message. */
  settle(submission: ChannelSubmissionV1): void {
    if (this.#inFlight.get(submission.channelId) !== submission) return;
    this.#inFlight.delete(submission.channelId);
  }

  /**
   * The post was refused. The text comes back into the room it was typed in,
   * ahead of anything typed since, and the reason is rendered beside it.
   *
   * A stale token — one whose room has since started a newer submission —
   * restores nothing and reports nothing: the person has moved on, and putting
   * an older message back over a newer one is the one thing a composer must
   * never do.
   */
  reject(submission: ChannelSubmissionV1, reason: string): string | undefined {
    if (this.#generations.get(submission.channelId) !== submission.generation) {
      return undefined;
    }
    if (this.#inFlight.get(submission.channelId) === submission) {
      this.#inFlight.delete(submission.channelId);
    }
    const existing = this.draftFor(submission.channelId);
    const restored = existing
      ? `${submission.text}\n\n${existing}`
      : submission.text;
    this.#drafts.set(submission.channelId, restored);
    this.#failures.set(submission.channelId, reason);
    return restored;
  }
}
