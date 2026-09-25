// The account's device modules, kept running on this Mac (ADR 0037).
//
// Each modules frame is the whole list. A module already running at the same
// hash is left alone; one that left the list or changed hash is stopped; a new
// one is fetched, checked against its hash, and started under a supervisor.
// What the supervisors report is posted back in small batches.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  MACHINE_LIMITS_V1,
  machineRoutePathV1,
  type MachineModuleReportV1,
  type MachineModuleV1,
} from "@frockbot/core/machine-protocol";

import { moduleCommandV1, type ModulePathsV1 } from "./sandbox.ts";
import {
  ModuleSupervisorV1,
  type ModuleStateV1,
  type ModuleSupervisorSeamsV1,
} from "./supervisor.ts";

/** Which machine this is, as the stored enrollment says. */
export interface ModuleHostCredentialV1 {
  machineId: string;
  token: string;
}

export interface ModuleHostEntryV1 {
  pluginId: string;
  moduleId: string;
  state: ModuleStateV1;
}

/** A started module, as the host holds it. */
export interface RunningModuleV1 {
  start(): void;
  stop(): void;
}

export interface ModuleHostOptionsV1 {
  origin: string;
  /** Everything the host writes lives under here. */
  supportDir: string;
  deno: string;
  runtime: string;
  home: string;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  credential(): ModuleHostCredentialV1 | undefined;
  appleEvents(bundleId: string, script: string): Promise<string>;
  onChange?(modules: ModuleHostEntryV1[]): void;
  /** Injected so a test runs no process. */
  supervise?(
    module: MachineModuleV1,
    paths: ModulePathsV1,
    seams: Omit<ModuleSupervisorSeamsV1, "spawn">,
  ): RunningModuleV1;
}

/** Reports held while the cloud cannot be reached; the oldest go first. */
export const MODULE_REPORT_QUEUE_MAX_V1 = 500;
/** Posts in a row that may fail before the batch is dropped. */
const REPORT_ATTEMPTS = 3;
/** A module's own store, as JSON. */
const STORE_BYTES_MAX = 1_024 * 1_024;

const EVENTS_LATER = "events arrive in a later release";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clip(text: string): string {
  const max = MACHINE_LIMITS_V1.moduleReportText;
  const value = text.length === 0 ? "(empty)" : text;
  return value.length > max ? value.slice(0, max) : value;
}

