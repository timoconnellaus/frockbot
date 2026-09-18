import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const surface = readFileSync(
  new URL("./worker-app.ts", import.meta.url),
  "utf8",
);

describe("the published Worker factory surface", () => {
  test("exports the factory, the Durable Object classes, and the native door", () => {
    for (const name of [
      "createGateway",
      "createWorkerApp",
      "createNativeAuth",
      "configureWorkerAppV1",
      "BotState",
      "UserConfiguration",
      "AppletState",
      "DeploymentPolicy",
      "VoiceAssistant",
    ]) {
      expect(surface).toContain(name);
    }
    expect(surface).toContain("AuthPackageIdV1");
  });
});
