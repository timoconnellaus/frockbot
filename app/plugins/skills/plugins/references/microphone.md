# Microphone

A page may listen. The host opens the microphone — never the page — and
hands the page 16 kHz mono samples while it is on screen. Ask for it in
`plugin.json`; the User approves it on the Plugin's card, and the device asks
once on first use:

```json
"grants": ["device"],
"device": { "abilities": ["microphone"] },
"views": [
  { "slot": "conversation.panel", "surfaceId": "tuner", "label": "Tuner", "page": "tuner.html" }
]
```

`device` needs a `conversation.panel` view that names a page. In the page:

```js
const mic = await frockbot.openMicrophone(
  (samples) => {
    /* a Float32Array of -1..1, about 40 ms at a time */
  },
  (reason) => {
    /* the host closed it: the person pressed Stop, left the panel, or
       started dictation or a call */
  },
);
// mic.sampleRate is 16000. mic.close() gives it back.
```

`openMicrophone` rejects with the reason when the User did not approve it,
the device refused, or voice or dictation holds the microphone. Open it from
a button the person presses, not on load. While it is open the host shows
"<your tab> is using the microphone" with a Stop control above your page;
you draw nothing of that yourself.

The audio stays on the device. The page reaches no network; the only way
anything it hears leaves is a `frockbot.callTool` you write, and the card
says so.

## A guitar tuner, whole

`plugin.json`:

```json
{
  "id": "tuner",
  "displayName": "Tuner",
  "version": "1.0.0",
  "contractVersion": 7,
  "tools": [],
  "hooks": [],
  "grants": ["device"],
  "device": { "abilities": ["microphone"] },
  "views": [
    {
      "slot": "conversation.panel",
      "surfaceId": "tuner",
      "label": "Tuner",
      "page": "tuner.html"
    }
  ],
  "contextKeys": ["user", "bot", "session"]
}
```

`plugin.ts`:

```ts
import type { PluginExecute, PluginTool } from "@frockbot/applet-sdk/plugin";

export const tools: PluginTool[] = [];

export const execute: PluginExecute = async (tool) => {
  throw new Error(`unknown tool ${tool}`);
};

export const views = {
  tuner: () => ({ a4: 440 }),
};
```

`tuner.html` finds the pitch with YIN on a 2048-sample window and shows the
nearest note, how many cents off it is, and a needle:

