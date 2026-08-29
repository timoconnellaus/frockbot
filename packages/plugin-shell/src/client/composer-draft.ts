export interface ComposerSubmissionToken {
  generation: number;
  botProjection: unknown;
}

export class ComposerDraftFence {
  #generation = 0;

  begin(botProjection: unknown): ComposerSubmissionToken {
    this.#generation += 1;
    return { generation: this.#generation, botProjection };
  }

  canRestore(
    token: ComposerSubmissionToken,
    currentBotProjection: unknown,
    currentDraft: string,
  ): boolean {
    return (
      token.generation === this.#generation &&
      token.botProjection === currentBotProjection &&
      currentDraft === ""
    );
  }
}
