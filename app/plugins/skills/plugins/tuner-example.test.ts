// The guitar tuner the plugins Skill teaches (`references/microphone.md`) is
// run here as written: its page script, fed plucked strings through the same
// `openMicrophone` a page gets, must name each string and how far off it is.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const reference = readFileSync(
  new URL("./references/microphone.md", import.meta.url),
  "utf8",
);

function tunerScript(): string {
  const html = /```html\n([\s\S]*?)```/.exec(reference)?.[1];
  const script = html && /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!script) throw new Error("microphone.md has no tuner page script");
  return script;
}

/** A page with the tuner's elements, and a host that has opened the microphone. */
function runTuner() {
  const elements = new Map<string, Record<string, unknown>>();
  const element = (id: string) => {
    let found = elements.get(id);
    if (!found) {
      const classes = new Set<string>();
      found = {
        textContent: "",
        style: {},
        dataset: {},
        classList: {
          toggle: (name: string, on: boolean) =>
            on ? classes.add(name) : classes.delete(name),
          contains: (name: string) => classes.has(name),
        },
      };
      elements.set(id, found);
    }
    return found;
  };
  let hear: ((samples: Float32Array) => void) | undefined;
  const frockbot = {
    ready: Promise.resolve({ state: { a4: 440 } }),
    openMicrophone(onSamples: (samples: Float32Array) => void) {
      hear = onSamples;
      return Promise.resolve({ sampleRate: 16000, close() {} });
    },
  };
  new Function("document", "frockbot", tunerScript())(
    { getElementById: element },
    frockbot,
  );
  return {
    async listen() {
      await (element("listen").onclick as () => Promise<void>)();
    },
    play(frequency: number, detuneCents = 0) {
      const f = frequency * 2 ** (detuneCents / 1200);
      // Forty-millisecond frames, the way the host sends them, for a quarter
      // second: a fundamental with the harmonics a plucked string carries.
      for (let frame = 0; frame < 7; frame += 1) {
        const samples = new Float32Array(640);
        for (let i = 0; i < samples.length; i += 1) {
          const t = (frame * 640 + i) / 16000;
          samples[i] =
            0.5 * Math.sin(2 * Math.PI * f * t) +
            0.3 * Math.sin(2 * Math.PI * 2 * f * t) +
            0.15 * Math.sin(2 * Math.PI * 3 * f * t);
        }
        hear!(samples);
      }
    },
    text: (id: string) => String(element(id).textContent),
    frames: () =>
      Number((element("status").dataset as Record<string, string>).frames),
  };
}

describe("the tuner the Skill teaches", () => {
  const strings = {
    E2: 82.41,
    A2: 110,
    D3: 146.83,
    G3: 196,
    B3: 246.94,
    E4: 329.63,
  };

  for (const [name, frequency] of Object.entries(strings)) {
    test(`names ${name} in tune, and 20 cents flat when it is`, async () => {
      const tuner = runTuner();
      await tuner.listen();
      expect(tuner.text("status")).toBe("Listening.");
      tuner.play(frequency);
      expect(tuner.text("note")).toBe(name);
      expect(tuner.text("cents")).toBe("In tune");
      const flat = runTuner();
      await flat.listen();
      flat.play(frequency, -20);
      expect(flat.text("note")).toBe(name);
      expect(flat.text("cents")).toMatch(/^(1[7-9]|2[0-3]) cents flat$/);
    });
  }

  test("says nothing for silence", async () => {
    const tuner = runTuner();
    await tuner.listen();
    tuner.play(0);
    expect(tuner.frames()).toBe(7);
    // Nothing was written over the page's own placeholder.
    expect(tuner.text("note")).toBe("");
  });
});
