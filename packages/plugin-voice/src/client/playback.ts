/** PCM16LE playback for Gemini Live's 24 kHz output. */
export interface VoicePlaybackV1 {
  play(pcm16: ArrayBuffer): void;
  interrupt(): void;
  close(): Promise<void>;
}

interface AudioContextLikeV1 {
  currentTime: number;
  destination: AudioDestinationNode;
  state: AudioContextState;
  createBuffer(
    channels: number,
    length: number,
    sampleRate: number,
  ): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
  resume(): Promise<void>;
  close(): Promise<void>;
}

export function pcm16LeToFloat32V1(input: ArrayBuffer): Float32Array {
  const view = new DataView(input);
  const result = new Float32Array(Math.floor(input.byteLength / 2));
  for (let index = 0; index < result.length; index += 1) {
    result[index] = view.getInt16(index * 2, true) / 32_768;
  }
  return result;
}

export function createVoicePlaybackV1(
  context: AudioContextLikeV1 = new AudioContext(),
  sampleRate = 24_000,
): VoicePlaybackV1 {
  const playing = new Set<AudioBufferSourceNode>();
  let nextAt = 0;
  let closed = false;
  if (context.state === "suspended") void context.resume();

  return {
    play(pcm16) {
      if (closed || pcm16.byteLength < 2) return;
      const samples = pcm16LeToFloat32V1(pcm16);
      const buffer = context.createBuffer(1, samples.length, sampleRate);
      const channel = buffer.getChannelData(0);
      for (let index = 0; index < samples.length; index += 1) {
        channel[index] = samples[index] ?? 0;
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const startAt = Math.max(context.currentTime, nextAt);
      nextAt = startAt + buffer.duration;
      playing.add(source);
      source.onended = () => {
        playing.delete(source);
        source.disconnect();
      };
      source.start(startAt);
    },
    interrupt() {
      nextAt = context.currentTime;
      for (const source of playing) {
        try {
          source.stop();
        } catch {
          // It may have ended between enumeration and stop.
        }
      }
      playing.clear();
    },
    async close() {
      if (closed) return;
      closed = true;
      this.interrupt();
      await context.close().catch(() => undefined);
    },
  };
}