async function writeAtomically(path: string, data: string | Uint8Array) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, path);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function defaultSupervise(
  module: MachineModuleV1,
  paths: ModulePathsV1,
  seams: Omit<ModuleSupervisorSeamsV1, "spawn">,
): RunningModuleV1 {
  return new ModuleSupervisorV1(module, {
    ...seams,
    spawn: () => {
      const command = moduleCommandV1(module, paths);
      return spawn(command.command, command.args, {
        env: command.env,
        cwd: command.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
    },
  });
}

interface Held {
  module: MachineModuleV1;
  state: ModuleStateV1;
  running?: RunningModuleV1;
}

export class ModuleHostV1 {
  private readonly held = new Map<string, Held>();
  private wanted: MachineModuleV1[] | undefined;
  private applying: Promise<void> | undefined;
  /** Bumped by `stopAll`, so a list being applied does not outlive it. */
  private epoch = 0;
  private readonly reports: MachineModuleReportV1[] = [];
  private flushing = false;
  private failures = 0;

  constructor(private readonly options: ModuleHostOptionsV1) {}

  /** What runs, for the app to show. */
  entries(): ModuleHostEntryV1[] {
    return [...this.held.values()].map(({ module, state }) => ({
      pluginId: module.pluginId,
      moduleId: module.moduleId,
      state,
    }));
  }

  /** Adopt the whole list. Resolves once it, or a newer one, is applied. */
  sync(modules: MachineModuleV1[]): Promise<void> {
    this.wanted = modules;
    this.applying ??= this.drain();
    return this.applying;
  }

  /** Stop every module: the machine was forgotten or the app is closing. */
  stopAll(): void {
    this.epoch += 1;
    this.wanted = undefined;
    for (const held of this.held.values()) held.running?.stop();
    this.held.clear();
    this.changed();
  }

  private changed(): void {
    this.options.onChange?.(this.entries());
  }

  private async drain(): Promise<void> {
    try {
      while (this.wanted) {
        const next = this.wanted;
        this.wanted = undefined;
        await this.apply(next);
      }
    } finally {
      this.applying = undefined;
    }
  }

  private async apply(modules: MachineModuleV1[]): Promise<void> {
    const epoch = this.epoch;
    const wanted = new Map(modules.map((module) => [key(module), module]));
    for (const [name, held] of this.held) {
      const next = wanted.get(name);
      // One that never started is tried again.
      if (next?.contentHash === held.module.contentHash && held.running) {
        continue;
      }
      held.running?.stop();
      this.held.delete(name);
    }
    for (const [name, module] of wanted) {
      if (this.held.has(name)) continue;
      const held: Held = { module, state: "starting" };
      this.held.set(name, held);
      this.changed();
      try {
        const paths = await this.prepare(module);
        if (epoch !== this.epoch || this.held.get(name) !== held) return;
        const running = (this.options.supervise ?? defaultSupervise)(
          module,
          paths,
          this.seams(module, held, paths.data),
        );
        held.running = running;
        running.start();
      } catch (error) {
        if (this.held.get(name) !== held) continue;
        held.running = undefined;
        held.state = "crashed";
        this.report(module, {
          kind: "state",
          state: "crashed",
          detail: `the module could not be started: ${message(error)}`,
        });
        this.changed();
      }
    }
  }

  /** The module's code on disk, checked, and its own data directory. */
  private async prepare(module: MachineModuleV1): Promise<ModulePathsV1> {
    const code = join(
      this.options.supportDir,
      "modules",
      `${module.contentHash}.js`,
    );
    const data = join(
      this.options.supportDir,
      "module-data",
      module.pluginId,
      module.moduleId,
    );
    await mkdir(data, { recursive: true });
    let stored: Uint8Array | undefined;
    try {
      stored = await readFile(code);
    } catch {
      stored = undefined;
    }
    if (stored === undefined || sha256(stored) !== module.contentHash) {
      const bytes = await this.download(module);
      await mkdir(join(this.options.supportDir, "modules"), {
        recursive: true,
      });
      await writeAtomically(code, bytes);
    }
    return {
      deno: this.options.deno,
      runtime: this.options.runtime,
      code,
      data,
      home: this.options.home,
    };
  }

  private async download(module: MachineModuleV1): Promise<Uint8Array> {
    const credential = this.options.credential();
    if (!credential) throw new Error("this Mac is not paired");
    const path = machineRoutePathV1("module", {
      machineId: credential.machineId,
      contentHash: module.contentHash,
    });
    const response = await this.options.fetch(`${this.options.origin}${path}`, {
      headers: { authorization: `Bearer ${credential.token}` },
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(`the module route answered ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MACHINE_LIMITS_V1.moduleBytes) {
      throw new Error("the module is larger than a module may be");
    }
    // The hash is what the cloud named; bytes that do not match it are
    // somebody else's code and never reach a process.
    if (sha256(bytes) !== module.contentHash) {
      throw new Error("the module's bytes do not match its hash");
    }
    return bytes;
  }

  private seams(
    module: MachineModuleV1,
    held: Held,
    data: string,
  ): Omit<ModuleSupervisorSeamsV1, "spawn"> {
    return {
      // Step 4 of ADR 0037 wires these to the socket.
      emit: () => Promise.reject(new Error(EVENTS_LATER)),
      lastKey: () => Promise.reject(new Error(EVENTS_LATER)),
      store: jsonStore(join(data, "store.json")),
      appleEvents: (bundleId, script) =>
        this.options.appleEvents(bundleId, script),
      report: (report) => {
        this.report(module, report);
        if (report.kind === "state" && this.held.get(key(module)) === held) {
          held.state = report.state;
          this.changed();
        }
      },
    };
  }

  private report(
    module: MachineModuleV1,
    report: Parameters<ModuleSupervisorSeamsV1["report"]>[0],
  ): void {
    const address = { pluginId: module.pluginId, moduleId: module.moduleId };
    this.reports.push(
      report.kind === "state"
        ? {
            ...address,
            kind: "state",
            state: report.state,
            ...(report.detail === undefined
              ? {}
              : { detail: clip(report.detail) }),
          }
        : {
            ...address,
            kind: "log",
            level: report.level,
            text: clip(report.text),
          },
    );
    if (this.reports.length > MODULE_REPORT_QUEUE_MAX_V1) {
      this.reports.splice(0, this.reports.length - MODULE_REPORT_QUEUE_MAX_V1);
    }
  }

  /** Reports waiting to be posted. */
  pendingReports(): number {
    return this.reports.length;
  }

  /**
   * Post what is waiting, a batch at a time. A batch that fails several posts
   * in a row is dropped: reports explain, they are not a ledger.
   */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.reports.length > 0) {
        const credential = this.options.credential();
        if (!credential) return;
        const batch = this.reports.slice(0, MACHINE_LIMITS_V1.moduleReports);
        try {
          const path = machineRoutePathV1("moduleReports", {
            machineId: credential.machineId,
          });
          const response = await this.options.fetch(
            `${this.options.origin}${path}`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${credential.token}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ reports: batch }),
              redirect: "error",
            },
          );
          await response.body?.cancel();
          if (!response.ok) {
            throw new Error(`module reports answered ${response.status}`);
          }
        } catch {
          this.failures += 1;
          if (this.failures >= REPORT_ATTEMPTS) {
            this.failures = 0;
            this.reports.splice(0, batch.length);
          }
          return;
        }
        this.failures = 0;
        this.reports.splice(0, batch.length);
      }
    } finally {
      this.flushing = false;
    }
  }
}

function key(module: MachineModuleV1): string {
  return `${module.pluginId}/${module.moduleId}`;
}

/** A module's key-value store: one small JSON file, rewritten whole. */
function jsonStore(file: string): ModuleSupervisorSeamsV1["store"] {
  let queue: Promise<unknown> = Promise.resolve();
  const load = async (): Promise<Record<string, unknown>> => {
    try {
      return JSON.parse(await readFile(file, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      return {};
    }
  };
  const change = (edit: (values: Record<string, unknown>) => void) => {
    const next = queue.then(async () => {
      const values = await load();
      edit(values);
      const text = JSON.stringify(values);
      if (text.length > STORE_BYTES_MAX) {
        throw new Error("the module's store is full");
      }
      await writeAtomically(file, text);
    });
    queue = next.catch(() => undefined);
    return next;
  };
  return {
    get: async (name) => {
      const values = await load();
      return Object.hasOwn(values, name) ? values[name] : undefined;
    },
    set: (name, value) =>
      change((values) => {
        Object.defineProperty(values, name, {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }),
    delete: (name) =>
      change((values) => {
        delete values[name];
      }),
  };
}
