// A hand-run probe against the real Gemini Live API. It is never part of CI: it
// spends money and needs a key. It exists so the adapter in
// `app/voice/gemini-live.ts` is written against observed wire shapes rather
// than remembered ones, and so `docs/voice-gemini-probe.md` can quote them.
//
//   bun apps/cloudflare/test/voice-gemini-probe.ts            # every scenario
//   bun apps/cloudflare/test/voice-gemini-probe.ts setup text # named ones
//
// The key is read from apps/cloudflare/.dev.vars (gitignored) and is never
// printed: every log line goes through `redact`.

import { readFileSync } from "node:fs";

const MODEL_V1 = "models/gemini-3.8-live";
const ENDPOINT_V1 =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

function readApiKeyV1(): string {
  // Relative to this file, not to the working directory: the probe is run by
  // hand from wherever the person happens to be.
  const path = new URL("../.dev.vars", import.meta.url);
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("GEMINI_API_KEY=")) continue;
    const value = trimmed.slice("GEMINI_API_KEY=".length).trim();
    // .dev.vars values may be quoted; wrangler strips the quotes, so do we.
    return value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
  throw new Error("GEMINI_API_KEY is not in apps/cloudflare/.dev.vars");
}

const API_KEY_V1 = readApiKeyV1();

/** Never let the key reach stdout, however it got into a string. */
function redact(text: string): string {
  return API_KEY_V1.length > 0 ? text.split(API_KEY_V1).join("<key>") : text;
}

function log(...parts: unknown[]): void {
  const line = parts
    .map((part) => (typeof part === "string" ? part : JSON.stringify(part)))
    .join(" ");
  console.log(redact(line));
}

/** Server audio is huge; keep the shape, drop the bytes. */
function summarise(value: unknown, depth = 0): unknown {
  if (Array.isArray(value))
    return value.map((item) => summarise(item, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (key === "data" && typeof item === "string") {
        out[key] = `<${item.length} b64 chars>`;
        continue;
      }
      out[key] = summarise(item, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 220) {
    return `${value.slice(0, 220)}…`;
  }
  return value;
}

type ServerMessage = Record<string, unknown>;

class ProbeSession {
  readonly received: ServerMessage[] = [];
  private socket: WebSocket | undefined;
  private waiters: Array<{
    match: (message: ServerMessage) => boolean;
    resolve: (message: ServerMessage) => void;
  }> = [];
  closed: { code: number; reason: string } | undefined;

  async open(): Promise<void> {
    const socket = new WebSocket(`${ENDPOINT_V1}?key=${API_KEY_V1}`);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    await new Promise<void>((resolveOpen, rejectOpen) => {
      socket.addEventListener("open", () => resolveOpen(), { once: true });
      socket.addEventListener(
        "error",
        () => rejectOpen(new Error("socket error before open")),
        { once: true },
      );
    });
    socket.addEventListener("message", (event) => {
      void this.onMessage(event.data);
    });
    socket.addEventListener("close", (event) => {
      this.closed = { code: event.code, reason: redact(event.reason ?? "") };
      log("[close]", JSON.stringify(this.closed));
    });
  }

  private async onMessage(data: unknown): Promise<void> {
    let text: string;
    if (typeof data === "string") text = data;
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
    else if (data instanceof Blob) text = await data.text();
    else text = String(data);
    let parsed: ServerMessage;
    try {
      parsed = JSON.parse(text) as ServerMessage;
    } catch {
      log("[non-json]", text.slice(0, 400));
      return;
    }
    this.received.push(parsed);
    log("<-", JSON.stringify(summarise(parsed)));
    this.waiters = this.waiters.filter((waiter) => {
      if (!waiter.match(parsed)) return true;
      waiter.resolve(parsed);
      return false;
    });
  }

  send(message: unknown): void {
    const text = JSON.stringify(message);
    log("->", JSON.stringify(summarise(JSON.parse(text))));
    this.socket?.send(text);
  }

  /** Same as `send` but without echoing the frame (used for audio floods). */
  sendQuiet(message: unknown): void {
    this.socket?.send(JSON.stringify(message));
  }

  wait(
    match: (message: ServerMessage) => boolean,
    timeoutMs = 20_000,
  ): Promise<ServerMessage | undefined> {
    const already = this.received.find(match);
    if (already) return Promise.resolve(already);
    return new Promise((resolveWait) => {
      const waiter = { match, resolve: resolveWait };
      this.waiters.push(waiter);
      setTimeout(() => {
        this.waiters = this.waiters.filter((entry) => entry !== waiter);
        resolveWait(undefined);
      }, timeoutMs);
    });
  }

  async settle(ms: number): Promise<void> {
    await new Promise((done) => setTimeout(done, ms));
  }

  close(): void {
    this.socket?.close();
  }
}

function has(message: ServerMessage, path: string): boolean {
  let cursor: unknown = message;
  for (const key of path.split(".")) {
    if (cursor === null || typeof cursor !== "object") return false;
    cursor = (cursor as Record<string, unknown>)[key];
    if (cursor === undefined) return false;
  }
  return true;
}

/** 16 kHz mono PCM16: a 440 Hz tone, which is enough to make VAD notice. */
function toneV1(ms: number, hz = 440): string {
  const samples = Math.round((16_000 * ms) / 1000);
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(
      Math.sin((2 * Math.PI * hz * index) / 16_000) * 8000,
    );
    view.setInt16(index * 2, value, true);
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function silenceV1(ms: number): string {
  const samples = Math.round((16_000 * ms) / 1000);
  // A literal NUL in source does not survive the formatter, so build it.
  const quiet = String.fromCharCode(0);
  let binary = "";
  for (let index = 0; index < samples * 2; index += 1) binary += quiet;
  return btoa(binary);
}

const BASE_SETUP_V1 = {
  model: MODEL_V1,
  generationConfig: {
    responseModalities: ["AUDIO"],
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } },
    },
  },
  systemInstruction: {
    parts: [
      {
        text: "You are a probe target. Answer in one short sentence. Always speak English.",
      },
    ],
  },
  outputAudioTranscription: {},
  inputAudioTranscription: {},
  sessionResumption: {},
};

