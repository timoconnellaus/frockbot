import { describe, expect, test } from "bun:test";

import {
  bootstrap,
  MINIMUM_TRUST_NPM,
  publishArguments,
  readWorkspacePackages,
  supportsTrust,
  trustArguments,
  WORKFLOW_FILE,
  type CommandRunner,
} from "./bootstrap-npm-trust.ts";

const root = new URL("..", import.meta.url).pathname;

type Invocation = { args: string[]; interactive: boolean };

/** A stub npm whose answers are scripted per subcommand. */
function stubNpm(options: {
  existing?: Set<string>;
  trusted?: Set<string>;
  calls: string[][];
  invocations?: Invocation[];
  npmVersion?: string;
}): CommandRunner {
  return async (command, args, runOptions) => {
    options.calls.push([command, ...args]);
    options.invocations?.push({
      args,
      interactive: runOptions?.interactive === true,
    });
    const ok = { exitCode: 0, stdout: "", stderr: "" };
    if (args[0] === "--version") {
      return { ...ok, stdout: `${options.npmVersion ?? MINIMUM_TRUST_NPM}\n` };
    }
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

  test("a token publishes unattended and never reaches npm trust", async () => {
    const calls: string[][] = [];
    const invocations: Invocation[] = [];
    await bootstrap({
      root,
      confirm: true,
      token: "bootstrap-token",
      run: stubNpm({ calls, invocations }),
      log: () => {},
    });

    const publishes = invocations.filter((call) => call.args[0] === "publish");
    expect(publishes.length).toBeGreaterThan(0);
    for (const publish of publishes) {
      // The token lives in a throwaway config, so ~/.npmrc is left alone,
      // and npm needs no terminal because it never asks for a second factor.
      expect(publish.args).toContain("--userconfig");
      expect(publish.interactive).toBe(false);
    }

    // `npm trust` rejects tokens, so it must run on the interactive session.
    const trusts = invocations.filter(
      (call) => call.args[0] === "trust" && call.args[1] === "github",
    );
    expect(trusts.length).toBeGreaterThan(0);
    for (const trust of trusts) {
      expect(trust.args).not.toContain("--userconfig");
      // It needs the terminal for the same reason: npm trust demands a
      // second factor, and a captured prompt is an unanswerable one.
      expect(trust.interactive).toBe(true);
    }
  });

  test("without a token npm is handed the terminal to ask for a second factor", async () => {
    const calls: string[][] = [];
    const invocations: Invocation[] = [];
    await bootstrap({
      root,
      confirm: true,
      run: stubNpm({ calls, invocations }),
      log: () => {},
    });

    const publishes = invocations.filter((call) => call.args[0] === "publish");
    expect(publishes.length).toBeGreaterThan(0);
    for (const publish of publishes) {
      expect(publish.interactive).toBe(true);
      expect(publish.args).not.toContain("--userconfig");
    }
  });

  test("an npm without the trust command is refused, not trusted blindly", async () => {
    const calls: string[][] = [];
    // 11.6.0 prints "Unknown command: trust" and can still exit zero, which
    // would otherwise be recorded as sixty successful configurations.
    const attempt = bootstrap({
      root,
      confirm: true,
      phase: "trust",
      run: stubNpm({ calls, npmVersion: "11.6.0" }),
      log: () => {},
    });
    expect(attempt).rejects.toThrow(/has no `trust` command/);
    expect(
      calls.some((call) => call.includes("trust") && call.includes("github")),
    ).toBe(false);
  });

  test("the npm version gate matches what npm trust needs", () => {
    expect(supportsTrust("11.6.0")).toBe(false);
    expect(supportsTrust("11.14.9")).toBe(false);
    expect(supportsTrust(MINIMUM_TRUST_NPM)).toBe(true);
    expect(supportsTrust("11.19.1")).toBe(true);
    expect(supportsTrust("12.0.2")).toBe(true);
    expect(supportsTrust("")).toBe(false);
  });

  test("the trust phase refuses a package that was never published", async () => {
    const calls: string[][] = [];
    const attempt = bootstrap({
      root,
      confirm: true,
      phase: "trust",
      run: stubNpm({ calls }),
      log: () => {},
    });
    expect(attempt).rejects.toThrow(/not published yet/);
  });

  test("publish arguments carry the config only when there is one", () => {
    expect(publishArguments()).toEqual(["publish", "--access", "public"]);
    expect(publishArguments("/tmp/x/.npmrc")).toEqual([
      "publish",
      "--access",
      "public",
      "--userconfig",
      "/tmp/x/.npmrc",
    ]);
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
