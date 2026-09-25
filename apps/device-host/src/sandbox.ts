// How one device module's process is started (ADR 0037).
//
// A module is untrusted code on the person's computer, and the app that starts
// it holds Full Disk Access. So it never runs as a plain child: two boundaries,
// both generated from the module's declaration and nothing else, stand between
// it and the rest of the machine.
//
//  1. Deno's permissions: reads, hosts, and a flat refusal of everything else.
//  2. A Seatbelt profile the kernel enforces around the whole process, so a
//     flaw in Deno's checks still does not reach past what was declared.
//
// Deno's own guidance is not to rely on its permissions alone for untrusted
// code; the profile is that second layer. Its proof is the macOS smoke test in
// `sandbox.macos.test.ts`, which runs a module under both and checks what it
// can and cannot reach.

import { homedir } from "node:os";
import { join } from "node:path";

/** What a module declares it reaches, as the descriptor carries it. */
export interface ModuleReachV1 {
  read: readonly string[];
  net: readonly string[];
  appleEvents: readonly string[];
}

/** Where things are on this machine, for one module. */
export interface ModulePathsV1 {
  /** The bundled Deno binary. */
  deno: string;
  /** The runtime every module is started through. */
  runtime: string;
  /** The module's stored code. */
  code: string;
  /** A directory only this module writes: Deno's cache, nothing else. */
  data: string;
  /** The person's home, for `~/` paths. Defaults to this user's. */
  home?: string;
}

/** A declared path made absolute. `~/` is the person's home. */
export function expandModulePathV1(path: string, home = homedir()): string {
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/** The arguments `deno` is started with, after `run`. */
export function denoRunArgsV1(
  reach: ModuleReachV1,
  paths: ModulePathsV1,
): string[] {
  const reads = [
    paths.runtime,
    paths.code,
    ...reach.read.map((path) => expandModulePathV1(path, paths.home)),
  ];
  return [
    "run",
    "--no-prompt",
    "--no-config",
    "--no-remote",
    "--no-npm",
    "--cached-only",
    `--allow-read=${reads.join(",")}`,
    ...(reach.net.length === 0 ? [] : [`--allow-net=${reach.net.join(",")}`]),
    "--deny-write",
    "--deny-env",
    "--deny-run",
    "--deny-ffi",
    "--deny-sys",
    paths.runtime,
    paths.code,
  ];
}

/** The environment the module's process gets: nothing of the app's. */
export function moduleEnvironmentV1(
  paths: ModulePathsV1,
): Record<string, string> {
  return {
    DENO_DIR: paths.data,
    DENO_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    HOME: paths.home ?? homedir(),
  };
}

/** A string inside an SBPL literal. */
function literal(value: string): string {
  if (/[\u0000-\u001f"\\]/.test(value)) {
    throw new Error(
      `a sandbox path may not contain quotes, backslashes or control characters: ${value}`,
    );
  }
  return `"${value}"`;
}

/**
 * The Seatbelt profile around the module's process.
 *
 * Everything is denied, then the system basics a process needs to start are
 * imported, then exactly what the module declared is added: reads under its
 * paths, connections to its loopback ports, writes to its own data directory.
 * Its Apple Events go through the app, never from here, so none are allowed.
 */
export function seatbeltProfileV1(
  reach: ModuleReachV1,
  paths: ModulePathsV1,
): string {
  const reads = [
    paths.deno,
    paths.runtime,
    paths.code,
    ...reach.read.map((path) => expandModulePathV1(path, paths.home)),
  ];
  const ports = reach.net.map((address) => {
    const port = /:(\d{1,5})$/.exec(address)?.[1];
    if (port === undefined)
      throw new Error(`not a loopback address: ${address}`);
    return port;
  });
  return [
    "(version 1)",
    "(deny default)",
    '(import "bsd.sb")',
    `(allow process-exec (literal ${literal(paths.deno)}))`,
    // `subpath` names a file itself, or a directory as a tree.
    ...reads.map(
      (path) =>
        `(allow file-read* (subpath ${literal(path.replace(/\/$/, ""))}))`,
    ),
    `(allow file-read* file-write* (subpath ${literal(paths.data)}))`,
    ...ports.map(
      (port) => `(allow network-outbound (remote ip "localhost:${port}"))`,
    ),
    "",
  ].join("\n");
}

/** The whole command: Seatbelt around Deno around the module. */
export function moduleCommandV1(
  reach: ModuleReachV1,
  paths: ModulePathsV1,
): {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
} {
  return {
    command: "/usr/bin/sandbox-exec",
    args: [
      "-p",
      seatbeltProfileV1(reach, paths),
      paths.deno,
      ...denoRunArgsV1(reach, paths),
    ],
    env: moduleEnvironmentV1(paths),
    // Deno reads its working directory as it starts, and the profile lets it
    // read nowhere but what was declared and its own data.
    cwd: paths.data,
  };
}