const FUNCTION_DECLARATIONS_V1 = [
  {
    name: "subagent",
    description:
      "Hand off anything that will take more than a moment, then carry on talking.",
    parameters: {
      type: "OBJECT",
      properties: {
        request: { type: "STRING", description: "What to hand off." },
      },
      required: ["request"],
    },
    behavior: "NON_BLOCKING",
  },
  {
    name: "status",
    description: "Say what the Bot is working on right now.",
    parameters: { type: "OBJECT", properties: {} },
  },
];

// --- scenarios ----------------------------------------------------------

async function scenarioSetup(): Promise<void> {
  log("\n=== setup: full option set ===");
  const session = new ProbeSession();
  await session.open();
  session.send({
    setup: {
      ...BASE_SETUP_V1,
      generationConfig: {
        ...BASE_SETUP_V1.generationConfig,
        enableAffectiveDialog: true,
      },
      tools: [
        { googleSearch: {} },
        { functionDeclarations: FUNCTION_DECLARATIONS_V1 },
      ],
    },
  });
  const complete = await session.wait(
    (message) => has(message, "setupComplete"),
    15_000,
  );
  log("setupComplete:", complete ? JSON.stringify(complete) : "NONE");
  await session.settle(1500);
  session.close();
}

async function scenarioAffectiveTopLevel(): Promise<void> {
  log(
    "\n=== setup: enableAffectiveDialog at the top level (not in generationConfig) ===",
  );
  const session = new ProbeSession();
  await session.open();
  session.send({ setup: { ...BASE_SETUP_V1, enableAffectiveDialog: true } });
  await session.wait((message) => has(message, "setupComplete"), 15_000);
  await session.settle(1500);
  session.close();
}

async function scenarioLanguageCode(): Promise<void> {
  log("\n=== setup: does speechConfig.languageCode get rejected? ===");
  const session = new ProbeSession();
  await session.open();
  session.send({
    setup: {
      ...BASE_SETUP_V1,
      generationConfig: {
        ...BASE_SETUP_V1.generationConfig,
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } },
          languageCode: "en-US",
        },
      },
    },
  });
  await session.wait(
    (message) => has(message, "setupComplete") || has(message, "error"),
    15_000,
  );
  await session.settle(2000);
  log("closed:", JSON.stringify(session.closed ?? "still open"));
  session.close();
}

