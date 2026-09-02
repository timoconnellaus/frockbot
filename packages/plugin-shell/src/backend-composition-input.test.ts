import { describe, expect, test } from "bun:test";
import {
  compositionFailureDurableInputV1,
  compositionFailureTurnTextV1,
} from "./backend-composition-input.ts";

describe("Composition failure durable Bot input", () => {
  test("includes the authored Package, phase, diagnostics, and quarantine", () => {
    const text = compositionFailureDurableInputV1({
      attemptedGenerationId: "generation-broken",
      generation: {
        schemaVersion: 1,
        generationId: "generation-broken",
        artifactSetHash: "a".repeat(64),
        createdAt: "2026-09-02T00:00:00.000Z",
        origin: {
          kind: "bot-authored",
          runId: "run-1",
          sessionId: "session-1",
          turnId: "turn-1",
        },
        members: [
          {
            packageId: "weather-lookup",
            specifier: "bot-authored:weather-lookup",
            version: "0.0.1",
            manifestHash: "b".repeat(64),
            provenance: {
              kind: "bot",
              packageId: "weather-lookup",
              version: "0.0.1",
              botId: "bot-1",
              sessionId: "session-1",
              turnId: "turn-1",
              runId: "run-1",
              authoredAt: "2026-09-02T00:00:00.000Z",
            },
          },
        ],
        status: "quarantined",
      },
      failure: {
        generationId: "generation-broken",
        attempt: 3,
        at: "2026-09-02T00:01:00.000Z",
        phase: "health",
        message: "declared tools do not match",
        diagnostics: ["declared=weather_lookup", "reported=other"],
      },
      quarantined: true,
    });

    expect(text).toContain("Generation: generation-broken");
    expect(text).toContain("Package: weather-lookup");
    expect(text).toContain("Phase: health");
    expect(text).toContain("- reported=other");
    expect(text).toContain("Status: quarantined");
    expect(
      compositionFailureTurnTextV1("please continue", {
        attemptedGenerationId: "generation-broken",
        quarantined: false,
      }),
    ).toEndWith("\n\nplease continue");
  });
});
