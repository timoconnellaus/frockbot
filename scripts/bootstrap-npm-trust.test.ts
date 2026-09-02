import { describe, expect, test } from "bun:test";

import {
  bootstrap,
  readWorkspacePackages,
  trustArguments,
  WORKFLOW_FILE,
  type CommandRunner,
} from "./bootstrap-npm-trust.ts";

const root = new URL("..", import.meta.url).pathname;

/** A stub npm whose answers are scripted per subcommand. */
function stubNpm(options: {
  existing?: Set<string>;
  trusted?: Set<string>;
  calls: string[][];
}): CommandRunner {
  return async (command, args) => {
    options.calls.push([command, ...args]);
    const ok = { exitCode: 0, stdout: "", stderr: "" };
    if (args[0] === "view") {
      const name = args[1] ?? "";
      return options.existing?.has(name)
        ? { ...ok, stdout: "0.0.0" }
        : { exitCode: 1, stdout: "", stderr: "E404" };
    }
    if (args[0] === "trust" && args[1] === "list") {
      const name = args[2] ?? "";
      return options.trusted?.has(name)
        ? { ...ok, stdout: "github timoconnellaus/frockbot release.yml" }
        : { ...ok, stdout: "" };
    }
    return ok;
  };
}

describe("npm trusted publishing bootstrap", () => {
  test("every publishable workspace is covered", () => {
    const packages = readWorkspacePackages(root);
    expect(packages.length).toBeGreaterThan(0);
    // Each entry is a real scoped package rooted at its own directory.
    for (const entry of packages) {
      expect(entry.name.startsWith("@frockbot/")).toBe(true);
      expect(entry.directory.startsWith("packages/")).toBe(true);
    }
    const names = packages.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("the trusted publisher names this workflow and claims no environment", () => {
    const args = trustArguments("@frockbot/kernel-contracts");
    expect(args).toEqual([
      "trust",
      "github",
      "@frockbot/kernel-contracts",
      "--file",
      WORKFLOW_FILE,
      "--repo",
      "timoconnellaus/frockbot",
      "--allow-publish",
      "--yes",
    ]);
    // The publish job runs outside the production environment, so claiming
    // one here would make npm reject every release.
    expect(args).not.toContain("--environment");
    expect(args).not.toContain("--env");
  });

  test("a dry run publishes nothing and configures nothing", async () => {
    const calls: string[][] = [];
    const lines: string[] = [];
    await bootstrap({
      root,
      confirm: false,
      run: stubNpm({ calls }),
      log: (line) => lines.push(line),
    });
    const mutating = calls.filter(
      (call) =>
        call.includes("publish") ||
        (call.includes("trust") && !call.includes("list")),
    );
    expect(mutating).toEqual([]);
    expect(lines.join("\n")).toContain("Dry run");
  });

  test("an already trusted package is left alone", async () => {
    const packages = readWorkspacePackages(root);
    const every = new Set(packages.map((entry) => entry.name));
    const calls: string[][] = [];
    const result = await bootstrap({
      root,
      confirm: true,
      run: stubNpm({ existing: every, trusted: every, calls }),
      log: () => {},
    });
    expect(result).toMatchObject({ publishedCount: 0, trustedCount: 0 });
    expect(calls.some((call) => call.includes("publish"))).toBe(false);
  });

  test("a package that exists but is untrusted is trusted, not republished", async () => {
    const packages = readWorkspacePackages(root);
    const every = new Set(packages.map((entry) => entry.name));
    const calls: string[][] = [];
    const result = await bootstrap({
      root,
      confirm: true,
      run: stubNpm({ existing: every, calls }),
      log: () => {},
    });
    expect(result.publishedCount).toBe(0);
    expect(result.trustedCount).toBe(packages.length);
    expect(calls.some((call) => call.includes("publish"))).toBe(false);
  });

  test("an absent package is published once, then trusted", async () => {
    const calls: string[][] = [];
    const result = await bootstrap({
      root,
      confirm: true,
      run: stubNpm({ calls }),
      log: () => {},
    });
    const packages = readWorkspacePackages(root);
    expect(result.publishedCount).toBe(packages.length);
    expect(result.trustedCount).toBe(packages.length);
    // The placeholder is deprecated on the way out so nobody installs it.
    expect(calls.filter((call) => call.includes("deprecate")).length).toBe(
      packages.length,
    );
  });
});
