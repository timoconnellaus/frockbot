// A speech provider that refuses to be silent.
//
// The ElevenLabs adapter answers a refused or failed request — a bad key, a
// spent quota, a dropped connection — by logging and yielding nothing, so from
// the pipeline's side a sentence that never became sound is indistinguishable
// from one that did: the turn settles as answered and the person hears
// nothing. This wrapper turns an empty answer into a thrown error, which the
// voice SDK already knows what to do with: it tells the client, and carries
// on with the next sentence. An aborted request (a barge-in) is not a failure
// and stays quiet.

export interface VoiceSpeechProviderV1 {
  synthesize(text: string, signal?: AbortSignal): Promise<ArrayBuffer | null>;
  synthesizeStream?(
    text: string,
    signal?: AbortSignal,
  ): AsyncIterable<ArrayBuffer>;
}

export class VoiceSynthesisSilentErrorV1 extends Error {
  readonly chars: number;
  constructor(chars: number) {
    super("speech synthesis produced no audio");
    this.name = "VoiceSynthesisSilentErrorV1";
    this.chars = chars;
  }
}

/**
 * Wraps `inner` so that a sentence answered with no audio throws instead of
 * returning. `onSilent` is told first, with the sentence, so the host can
 * write its own record of which reply went unheard.
 */
export function guardSpeechProviderV1(
  inner: VoiceSpeechProviderV1,
  onSilent?: (text: string) => void,
): VoiceSpeechProviderV1 {
  const silent = (text: string): never => {
    onSilent?.(text);
    throw new VoiceSynthesisSilentErrorV1(text.length);
  };
  const guarded: VoiceSpeechProviderV1 = {
    async synthesize(text, signal) {
      const audio = await inner.synthesize(text, signal);
      if (signal?.aborted) return audio;
      if (!audio || audio.byteLength === 0) return silent(text);
      return audio;
    },
  };
  const stream = inner.synthesizeStream?.bind(inner);
  if (stream) {
    guarded.synthesizeStream = async function* (text, signal) {
      let bytes = 0;
      for await (const chunk of stream(text, signal)) {
        bytes += chunk.byteLength;
        yield chunk;
      }
      if (bytes === 0 && !signal?.aborted) silent(text);
    };
  }
  return guarded;
}