/**
 * The one field production sends that no other scenario does. Every real
 * call's setup carries it, so a rejection here is every call — and because
 * `enableAffectiveDialog` was accepted at setup and only failed on the first
 * content frame, the turn afterwards is part of the check.
 */
async function scenarioCompression(): Promise<void> {
  log("\n=== setup: contextWindowCompression.slidingWindow ===");
  const session = new ProbeSession();
  await session.open();
  session.send({
    setup: {
      ...BASE_SETUP_V1,
      contextWindowCompression: { slidingWindow: {} },
    },
  });
  const complete = await session.wait(
    (message) => has(message, "setupComplete"),
    15_000,
  );
  log("setupComplete:", complete ? JSON.stringify(complete) : "NONE");
  log("closed after setup:", JSON.stringify(session.closed ?? "still open"));
  session.send({
    clientContent: {
      turns: [
        {
          role: "user",
          parts: [{ text: "Say the word hello and nothing else." }],
        },
      ],
      turnComplete: true,
    },
  });
  await session.wait(
    (message) => has(message, "serverContent.turnComplete"),
    30_000,
  );
  await session.settle(2500);
  const modelAudio = session.received.filter((message) =>
    has(message, "serverContent.modelTurn"),
  );
  log("model audio frames:", modelAudio.length);
  log("closed:", JSON.stringify(session.closed ?? "still open"));
  session.close();
}

async function scenarioText(): Promise<void> {
  log("\n=== clientContent text turn -> audio + transcription + usage ===");
  const session = new ProbeSession();
  await session.open();
  session.send({
    setup: {
      ...BASE_SETUP_V1,
      generationConfig: {
        ...BASE_SETUP_V1.generationConfig,
        enableAffectiveDialog: true,
      },
    },
  });
  await session.wait((message) => has(message, "setupComplete"), 15_000);
  session.send({
    clientContent: {
      turns: [
        {
          role: "user",
          parts: [{ text: "Say the word hello and nothing else." }],
        },
      ],
      turnComplete: true,
    },
  });
  await session.wait(
    (message) => has(message, "serverContent.turnComplete"),
    30_000,
  );
  await session.settle(2500);
  const audioParts = session.received.flatMap((message) => {
    const content = message.serverContent as
      Record<string, unknown> | undefined;
    const turn = content?.modelTurn as
      { parts?: Array<Record<string, unknown>> } | undefined;
    return (turn?.parts ?? []).flatMap((part) => {
      const inline = part.inlineData as
        { mimeType?: string; data?: string } | undefined;
      return inline ? [inline] : [];
    });
  });
  log("audio parts:", audioParts.length);
  log(
    "mimeTypes:",
    JSON.stringify([...new Set(audioParts.map((part) => part.mimeType))]),
  );
  const totalBytes = audioParts.reduce(
    (sum, part) => sum + Math.floor(((part.data ?? "").length * 3) / 4),
    0,
  );
  log(
    "decoded audio bytes:",
    totalBytes,
    "=>",
    totalBytes / 48_000,
    "s at 24 kHz",
  );
  log(
    "message keys seen:",
    JSON.stringify([
      ...new Set(session.received.flatMap((m) => Object.keys(m))),
    ]),
  );
  session.close();
}

async function scenarioAudio(): Promise<void> {
  log(
    "\n=== realtimeInput audio (16 kHz PCM) -> input transcription, VAD, interrupted ===",
  );
  const session = new ProbeSession();
  await session.open();
  session.send({ setup: BASE_SETUP_V1 });
  await session.wait((message) => has(message, "setupComplete"), 15_000);
  // 200 ms chunks, the same cadence the phone sends.
  for (let index = 0; index < 5; index += 1) {
    session.sendQuiet({
      realtimeInput: {
        audio: { data: toneV1(200), mimeType: "audio/pcm;rate=16000" },
      },
    });
    await session.settle(200);
  }
  log("-> 1 s of 440 Hz tone sent as 5 realtimeInput frames");
  for (let index = 0; index < 5; index += 1) {
    session.sendQuiet({
      realtimeInput: {
        audio: { data: silenceV1(200), mimeType: "audio/pcm;rate=16000" },
      },
    });
    await session.settle(200);
  }
  log("-> 1 s of silence sent (VAD end-of-speech)");
  await session.settle(8000);
  log("audioStreamEnd accepted?");
  session.send({ realtimeInput: { audioStreamEnd: true } });
  await session.settle(3000);
  session.close();
}

