import { createInterface } from "node:readline";
import { homedir, hostname } from "node:os";
import { MachineDeviceAgentV1 } from "@frockbot/app/machine/device";
import { createMachineDeviceRunnerV1 } from "@frockbot/app/machine/device-runner";
import { createMachineMessagesDeviceRunnerV1 } from "@frockbot/app/machine-messages/device";
import { messagesSeam } from "./messages";
import { withSendLedger } from "./send-ledger";
import { join } from "node:path";

const output = (value: unknown): void => {
  process.stdout.write(JSON.stringify(value) + "\n");
};
const pending = new Map<
  number,
  { resolve(value: unknown): void; reject(error: Error): void }
>();
let nextId = 0;
function native(method: string, value?: string): Promise<unknown> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    output({ type: "native", id, method, value });
  });
}
let agent: MachineDeviceAgentV1 | undefined;
const unavailable = async (): Promise<never> => {
  throw new Error("This Mac bridge only offers Messages access");
};
let commands = Promise.resolve();
async function command(input: Record<string, unknown>) {
  if (input.type === "start") {
    if (agent) throw new Error("Mac Messages is already initialized");
    if (process.platform !== "darwin")
      throw new Error("Messages requires macOS");
    if (input.consent !== true)
      throw new Error("Messages sharing consent is required");
    const origin = new URL(String(input.origin));
    if (origin.protocol !== "https:" || origin.origin !== input.origin)
      throw new Error("A secure FrockBot origin is required");
    if (
      typeof input.ledgerKey !== "string" ||
      !input.ledgerKey.startsWith(origin.origin + ":")
    )
      throw new Error("Account context is required");
    const capabilities = ["messages"] as const;
    const seam = messagesSeam(homedir(), {
      permissions: async () => (await native("permissions")) === true,
      send: async (script) => {
        await native("send", script);
      },
    });
    agent = new MachineDeviceAgentV1({
      origin: origin.origin,
      fetch: (url, init) => fetch(url, { ...init, redirect: "error" }),
      secrets: {
        read: async () => {
          const value = await native("read");
          return typeof value === "string" ? value : undefined;
        },
        write: async (value) => {
          await native("write", value);
        },
        clear: async () => {
          await native("clear");
        },
      },
      runner: withSendLedger(
        join(
          homedir(),
          "Library/Application Support/FrockBot/Messages",
          new Bun.CryptoHasher("sha256")
            .update(String(input.ledgerKey))
            .digest("hex") + ".sqlite",
        ),
        createMachineDeviceRunnerV1({
          capabilities,
          host: {
            identity: () => ({ label: hostname(), platform: "macos" }),
            exec: unavailable,
            readFile: unavailable,
          },
          messages: createMachineMessagesDeviceRunnerV1({ seam }),
        }),
      ),
      label: hostname(),
      platform: "macos",
      agentVersion: String(input.version),
      capabilities: [...capabilities],
      onStatus: (status) => output({ type: "status", status }),
    });
    await agent.paired();
    agent.start();
  } else if (input.type === "pair") {
    if (!agent) throw new Error("Start Mac Messages first");
    await agent.stop();
    try {
      await agent.pair(String(input.code ?? ""));
    } finally {
      agent.start();
    }
  } else {
    throw new Error("Unknown Mac Messages command");
  }
  output({ type: "done" });
}
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  try {
    const input = JSON.parse(line) as Record<string, unknown>;
    if (input.type === "reply") {
      const request = pending.get(Number(input.id));
      pending.delete(Number(input.id));
      if (typeof input.error === "string")
        request?.reject(new Error(input.error));
      else request?.resolve(input.value);
    } else {
      commands = commands
        .then(() => command(input))
        .catch(() =>
          output({
            type: "error",
            message:
              "Mac Messages could not complete the request. Check your connection and pairing code, then try again.",
          }),
        );
    }
  } catch {
    output({ type: "error", message: "Invalid Mac Messages request" });
  }
});
lines.on("close", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