```html
<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body {
        margin: 0;
        padding: 24px 16px;
        font: var(--frockbot-text-base) var(--frockbot-font-sans);
        color: var(--frockbot-text);
        background: var(--frockbot-surface);
        text-align: center;
      }
      #note {
        font-size: 64px;
        font-weight: 700;
        line-height: 1.1;
      }
      #cents {
        color: var(--frockbot-text-muted);
        min-height: 1.5em;
      }
      #dial {
        position: relative;
        height: 64px;
        margin: 24px auto;
        max-width: 320px;
        border-bottom: 1px solid var(--frockbot-border);
      }
      #needle {
        position: absolute;
        left: 50%;
        bottom: 0;
        width: 3px;
        height: 60px;
        background: var(--frockbot-accent);
        transform-origin: bottom center;
        transition: transform var(--frockbot-motion-fast) ease-out;
      }
      #needle.in-tune {
        background: var(--frockbot-text);
      }
      button {
        font: inherit;
        padding: 10px 20px;
        border: 0;
        border-radius: var(--frockbot-radius-control);
        background: var(--frockbot-accent);
        color: var(--frockbot-on-accent);
      }
    </style>
  </head>
  <body>
    <div id="note">–</div>
    <div id="cents">Press Listen and play a string.</div>
    <div id="dial"><div id="needle"></div></div>
    <button id="listen">Listen</button>
    <p id="status" data-frames="0"></p>
    <script>
      const NAMES = [
        "C",
        "C♯",
        "D",
        "D♯",
        "E",
        "F",
        "F♯",
        "G",
        "G♯",
        "A",
        "A♯",
        "B",
      ];
      const WINDOW = 2048;
      let a4 = 440;
      let mic = null;
      let frames = 0;
      const buffer = new Float32Array(WINDOW);
      let filled = 0;

      function detectPitch(samples, sampleRate) {
        const maxTau = Math.min(
          Math.floor(sampleRate / 60),
          samples.length >> 1,
        );
        const minTau = Math.max(2, Math.floor(sampleRate / 1400));
        const size = samples.length - maxTau;
        let energy = 0;
        for (const x of samples) energy += x * x;
        if (Math.sqrt(energy / samples.length) < 0.01) return null;
        const diff = new Float32Array(maxTau + 1);
        for (let tau = 1; tau <= maxTau; tau++) {
          let sum = 0;
          for (let i = 0; i < size; i++) {
            const d = samples[i] - samples[i + tau];
            sum += d * d;
          }
          diff[tau] = sum;
        }
        let running = 0;
        let tau = -1;
        const cmnd = new Float32Array(maxTau + 1);
        for (let t = 1; t <= maxTau; t++) {
          running += diff[t];
          cmnd[t] = running === 0 ? 1 : (diff[t] * t) / running;
        }
        for (let t = minTau; t <= maxTau; t++) {
          if (cmnd[t] < 0.12) {
            while (t + 1 <= maxTau && cmnd[t + 1] < cmnd[t]) t++;
            tau = t;
            break;
          }
        }
        if (tau < 0) return null;
        const x0 = cmnd[tau - 1];
        const x2 = tau < maxTau ? cmnd[tau + 1] : cmnd[tau];
        const denom = 2 * (2 * cmnd[tau] - x2 - x0);
        return sampleRate / (denom === 0 ? tau : tau + (x2 - x0) / denom);
      }

      function show(frequency) {
        const midi = 69 + 12 * Math.log2(frequency / a4);
        const nearest = Math.round(midi);
        const cents = Math.round((midi - nearest) * 100);
        const name =
          NAMES[((nearest % 12) + 12) % 12] + (Math.floor(nearest / 12) - 1);
        document.getElementById("note").textContent = name;
        document.getElementById("cents").textContent =
          Math.abs(cents) <= 3
            ? "In tune"
            : cents < 0
              ? `${-cents} cents flat`
              : `${cents} cents sharp`;
        const needle = document.getElementById("needle");
        needle.style.transform = `rotate(${Math.max(-50, Math.min(50, cents)) * 0.9}deg)`;
        needle.classList.toggle("in-tune", Math.abs(cents) <= 3);
      }

      function hear(samples, sampleRate) {
        frames += 1;
        document.getElementById("status").dataset.frames = String(frames);
        const keep = Math.max(0, WINDOW - samples.length);
        buffer.copyWithin(0, WINDOW - keep);
        buffer.set(
          samples.subarray(Math.max(0, samples.length - WINDOW)),
          keep,
        );
        filled = Math.min(WINDOW, filled + samples.length);
        if (filled < WINDOW) return;
        const frequency = detectPitch(buffer, sampleRate);
        if (frequency) show(frequency);
      }

      function stopped(reason) {
        mic = null;
        document.getElementById("listen").textContent = "Listen";
        document.getElementById("status").textContent = reason;
      }

      frockbot.ready.then(({ state }) => {
        if (typeof state.a4 === "number") a4 = state.a4;
      });

      document.getElementById("listen").onclick = async () => {
        if (mic) {
          mic.close();
          stopped("Stopped.");
          return;
        }
        try {
          let rate = 16000;
          mic = await frockbot.openMicrophone(
            (samples) => hear(samples, rate),
            stopped,
          );
          rate = mic.sampleRate;
          document.getElementById("listen").textContent = "Stop";
          document.getElementById("status").textContent = "Listening.";
        } catch (error) {
          stopped(error.message);
        }
      };
    </script>
  </body>
</html>
```
