// Chromium's fake microphone, playing a guitar's A string twelve cents flat,
// for a spec whose page listens: a tuner naming the note proves the rate and
// the encoding the host hands the page are the ones it says.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const A_STRING_HZ = 110 * 2 ** (-12 / 1200);

/** A sustained string as 16-bit mono WAV, whole cycles so its loop is seamless. */
function stringRecording(frequency: number): string {
  const rate = 48_000;
  const cycles = Math.round(frequency * 2);
  const length = Math.round((cycles * rate) / frequency);
  const wav = Buffer.alloc(44 + length * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + length * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(length * 2, 40);
  for (let i = 0; i < length; i++) {
    const phase = (2 * Math.PI * cycles * i) / length;
    const sample =
      0.3 * Math.sin(phase) +
      0.15 * Math.sin(2 * phase) +
      0.08 * Math.sin(3 * phase);
    wav.writeInt16LE(Math.round(sample * 32_767), 44 + i * 2);
  }
  const path = join(tmpdir(), "frockbot-e2e-a-string.wav");
  writeFileSync(path, wav);
  return path;
}

/** The launch options that make the fake microphone play that string. */
export function hearingAnAString() {
  return {
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
        `--use-file-for-fake-audio-capture=${stringRecording(A_STRING_HZ)}`,
      ],
    },
  };
}