async function scenarioTools(): Promise<void> {
  log("\n=== toolCall / toolResponse scheduling / NON_BLOCKING ===");
  const session = new ProbeSession();
  await session.open();
  session.send({
    setup: {
      ...BASE_SETUP_V1,
      systemInstruction: {
        parts: [
          {
            text: "You are a probe target. When the person asks for anything that takes work, call the subagent tool immediately. Keep talking while it runs. Answer in one short sentence.",
          },
        ],
      },
      tools: [{ functionDeclarations: FUNCTION_DECLARATIONS_V1 }],
    },
  });
  await session.wait((message) => has(message, "setupComplete"), 15_000);
  session.send({
    clientContent: {
      turns: [
        {
          role: "user",
          parts: [
            {
              text: "Please research the history of the paperclip and write me a long report.",
            },
          ],
        },
      ],
      turnComplete: true,
    },
  });
  const call = await session.wait(
    (message) => has(message, "toolCall"),
    30_000,
  );
  if (!call) {
    log("no toolCall arrived");
    session.close();
    return;
  }
  const functionCalls = (
    call.toolCall as { functionCalls?: Array<Record<string, unknown>> }
  ).functionCalls;
  log("functionCalls:", JSON.stringify(functionCalls));
  // Wait a beat so the response is genuinely late, then answer WHEN_IDLE.
  await session.settle(6000);
  const first = functionCalls?.[0] ?? {};
  session.send({
    toolResponse: {
      functionResponses: [
        {
          id: first.id,
          name: first.name,
          response: { result: "The paperclip was patented in 1867." },
          scheduling: "WHEN_IDLE",
        },
      ],
    },
  });
  await session.settle(12_000);
  log("=== a bad scheduling value, to see the error shape ===");
  session.send({
    toolResponse: {
      functionResponses: [
        {
          id: first.id,
          name: first.name,
          response: { result: "again" },
          scheduling: "NOT_A_REAL_VALUE",
        },
      ],
    },
  });
  await session.settle(4000);
  log("closed:", JSON.stringify(session.closed ?? "still open"));
  session.close();
}

async function scenarioInterrupt(): Promise<void> {
  log(
    "\n=== barge-in: does activity during a model turn produce `interrupted`? ===",
  );
  const session = new ProbeSession();
  await session.open();
  session.send({ setup: BASE_SETUP_V1 });
  await session.wait((message) => has(message, "setupComplete"), 15_000);
  session.send({
    clientContent: {
      turns: [
        { role: "user", parts: [{ text: "Count slowly from one to forty." }] },
      ],
      turnComplete: true,
    },
  });
  await session.wait(
    (message) => has(message, "serverContent.modelTurn"),
    30_000,
  );
  await session.settle(1200);
  for (let index = 0; index < 6; index += 1) {
    session.sendQuiet({
      realtimeInput: {
        audio: { data: toneV1(200, 220), mimeType: "audio/pcm;rate=16000" },
      },
    });
    await session.settle(200);
  }
  log("-> barged in with 1.2 s of tone");
  await session.settle(8000);
  log(
    "interrupted seen:",
    session.received.some((message) =>
      has(message, "serverContent.interrupted"),
    ),
  );
  session.close();
}

