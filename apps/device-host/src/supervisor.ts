// One device module's process, kept running for as long as the host is.
//
// The supervisor starts the process, restarts it with backoff when it dies,
// runs the calls the cloud sends it under a deadline, and answers the
// module's requests — but only within its declaration: an event it did not
// declare, a call it did not declare and an application it did not name are
// refused here, whatever the module asks for.

import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

import {
  decodeModuleFrameV1,
  MODULE_LOG_TEXT_MAX_V1,
  type HostFrameV1,
  type ModuleFrameV1,
} from "./frames.ts";

/** What the descriptor says this module may do. */
export interface ModuleDeclarationV1 {
  calls: readonly string[];
  events: readonly string[];
  appleEvents: readonly string[];
}

export type ModuleStateV1 = "starting" | "running" | "crashed" | "stopped";

/** What the supervisor tells the cloud about its module. */
export type ModuleReportV1 =
  | { kind: "state"; state: ModuleStateV1; detail?: string }
  | { kind: "log"; level: "log" | "error"; text: string };

export interface ModuleSupervisorSeamsV1 {
  /** Starts the module's process: Seatbelt around Deno around the runtime. */
  spawn(): ChildProcess;
  emit(event: string, payload: unknown, key: string): Promise<void>;
  lastKey(event: string): Promise<string | undefined>;
  store: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
  /** Runs an AppleScript that may reach only `bundleId`. */
  appleEvents(bundleId: string, script: string): Promise<string>;
  report(report: ModuleReportV1): void;
  now?(): number;
  /** Injected so a test does not wait out a real backoff. */
  delay?(ms: number): Promise<void>;
}

export type ModuleCallOutcomeV1 =
  { ok: true; value: unknown } | { ok: false; error: string };

const RESTART_FIRST_MS = 1_000;
const RESTART_MAX_MS = 60_000;
/** A process that stayed up this long resets the backoff. */
const HEALTHY_MS = 60_000;
/** The stderr lines kept to explain a crash. */
const STDERR_TAIL = 20;

export class ModuleSupervisorV1 {
  private child: ChildProcess | undefined;
  private stopping = false;
  private backoff = RESTART_FIRST_MS;
  private startedAt = 0;
  private nextCall = 0;
  private readonly calls = new Map<
    number,
    (outcome: ModuleCallOutcomeV1) => void
  >();
  private ready:
    Promise<{ calls: string[]; start: boolean } | undefined> | undefined;

  constructor(
    private readonly declaration: ModuleDeclarationV1,
    private readonly seams: ModuleSupervisorSeamsV1,
  ) {}

  private now(): number {
    return this.seams.now?.() ?? Date.now();
  }

  /** Starts the module and keeps it running until `stop`. */
  start(): void {
    this.stopping = false;
    this.launch();
  }

  /** Stops the module; a call in flight answers that it stopped. */
  stop(): void {
    this.stopping = true;
    this.child?.stdin?.end();
    this.child?.kill();
    this.child = undefined;
    this.settleAll("the module was stopped");
    this.seams.report({ kind: "state", state: "stopped" });
  }

