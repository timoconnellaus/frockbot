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
  calls: string[][];
  /** Records which calls were given the terminal, keyed by subcommand. */
  interactive?: Map<string, boolean>;
}): CommandRunner {
  return async (command, args, runOptions) => {
    options.calls.push([command, ...args]);
    // `trust` is keyed by its subcommand, because reading a trusted
    // publisher and setting one are opposite cases here.
    const subcommand = args[0] === "trust" ? `trust ${args[1]}` : args[0];
    options.interactive?.set(
      String(subcommand),
      runOptions?.interactive === true,
    );
    const ok = { exitCode: 0, stdout: "", stderr: "" };
    if (args[0] === "view") {
      const name = args[1] ?? "";
      return options.existing?.has(name)
        ? { ...ok, stdout: "0.0.0" }
        : { exitCode: 1, stdout: "", stderr: "E404" };
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

  test("npm is given the terminal for the calls that need a password", async () => {
    // npm demands a one-time password for every operation that changes the
    // registry, and asks for it by printing a URL and waiting on a browser.
    // Capturing that output hides the question and the run dies with EOTP
    // partway through, so publishing and trusting must inherit the terminal.
    // The probes are captured instead, because their output is parsed.
    const calls: string[][] = [];
    const interactive = new Map<string, boolean>();
    await bootstrap({
      root,
      confirm: true,
      run: stubNpm({ calls, interactive }),
      log: () => {},
    });

    expect(interactive.get("publish")).toBe(true);
    expect(interactive.get("deprecate")).toBe(true);
    expect(interactive.get("trust github")).toBe(true);
    expect(interactive.get("view")).toBe(false);
  });

  test("a package npm already has costs no authenticated call", async () => {
    // The session behind those calls expires in minutes and each one asks
    // for a password, so a package that needs nothing must not be asked
    // about. A package the registry has was published by the workflow,
    // which is only possible if it is already trusted.
    const packages = readWorkspacePackages(root);
    const every = new Set(packages.map((entry) => entry.name));
    const calls: string[][] = [];
    const result = await bootstrap({
      root,
      confirm: true,
      run: stubNpm({ existing: every, calls }),
      log: () => {},
    });
    expect(result).toMatchObject({ publishedCount: 0, trustedCount: 0 });
    // `npm view` is public. Everything else would have needed a password.
    expect(calls.every((call) => call[1] === "view")).toBe(true);
  });

  test("only the packages npm is missing are bootstrapped", async () => {
    const packages = readWorkspacePackages(root);
    const missing = packages[0]!.name;
    const existing = new Set(
      packages.map((entry) => entry.name).filter((name) => name !== missing),
    );
    const calls: string[][] = [];
    const result = await bootstrap({
      root,
      confirm: true,
      run: stubNpm({ existing, calls }),
      log: () => {},
    });
    expect(result).toMatchObject({ publishedCount: 1, trustedCount: 1 });
    const trusted = calls.filter(
      (call) => call[1] === "trust" && call[2] === "github",
    );
    expect(trusted).toHaveLength(1);
    expect(trusted[0]).toContain(missing);
  });

  test("a named package is trusted even when npm already has it", async () => {
    // The way back from a run that published a placeholder and then failed
    // before trusting it: the package exists, so the default pass skips it,
    // and it still cannot be published by the workflow.
    const packages = readWorkspacePackages(root);
    const stranded = packages[0]!.name;
    const calls: string[][] = [];
    const result = await bootstrap({
      root,
      confirm: true,
      only: [stranded],
      run: stubNpm({ existing: new Set([stranded]), calls }),
      log: () => {},
    });
    expect(result).toMatchObject({ publishedCount: 0, trustedCount: 1 });
    expect(calls.some((call) => call.includes("publish"))).toBe(false);
    const trusted = calls.filter(
      (call) => call[1] === "trust" && call[2] === "github",
    );
    expect(trusted).toHaveLength(1);
    expect(trusted[0]).toContain(stranded);
  });

  test("a name that is not a workspace is refused", async () => {
    expect(
      bootstrap({
        root,
        confirm: true,
        only: ["@frockbot/not-a-package"],
        run: stubNpm({ calls: [] }),
        log: () => {},
      }),
    ).rejects.toThrow("no workspace under packages/ is named");
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
