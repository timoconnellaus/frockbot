import type { ShellApplicationV1 } from "./backend-runtime.js";
import { shellDefinitionV1 } from "./definition.js";

/**
 * An application that ships two Packages and mounts no runtime features.
 *
 * Enough for a test whose subject is the Shell's own durable behaviour. A test
 * about which features a Turn mounts, or about a real provider, is a test of
 * the application that composes them and belongs beside it.
 */
export function shellTestApplicationV1(): ShellApplicationV1 {
  return {
    packages: [shellDefinitionV1, { id: "echo", displayName: "Echo" }],
    packageVersion: "0.0.1",
    runtime: {
      base: () => [],
      hosted: () => [],
      enabled: () => Promise.resolve([]),
      model: () => {
        throw new Error("This test application composes no model provider");
      },
    },
  };
}