async function scenarioResumption(): Promise<void> {
  log(
    "\n=== sessionResumption: get a handle, drop the socket, reconnect with it ===",
  );
  const first = new ProbeSession();
  await first.open();
  first.send({ setup: BASE_SETUP_V1 });
  await first.wait((message) => has(message, "setupComplete"), 15_000);
  first.send({
    clientContent: {
      turns: [
        {
          role: "user",
          parts: [{ text: "Remember the number 4291. Just say ok." }],
        },
      ],
      turnComplete: true,
    },
  });
  await first.wait(
    (message) => has(message, "serverContent.turnComplete"),
    30_000,
  );
  const update = await first.wait(
    (message) => has(message, "sessionResumptionUpdate"),
    20_000,
  );
  log(
    "sessionResumptionUpdate:",
    update ? JSON.stringify(summarise(update)) : "NONE",
  );
  const handle = (
    update?.sessionResumptionUpdate as
      { newHandle?: string; resumable?: boolean } | undefined
  )?.newHandle;
  first.close();
  if (!handle) {
    log("no handle, cannot test reconnect");
    return;
  }
  await new Promise((done) => setTimeout(done, 3000));
  const second = new ProbeSession();
  await second.open();
  second.send({ setup: { ...BASE_SETUP_V1, sessionResumption: { handle } } });
  await second.wait((message) => has(message, "setupComplete"), 15_000);
  second.send({
    clientContent: {
      turns: [
        {
          role: "user",
          parts: [{ text: "What number did I ask you to remember?" }],
        },
      ],
      turnComplete: true,
    },
  });
  await second.wait(
    (message) => has(message, "serverContent.turnComplete"),
    30_000,
  );
  await second.settle(2000);
  const transcripts = second.received.flatMap((message) => {
    const content = message.serverContent as
      Record<string, unknown> | undefined;
    const out = content?.outputTranscription as { text?: string } | undefined;
    return out?.text ? [out.text] : [];
  });
  log(
    "output transcription after resume:",
    JSON.stringify(transcripts.join("")),
  );
  second.close();
}

async function scenarioBadHandle(): Promise<void> {
  log("\n=== sessionResumption with an expired/garbage handle ===");
  const session = new ProbeSession();
  await session.open();
  session.send({
    setup: {
      ...BASE_SETUP_V1,
      sessionResumption: { handle: "not-a-real-handle" },
    },
  });
  await session.wait(
    (message) => has(message, "setupComplete") || has(message, "error"),
    15_000,
  );
  await session.settle(3000);
  log("closed:", JSON.stringify(session.closed ?? "still open"));
  session.close();
}

