// A Durable Object that drives `ComputerHostClient` the way the Bot Durable
// Object will.
//
// The client is exercised from inside a real Durable Object, against real
// Durable Object storage, rather than from a plain test function, because two
// of the things it has to get right are only true there: `env.COMPUTER_HOST`
// is a workerd `Fetcher` (not a `fetch` polyfill), and a Computer effect is
// supposed to leave a durable record — "A mutation or process launch records
// intent and an effect identifier in the Bot's Durable Object ... before it
// runs, so recovery can read its outcome or classify it as unknown without
// repeating it."
//
// So every call here writes `pending` before it goes out and overwrites it
// with the outcome after. A test can then assert the recovery property
// directly: after a refusal, storage says what happened, and after a
// cancellation it says the effect is unresolved rather than lost.
import { DurableObject } from "cloudflare:workers";
import { ComputerError } from "@frockbot/computer-core";
import { ComputerHostClient } from "@frockbot/plugin-fly-sprite/host-client";

interface ProbeEnv {
  COMPUTER_HOST: Fetcher;
  COMPUTER_HOST_TOKEN: string;
}

/** What one recorded effect looks like in Durable Object storage. */
export interface ProbeEffectRecord {
  effectId: string;
  userId: string;
  botId: string;
  status: "pending" | "completed" | "refused";
  code?: string;
  retryable?: boolean;
  detail?: string;
  exitCode?: number | null;
}

export interface ProbeExecInput {
  effectId: string;
  script: string;
  userId?: string;
  botId?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  stream?: boolean;
  /** Aborts the caller's signal after this many milliseconds. */
  abortAfterMs?: number;
}

export interface ProbeExecOutput {
  ok: boolean;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  outputTruncated?: boolean;
  code?: string;
  retryable?: boolean;
  message?: string;
}

const decoder = new TextDecoder();

function refusal(error: unknown): ProbeExecOutput {
  if (error instanceof ComputerError) {
    return {
      ok: false,
      code: error.code,
      retryable: error.retryable,
      message: error.message,
    };
  }
  return {
    ok: false,
    code: "unexpected",
    retryable: false,
    message: error instanceof Error ? error.message : String(error),
  };
}

export class ComputerHostClientProbe extends DurableObject<ProbeEnv> {
  private client(userId: string, botId: string): ComputerHostClient {
    return new ComputerHostClient({
      fetcher: this.env.COMPUTER_HOST,
      hostToken: this.env.COMPUTER_HOST_TOKEN,
      identity: { userId },
      tenant: { botId },
    });
  }

  private async record(effect: ProbeEffectRecord): Promise<void> {
    await this.ctx.storage.put(`effect:${effect.effectId}`, effect);
  }

  async effects(): Promise<ProbeEffectRecord[]> {
    const held = await this.ctx.storage.list<ProbeEffectRecord>({
      prefix: "effect:",
    });
    return [...held.values()];
  }

  async clear(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  async exec(input: ProbeExecInput): Promise<ProbeExecOutput> {
    const userId = input.userId ?? "user-probe";
    const botId = input.botId ?? "bot-probe";
    // Intent first, and durably: the effect exists in storage before anything
    // reaches the Computer, so a Durable Object that is evicted mid-exec finds
    // an effect it can reconcile rather than one it never heard of.
    await this.record({
      effectId: input.effectId,
      userId,
      botId,
      status: "pending",
    });
    const controller = new AbortController();
    if (input.abortAfterMs !== undefined) {
      setTimeout(() => controller.abort(), input.abortAfterMs);
    }
    try {
      const outcome = await this.client(userId, botId).exec(
        {
          script: input.script,
          ...(input.timeoutMs === undefined
            ? {}
            : { timeoutMs: input.timeoutMs }),
          ...(input.maxOutputBytes === undefined
            ? {}
            : { maxOutputBytes: input.maxOutputBytes }),
          ...(input.stream === undefined ? {} : { stream: input.stream }),
        },
        { effectId: input.effectId, signal: controller.signal },
      );
      await this.record({
        effectId: input.effectId,
        userId,
        botId,
        status: "completed",
        exitCode: outcome.exitCode,
      });
      return {
        ok: true,
        exitCode: outcome.exitCode,
        stdout: decoder.decode(outcome.stdout),
        stderr: decoder.decode(outcome.stderr),
        outputTruncated: outcome.outputTruncated,
      };
    } catch (error) {
      const refused = refusal(error);
      // A refusal is durable too. "Failures are observable through durable
      // state rather than existing only in process logs or client memory."
      await this.record({
        effectId: input.effectId,
        userId,
        botId,
        status: "refused",
        ...(refused.code ? { code: refused.code } : {}),
        ...(refused.retryable === undefined
          ? {}
          : { retryable: refused.retryable }),
        ...(refused.message ? { detail: refused.message.slice(0, 512) } : {}),
      });
      return refused;
    }
  }

  async open(input: {
    effectId: string;
    userId?: string;
    botId?: string;
  }): Promise<{ ok: boolean; spriteName?: string; code?: string }> {
    const userId = input.userId ?? "user-probe";
    const botId = input.botId ?? "bot-probe";
    try {
      const result = await this.client(userId, botId).open({
        effectId: input.effectId,
        // Presence always supplies this observer. Keeping it here proves that
        // a service binding preserves the streamed open body in workerd.
        onProgress: () => undefined,
      });
      return { ok: true, spriteName: result.spriteName };
    } catch (error) {
      const refused = refusal(error);
      return { ok: false, ...(refused.code ? { code: refused.code } : {}) };
    }
  }

  /** Drives the file surface, which the Workspace fast path will use next. */
  async fileRoundTrip(input: {
    effectId: string;
    path: string;
    text: string;
    userId?: string;
  }): Promise<{ ok: boolean; text?: string; code?: string }> {
    const userId = input.userId ?? "user-probe";
    const client = this.client(userId, "bot-probe");
    try {
      await client.fileWrite(input.path, new TextEncoder().encode(input.text), {
        effectId: `${input.effectId}-write`,
      });
      const read = await client.fileRead(input.path, {
        effectId: `${input.effectId}-read`,
      });
      return {
        ok: true,
        text: decoder.decode(
          Uint8Array.from(atob(read.bytesBase64), (character) =>
            character.charCodeAt(0),
          ),
        ),
      };
    } catch (error) {
      const refused = refusal(error);
      return { ok: false, ...(refused.code ? { code: refused.code } : {}) };
    }
  }

  /** A wrong token must be refused before anything reaches a Computer. */
  async execWithWrongToken(input: {
    effectId: string;
    script: string;
  }): Promise<ProbeExecOutput> {
    const client = new ComputerHostClient({
      fetcher: this.env.COMPUTER_HOST,
      hostToken: "not-the-host-token",
      identity: { userId: "user-probe" },
      tenant: { botId: "bot-probe" },
    });
    try {
      await client.exec({ script: input.script }, { effectId: input.effectId });
      return { ok: true };
    } catch (error) {
      return refusal(error);
    }
  }

  /** Posts a body the host's own decoder must refuse at the seam. */
  async postUndecodable(body: unknown): Promise<{ status: number }> {
    const response = await this.env.COMPUTER_HOST.fetch(
      new Request("http://computer-host.internal/v1/computer/exec", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-frockbot-host-token": this.env.COMPUTER_HOST_TOKEN,
        },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status };
  }
}
