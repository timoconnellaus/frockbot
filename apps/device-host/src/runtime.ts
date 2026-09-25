// The entry point every device module's process runs: `runtime.js <module>`.
//
// It loads the module, says which calls it exports, and then serves the host
// over stdin and stdout: a call runs the module's function, and the module's
// context turns each of its requests into a frame the host answers. This file
// runs inside the sandbox with the module, so it holds nothing the module
// could not; the host decides everything.

import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import type {
  HostFrameV1,
  ModuleFrameV1,
  ModuleRequestOpV1,
} from "./frames.ts";

type Call = (input: unknown, context: unknown) => unknown;

function send(frame: ModuleFrameV1): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const pending = new Map<
  number,
  { resolve(value: unknown): void; reject(error: Error): void }
>();
let nextRequest = 0;

function request(op: ModuleRequestOpV1, ...args: unknown[]): Promise<unknown> {
  const id = ++nextRequest;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ type: "request", id, op, args });
  });
}

const stopping = new AbortController();

const context = {
  emit: async (event: string, payload: unknown, options: { key: string }) => {
    await request("emit", event, payload, options.key);
  },
  lastKey: async (event: string) =>
    (await request("lastKey", event)) as string | undefined,
  log: (level: "log" | "error", text: string) =>
    send({ type: "log", level, text: String(text) }),
  store: {
    get: (key: string) => request("store.get", key),
    set: async (key: string, value: unknown) => {
      await request("store.set", key, value);
    },
    delete: async (key: string) => {
      await request("store.delete", key);
    },
  },
  appleEvents: {
    run: async (bundleId: string, script: string) =>
      String(await request("appleEvents.run", bundleId, script)),
  },
  signal: stopping.signal,
};

// stdout is the frame stream, so a module's own console output becomes log
// frames rather than lines the host would read as broken frames.
const format = (values: unknown[]) =>
  values
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join(" ");
console.log =
  console.info =
  console.debug =
    (...values: unknown[]) => context.log("log", format(values));
console.warn = console.error = (...values: unknown[]) =>
  context.log("error", format(values));

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) throw new Error("no module given");
  const module = (await import(pathToFileURL(path).href)) as {
    calls?: Record<string, Call>;
    start?: (context: unknown) => unknown;
  };
  const calls = module.calls ?? {};
  send({
    type: "ready",
    calls: Object.keys(calls).filter(
      (name) => typeof calls[name] === "function",
    ),
    start: typeof module.start === "function",
  });

  const lines = createInterface({ input: process.stdin });
  lines.on("close", () => {
    // The host closing stdin is the stop.
    stopping.abort();
    process.exit(0);
  });
  for await (const line of lines) {
    let frame: HostFrameV1;
    try {
      frame = JSON.parse(line) as HostFrameV1;
    } catch {
      continue;
    }
    if (frame.type === "reply") {
      const waiter = pending.get(frame.id);
      pending.delete(frame.id);
      if (!waiter) continue;
      if (frame.ok) waiter.resolve(frame.value);
      else waiter.reject(new Error(frame.error));
    } else if (frame.type === "call") {
      const run = calls[frame.call];
      const { id } = frame;
      void (async () => {
        try {
          if (typeof run !== "function") {
            throw new Error(`the module exports no call "${frame.call}"`);
          }
          send({
            type: "result",
            id,
            ok: true,
            value: await run(frame.input, context),
          });
        } catch (error) {
          send({ type: "result", id, ok: false, error: message(error) });
        }
      })();
    } else if (frame.type === "start" && typeof module.start === "function") {
      const start = module.start;
      void (async () => {
        try {
          await start(context);
        } catch (error) {
          context.log("error", `start failed: ${message(error)}`);
          process.exit(1);
        }
      })();
    }
  }
}

main().catch((error: unknown) => {
  send({
    type: "log",
    level: "error",
    text: `the module failed to load: ${message(error)}`,
  });
  process.exit(1);
});
