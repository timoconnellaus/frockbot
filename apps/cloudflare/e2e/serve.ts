// The `webServer` command of `e2e/playwright.config.ts`.
//
// A separate entry point from `harness.ts` so that module stays importable by
// the Playwright config (which runs under Node) without starting anything.
// The ports are chosen by the config and passed in, so the specs and the
// harness agree on the fake provider's address without a handshake.
import { startHarness } from "./harness.ts";

function requiredPort(name: string): number {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a port number`);
  }
  return value;
}

const harness = await startHarness({
  port: requiredPort("FROCKBOT_E2E_PORT"),
  ollamaPort: requiredPort("FROCKBOT_E2E_OLLAMA_PORT"),
});

console.log(
  `FrockBot e2e harness ready on ${harness.baseUrl} (fake Ollama on ${harness.ollamaUrl})`,
);

let stopping = false;
const shutdown = (): void => {
  if (stopping) return;
  stopping = true;
  void harness.stop().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