async function scenarioModels(): Promise<void> {
  log("\n=== which live models does this key see? ===");
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY_V1}&pageSize=200`,
  );
  const body = (await response.json()) as {
    models?: Array<{ name: string; supportedGenerationMethods?: string[] }>;
  };
  for (const model of body.models ?? []) {
    if (
      (model.supportedGenerationMethods ?? []).includes("bidiGenerateContent")
    ) {
      log(model.name, JSON.stringify(model.supportedGenerationMethods));
    }
  }
}

/**
 * The 1007 close is the only error the API gives for a malformed client frame,
 * and it names the field only sometimes. This walks candidate shapes one socket
 * at a time so the accepted one is unambiguous.
 */
async function scenarioVariants(): Promise<void> {
  const candidates: Array<{ label: string; setup: unknown; frame: unknown }> = [
    {
      label: "clientContent turns[role=user]",
      setup: BASE_SETUP_V1,
      frame: {
        clientContent: {
          turns: [{ role: "user", parts: [{ text: "Say hello." }] }],
          turnComplete: true,
        },
      },
    },
    {
      label: "clientContent turns[no role]",
      setup: BASE_SETUP_V1,
      frame: {
        clientContent: {
          turns: [{ parts: [{ text: "Say hello." }] }],
          turnComplete: true,
        },
      },
    },
    {
      label: "clientContent turnComplete only after turns sent separately",
      setup: BASE_SETUP_V1,
      frame: { clientContent: { turnComplete: true } },
    },
    {
      label: "realtimeInput.text",
      setup: BASE_SETUP_V1,
      frame: { realtimeInput: { text: "Say hello." } },
    },
    {
      label: "generationConfig.enableAffectiveDialog + a text turn",
      setup: {
        ...BASE_SETUP_V1,
        generationConfig: {
          ...BASE_SETUP_V1.generationConfig,
          enableAffectiveDialog: true,
        },
      },
      frame: {
        clientContent: {
          turns: [{ role: "user", parts: [{ text: "Say hello." }] }],
          turnComplete: true,
        },
      },
    },
    {
      label:
        "setup.enableAffectiveDialog is not a generationConfig field -> where?",
      setup: {
        ...BASE_SETUP_V1,
        generationConfig: { ...BASE_SETUP_V1.generationConfig },
        proactivity: { proactiveAudio: false },
      },
      frame: {
        clientContent: {
          turns: [{ role: "user", parts: [{ text: "Say hello." }] }],
          turnComplete: true,
        },
      },
    },
    {
      label: "speechConfig.languageCode + a text turn",
      setup: {
        ...BASE_SETUP_V1,
        generationConfig: {
          ...BASE_SETUP_V1.generationConfig,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } },
            languageCode: "en-US",
          },
        },
      },
      frame: {
        clientContent: {
          turns: [{ role: "user", parts: [{ text: "Say hello." }] }],
          turnComplete: true,
        },
      },
    },
    {
      label: "clientContent with contents (not turns)",
      setup: BASE_SETUP_V1,
      frame: {
        clientContent: {
          contents: [{ role: "user", parts: [{ text: "Say hello." }] }],
          turnComplete: true,
        },
      },
    },
  ];
  for (const candidate of candidates) {
    log(`\n=== variant: ${candidate.label} ===`);
    const session = new ProbeSession();
    await session.open();
    session.send({ setup: candidate.setup });
    await session.wait((message) => has(message, "setupComplete"), 15_000);
    session.send(candidate.frame);
    await session.wait(
      (message) =>
        has(message, "serverContent.turnComplete") ||
        has(message, "serverContent"),
      20_000,
    );
    await session.settle(2000);
    log("closed:", JSON.stringify(session.closed ?? "still open"));
    session.close();
    await new Promise((done) => setTimeout(done, 500));
  }
}

/**
 * Synthetic tone is not speech, so automatic VAD never barges in on it. Manual
 * activity signalling is the only way to make `interrupted` happen from a test,
 * and it doubles as the answer to "can we drive turn boundaries ourselves?".
 */
async function scenarioActivity(): Promise<void> {
  log("\n=== manual activity signalling -> interrupted ===");
  const session = new ProbeSession();
  await session.open();
  session.send({
    setup: {
      ...BASE_SETUP_V1,
      realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
    },
  });
  await session.wait((message) => has(message, "setupComplete"), 15_000);
  session.send({
    clientContent: {
      turns: [
        { role: "user", parts: [{ text: "Count slowly from one to forty." }] },
      ],
      turnComplete: true,
    },
  });
  await session.wait(
    (message) => has(message, "serverContent.modelTurn"),
    30_000,
  );
  await session.settle(1500);
  session.send({ realtimeInput: { activityStart: {} } });
  session.sendQuiet({
    realtimeInput: {
      audio: { data: toneV1(400), mimeType: "audio/pcm;rate=16000" },
    },
  });
  session.send({ realtimeInput: { activityEnd: {} } });
  await session.settle(8000);
  log(
    "interrupted seen:",
    session.received.some((message) =>
      has(message, "serverContent.interrupted"),
    ),
  );
  log("closed:", JSON.stringify(session.closed ?? "still open"));
  session.close();
}

const SCENARIOS_V1: Record<string, () => Promise<void>> = {
  variants: scenarioVariants,
  activity: scenarioActivity,
  models: scenarioModels,
  setup: scenarioSetup,
  affective: scenarioAffectiveTopLevel,
  language: scenarioLanguageCode,
  compression: scenarioCompression,
  text: scenarioText,
  audio: scenarioAudio,
  tools: scenarioTools,
  interrupt: scenarioInterrupt,
  resumption: scenarioResumption,
  badhandle: scenarioBadHandle,
};

const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : Object.keys(SCENARIOS_V1);
for (const name of names) {
  const scenario = SCENARIOS_V1[name];
  if (!scenario) {
    log(
      `unknown scenario ${name}; known:`,
      Object.keys(SCENARIOS_V1).join(", "),
    );
    continue;
  }
  try {
    await scenario();
  } catch (error) {
    log(`[${name}] threw:`, redact(String(error)));
  }
}
process.exit(0);
