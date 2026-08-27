import { Context, type Plugin } from "cordis";

type ParentCommand = { type: "ping"; value: string } | { type: "shutdown" };

type ParentEvent =
  | { type: "ready" }
  | { type: "pong"; value: string }
  | { type: "disposed" };

interface UtilityParentPort {
  on(
    event: "message",
    listener: (event: { data: ParentCommand }) => void,
  ): void;
  off(
    event: "message",
    listener: (event: { data: ParentCommand }) => void,
  ): void;
  postMessage(event: ParentEvent): void;
}

const parentPort = (
  process as NodeJS.Process & { parentPort?: UtilityParentPort }
).parentPort;
if (!parentPort)
  throw new Error("Cordis POC worker requires an Electron parent port");

const root = new Context();

const bridgePlugin: Plugin.Function = (_ctx) => {
  const onMessage = (event: { data: ParentCommand }) => {
    if (event.data.type === "ping") {
      parentPort.postMessage({ type: "pong", value: event.data.value });
      return;
    }
    void shutdown();
  };
  parentPort.on("message", onMessage);
  return () => parentPort.off("message", onMessage);
};

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await root.fiber.dispose();
  parentPort.postMessage({ type: "disposed" });
  setImmediate(() => process.exit(0));
}

await root.plugin(bridgePlugin);
parentPort.postMessage({ type: "ready" });
