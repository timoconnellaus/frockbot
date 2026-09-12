import { describe, expect, test } from "bun:test";
import {
  guardSpeechProviderV1,
  VoiceSynthesisSilentErrorV1,
  type VoiceSpeechProviderV1,
} from "./tts-guard.js";

async function collect(
  iterable: AsyncIterable<ArrayBuffer>,
): Promise<ArrayBuffer[]> {
  const out: ArrayBuffer[] = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

describe("the speech guard", () => {
  test("passes audio through untouched", async () => {
    const chunks = [new ArrayBuffer(4), new ArrayBuffer(8)];
    const inner: VoiceSpeechProviderV1 = {
      synthesize: async () => new ArrayBuffer(16),
      synthesizeStream: async function* () {
        yield* chunks;
      },
    };
    const guarded = guardSpeechProviderV1(inner);
    expect((await guarded.synthesize("Hello."))?.byteLength).toBe(16);
    expect(await collect(guarded.synthesizeStream!("Hello."))).toEqual(chunks);
  });

  test("a stream that yields nothing throws, after telling the host", async () => {
    const silent: string[] = [];
    const guarded = guardSpeechProviderV1(
      {
        synthesize: async () => null,
        synthesizeStream: async function* () {},
      },
      (text) => silent.push(text),
    );
    const streamed = await collect(
      guarded.synthesizeStream!("Right away."),
    ).catch((e) => e);
    expect(streamed).toBeInstanceOf(VoiceSynthesisSilentErrorV1);
    expect(silent).toEqual(["Right away."]);
    const error = await guarded.synthesize("Right away.").catch((e) => e);
    expect(error).toBeInstanceOf(VoiceSynthesisSilentErrorV1);
    expect((error as VoiceSynthesisSilentErrorV1).chars).toBe(11);
  });

  test("an aborted request is not a failure", async () => {
    const silent: string[] = [];
    const controller = new AbortController();
    const guarded = guardSpeechProviderV1(
      {
        synthesize: async () => null,
        synthesizeStream: async function* (_text, signal) {
          controller.abort();
          void signal;
        },
      },
      (text) => silent.push(text),
    );
    expect(
      await collect(guarded.synthesizeStream!("Hello.", controller.signal)),
    ).toEqual([]);
    expect(await guarded.synthesize("Hello.", controller.signal)).toBeNull();
    expect(silent).toEqual([]);
  });

  test("a provider without streaming stays without it", () => {
    const guarded = guardSpeechProviderV1({ synthesize: async () => null });
    expect(guarded.synthesizeStream).toBeUndefined();
  });
});