  /** One call, answered by its deadline or refused. Never throws. */
  async call(
    call: string,
    input: unknown,
    timeoutMs: number,
  ): Promise<ModuleCallOutcomeV1> {
    if (!this.declaration.calls.includes(call)) {
      return { ok: false, error: `the module declares no call "${call}"` };
    }
    const started = await this.ready;
    const child = this.child;
    if (!started || !child?.stdin) {
      return { ok: false, error: "the module is not running" };
    }
    if (!started.calls.includes(call)) {
      return { ok: false, error: `the module exports no call "${call}"` };
    }
    const id = ++this.nextCall;
    return new Promise<ModuleCallOutcomeV1>((resolve) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        resolve({
          ok: false,
          error: `the module did not answer within ${timeoutMs}ms`,
        });
      }, timeoutMs);
      this.calls.set(id, (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      });
      this.write(child, { type: "call", id, call, input });
    });
  }

  private launch(): void {
    this.seams.report({ kind: "state", state: "starting" });
    const child = this.seams.spawn();
    this.child = child;
    this.startedAt = this.now();
    const stderr: string[] = [];
    let announce: (
      value: { calls: string[]; start: boolean } | undefined,
    ) => void;
    this.ready = new Promise((resolve) => {
      announce = resolve;
    });
    if (child.stderr) {
      createInterface({ input: child.stderr }).on("line", (line) => {
        stderr.push(line.slice(0, MODULE_LOG_TEXT_MAX_V1));
        if (stderr.length > STDERR_TAIL) stderr.shift();
      });
    }
    if (child.stdout) {
      createInterface({ input: child.stdout }).on("line", (line) => {
        if (this.child !== child) return;
        let frame: ModuleFrameV1;
        try {
          frame = decodeModuleFrameV1(line);
        } catch (error) {
          this.seams.report({
            kind: "log",
            level: "error",
            text: `the module wrote something that is not a frame: ${error instanceof Error ? error.message : String(error)}`,
          });
          child.kill();
          return;
        }
        if (frame.type === "ready") {
          announce(frame);
          this.seams.report({ kind: "state", state: "running" });
          if (frame.start) this.write(child, { type: "start" });
        } else {
          void this.handle(child, frame);
        }
      });
    }
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      announce(undefined);
      this.settleAll("the module stopped");
      if (this.stopping) return;
      const detail = [
        `exited ${signal ?? `with code ${code}`}`,
        ...stderr,
      ].join("\n");
      this.seams.report({ kind: "state", state: "crashed", detail });
      if (this.now() - this.startedAt >= HEALTHY_MS) {
        this.backoff = RESTART_FIRST_MS;
      }
      const wait = this.backoff;
      this.backoff = Math.min(this.backoff * 2, RESTART_MAX_MS);
      void (this.seams.delay ?? defaultDelay)(wait).then(() => {
        if (!this.stopping && this.child === undefined) this.launch();
      });
    });
    child.on("error", (error) => {
      this.seams.report({
        kind: "log",
        level: "error",
        text: `the module could not be started: ${error.message}`,
      });
    });
  }

  private async handle(
    child: ChildProcess,
    frame: ModuleFrameV1,
  ): Promise<void> {
    if (frame.type === "log") {
      this.seams.report({ kind: "log", level: frame.level, text: frame.text });
      return;
    }
    if (frame.type === "result") {
      const settle = this.calls.get(frame.id);
      this.calls.delete(frame.id);
      settle?.(
        frame.ok
          ? { ok: true, value: frame.value }
          : { ok: false, error: frame.error },
      );
      return;
    }
    if (frame.type !== "request") return;
    try {
      const value = await this.answer(frame.op, frame.args);
      this.write(child, { type: "reply", id: frame.id, ok: true, value });
    } catch (error) {
      this.write(child, {
        type: "reply",
        id: frame.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async answer(op: string, args: unknown[]): Promise<unknown> {
    const text = (value: unknown, what: string): string => {
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${what} must be a non-empty string`);
      }
      return value;
    };
    switch (op) {
      case "emit": {
        const event = text(args[0], "the event");
        if (!this.declaration.events.includes(event)) {
          throw new Error(`the module declares no event "${event}"`);
        }
        await this.seams.emit(event, args[1], text(args[2], "the key"));
        return null;
      }
      case "lastKey":
        return (await this.seams.lastKey(text(args[0], "the event"))) ?? null;
      case "store.get":
        return (await this.seams.store.get(text(args[0], "the key"))) ?? null;
      case "store.set":
        await this.seams.store.set(text(args[0], "the key"), args[1]);
        return null;
      case "store.delete":
        await this.seams.store.delete(text(args[0], "the key"));
        return null;
      case "appleEvents.run": {
        const bundleId = text(args[0], "the application");
        if (!this.declaration.appleEvents.includes(bundleId)) {
          throw new Error(
            `the module declares no Apple Events to "${bundleId}"`,
          );
        }
        return this.seams.appleEvents(bundleId, text(args[1], "the script"));
      }
      default:
        throw new Error(`unknown request "${op}"`);
    }
  }

  private write(child: ChildProcess, frame: HostFrameV1): void {
    child.stdin?.write(`${JSON.stringify(frame)}\n`);
  }

  private settleAll(error: string): void {
    for (const settle of this.calls.values()) settle({ ok: false, error });
    this.calls.clear();
  }
}

const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
