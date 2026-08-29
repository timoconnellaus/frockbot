export interface ComposerSubmissionToken {
  generation: number;
  context: unknown;
  text: string;
}

export class ComposerDraftStore {
  readonly #drafts = new Map<unknown, string>();
  readonly #generations = new Map<unknown, number>();

  draftFor(context: unknown): string {
    return this.#drafts.get(context) ?? "";
  }

  setDraft(context: unknown, draft: string): void {
    this.#drafts.set(context, draft);
  }

  begin(context: unknown, text: string): ComposerSubmissionToken {
    const generation = (this.#generations.get(context) ?? 0) + 1;
    this.#generations.set(context, generation);
    this.#drafts.set(context, "");
    return { generation, context, text };
  }

  reject(token: ComposerSubmissionToken): string | undefined {
    if (this.#generations.get(token.context) !== token.generation) {
      return undefined;
    }
    const existing = this.draftFor(token.context);
    const restored = existing ? `${token.text}\n\n${existing}` : token.text;
    this.#drafts.set(token.context, restored);
    return restored;
  }
}
