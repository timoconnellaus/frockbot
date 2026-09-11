import type {
  ConnectionCommandReceiptV1,
  ModelOAuthCommandV1,
  ModelOAuthProgressV1,
} from "@frockbot/core/connection";
import type {
  CredentialTransaction,
  PreparedApiKeyCredential,
} from "@frockbot/app/credentials/user";
import type { OllamaUserBackendHost } from "../ollama-cloud/user.js";
import {
  startOAuthV1,
  pollOAuthV1,
  encodeOAuthTokenV1,
  type OAuthFlowV1,
  type OAuthProviderIdV1,
  type OAuthTokenV1,
} from "./oauth-protocol.js";
interface Attempt {
  accountId: string;
  attemptId: string;
  label: string;
  callbackUrl?: string;
  state:
    | "starting"
    | "waiting"
    | "polling"
    | "installing"
    | "ready"
    | "failed"
    | "cancelled";
  expiresAt: number;
  nextPollAt: number;
  public?: ModelOAuthProgressV1;
  browserSecret?: PreparedApiKeyCredential;
  sealed?: PreparedApiKeyCredential;
  connectionId?: string;
}
/** One durable, encrypted state machine per User/provider. Network exchanges are never reconstructed after eviction. */
export class ModelOAuthUserV1 {
  private readonly running = new Map<
    string,
    Promise<ConnectionCommandReceiptV1>
  >();
  private readonly prefix: string;
  private readonly now: () => number;
  constructor(
    private readonly provider: OAuthProviderIdV1,
    private readonly host: OllamaUserBackendHost,
    private readonly install: (
      accountId: string,
      attemptId: string,
      label: string,
      token: string,
    ) => Promise<ConnectionCommandReceiptV1>,
  ) {
    this.prefix = `model-oauth:${provider}:`;
    this.now = host.now ?? Date.now;
  }
  async execute(
    accountId: string,
    command: ModelOAuthCommandV1,
  ): Promise<ConnectionCommandReceiptV1> {
    if (
      command.packageId !== `provider-${this.provider}` ||
      !(await this.host.settings.isPackageInstalled(
        accountId,
        command.packageId,
      ))
    )
      throw new Error("OAuth provider is not enabled");
    // User identity is checked even when joining an in-flight operation.
    await this.host.settings.read(accountId);
    if (command.browserKey) {
      const stored = await this.host.storage.get<Attempt>(
        this.prefix + "attempt:" + command.attemptId,
      );
      if (
        command.action === "start" ||
        !stored?.browserSecret ||
        stored.accountId !== accountId ||
        stored.expiresAt <= this.now() ||
        (await this.host.credentials.openPreparedSecret(
          stored.browserSecret,
        )) !== JSON.stringify(command.browserKey)
      )
        throw new Error("Sign-in link is invalid or expired");
    }
    const running = this.running.get(command.attemptId);
    if (running) {
      await running;
      return this.execute(accountId, command);
    }
    const work = this.advance(accountId, command);
    this.running.set(command.attemptId, work);
    try {
      const receipt = await work;
      if (command.action === "start" && receipt.oauth?.status === "waiting") {
        const stored = await this.host.storage.get<Attempt>(
          this.prefix + "attempt:" + command.attemptId,
        );
        if (stored?.browserSecret)
          receipt.oauth.browserKey = JSON.parse(
            await this.host.credentials.openPreparedSecret(
              stored.browserSecret,
            ),
          );
      }
      return receipt;
    } finally {
      if (this.running.get(command.attemptId) === work)
        this.running.delete(command.attemptId);
    }
  }
  private receipt(a: Attempt, commandId: string): ConnectionCommandReceiptV1 {
    return {
      schemaVersion: 1,
      commandId,
      connectionId: a.connectionId ?? a.attemptId,
      status: a.state === "failed" ? "failed" : "applied",
      oauth: {
        attemptId: a.attemptId,
        status:
          a.state === "ready"
            ? "ready"
            : a.state === "cancelled"
              ? "cancelled"
              : a.state === "failed"
                ? "failed"
                : "waiting",
        ...(a.state === "waiting" ? a.public : {}),
        ...(a.state === "failed"
          ? { message: "Sign-in could not finish. Start a new sign-in." }
          : {}),
      },
    };
  }
  private async save(a: Attempt) {
    await this.host.storage.transaction(
      async (storage: CredentialTransaction) => {
        await storage.put(this.prefix + "attempt:" + a.attemptId, a);
        await this.schedule(a, storage);
      },
    );
  }
  private async seal(a: Attempt, value: unknown) {
    return this.host.credentials.prepareApiKey({
      accountId: a.accountId,
      packageId: `provider-${this.provider}`,
      connectionId: a.attemptId,
      generation: a.attemptId,
      apiKey: JSON.stringify(value),
    });
  }
  private async advance(
    accountId: string,
    command: ModelOAuthCommandV1,
  ): Promise<ConnectionCommandReceiptV1> {
    const key = this.prefix + "attempt:" + command.attemptId;
    let a = await this.host.storage.get<Attempt>(key);
    if (a && a.accountId !== accountId)
      throw new Error("OAuth attempt belongs to another account");
    if (!a) {
      if (command.action !== "start")
        throw new Error("Sign-in attempt is unavailable");
      a = {
        accountId,
        attemptId: command.attemptId,
        label: command.label ?? this.provider,
        callbackUrl: command.callbackUrl,
        state: "starting",
        expiresAt: this.now() + 1800000,
        nextPollAt: this.now(),
      };
      a.browserSecret = await this.seal(
        a,
        crypto.randomUUID() + crypto.randomUUID(),
      );
      await this.host.storage.transaction(
        async (storage: CredentialTransaction) => {
          const indexKey = this.prefix + "index";
          const ids = (await storage.get<string[]>(indexKey)) ?? [];
          const retained: string[] = [];
          for (const id of ids) {
            const old = await storage.get<Attempt>(
              this.prefix + "attempt:" + id,
            );
            if (old && old.expiresAt + 86400000 > this.now()) retained.push(id);
            else await storage.delete(this.prefix + "attempt:" + id);
          }
          if (retained.length >= 16)
            throw new Error("Too many sign-in attempts; try again later");
          await storage.put(indexKey, [...retained, a!.attemptId]);
          await storage.put(key, a);
          await this.schedule(a!, storage);
        },
      );
      try {
        const flow = await startOAuthV1(
          this.provider,
          crypto.randomUUID(),
          command.callbackUrl,
          this.now(),
        );
        a = {
          ...a,
          state: "waiting",
          expiresAt: flow.expiresAt,
          nextPollAt: this.now() + flow.intervalMs,
          sealed: await this.seal(a, flow),
          public: {
            attemptId: a.attemptId,
            status: "waiting",
            authorizationUrl: flow.authorizationUrl,
            expiresAt: flow.expiresAt,
            pollAfterMs: flow.intervalMs,
            ...(flow.userCode ? { userCode: flow.userCode } : {}),
            ...(flow.verifier ? { manualCode: true } : {}),
          },
        };
        await this.save(a);
        await this.schedule(a);
      } catch {
        a = { ...a, state: "failed", sealed: undefined, public: undefined };
        await this.save(a);
      }
      return this.receipt(a, command.commandId);
    }
    if (
      command.action === "start" &&
      (a.label !== (command.label ?? this.provider) ||
        a.callbackUrl !== command.callbackUrl)
    )
      throw new Error("Sign-in attempt ID was reused");
    if (["ready", "failed", "cancelled"].includes(a.state))
      return this.receipt(a, command.commandId);
    if (command.action === "cancel" || this.now() >= a.expiresAt) {
      a = {
        ...a,
        state: command.action === "cancel" ? "cancelled" : "failed",
        sealed: undefined,
        public: undefined,
      };
      await this.save(a);
      return this.receipt(a, command.commandId);
    }
    // A process stopped after recording intent but before recording the response.
    if (a.state === "starting" || a.state === "polling") {
      a = { ...a, state: "failed", sealed: undefined, public: undefined };
      await this.save(a);
      return this.receipt(a, command.commandId);
    }
    try {
      if (a.state === "waiting") {
        if (
          command.action === "start" ||
          (this.provider === "openrouter" && !command.code) ||
          this.now() < a.nextPollAt
        ) {
          await this.schedule(a);
          return this.receipt(a, command.commandId);
        }
        const flow = JSON.parse(
          await this.host.credentials.openPreparedSecret(a.sealed!),
        ) as OAuthFlowV1;
        a = { ...a, state: "polling" };
        await this.save(a);
        const result = await pollOAuthV1(
          this.provider,
          flow,
          command.code,
          this.now(),
        );
        if (typeof result === "string") {
          if (result === "slow-down") flow.intervalMs += 5000;
          a = {
            ...a,
            state: "waiting",
            nextPollAt: this.now() + flow.intervalMs,
            sealed: await this.seal(a, flow),
            public: { ...a.public!, pollAfterMs: flow.intervalMs },
          };
          await this.save(a);
          await this.schedule(a);
          return this.receipt(a, command.commandId);
        }
        a = {
          ...a,
          state: "installing",
          sealed: await this.seal(a, result),
          public: undefined,
        };
        await this.save(a);
      }
      const token = JSON.parse(
        await this.host.credentials.openPreparedSecret(a.sealed!),
      ) as OAuthTokenV1;
      const receipt = await this.install(
        accountId,
        a.attemptId,
        a.label,
        encodeOAuthTokenV1(token),
      );
      a = {
        ...a,
        connectionId: receipt.connectionId,
        state: receipt.status === "applied" ? "ready" : "failed",
        sealed: undefined,
        public: undefined,
      };
      await this.save(a);
    } catch {
      // Connection installation has its own durable idempotency key and may resume.
      // Token exchanges cannot: a rotating or one-use token might already be consumed.
      if (a.state !== "installing")
        a = { ...a, state: "failed", sealed: undefined, public: undefined };
      await this.save(a);
    }
    return this.receipt(a, command.commandId);
  }
  private async schedule(
    a: Attempt,
    storage: CredentialTransaction = this.host.storage,
  ) {
    if (["ready", "failed", "cancelled"].includes(a.state)) return;
    const due =
      a.state !== "waiting"
        ? this.now() + 60000
        : this.provider === "openrouter"
          ? a.expiresAt
          : Math.min(a.nextPollAt, a.expiresAt);
    const existing = await storage.getAlarm?.();
    if (existing == null || existing <= this.now() || due < existing)
      await storage.setAlarm?.(due);
  }
  async alarm() {
    for (const id of (await this.host.storage.get<string[]>(
      this.prefix + "index",
    )) ?? []) {
      const a = await this.host.storage.get<Attempt>(
        this.prefix + "attempt:" + id,
      );
      if (!a || ["ready", "failed", "cancelled"].includes(a.state)) continue;
      if (
        a.state === "waiting" &&
        this.now() < a.nextPollAt &&
        this.now() < a.expiresAt
      ) {
        await this.schedule(a);
        continue;
      }
      try {
        await this.execute(a.accountId, {
          schemaVersion: 1,
          type: "connection/oauth",
          action: "check",
          packageId: `provider-${this.provider}`,
          attemptId: id,
          commandId: `oauth-poll-${id}`,
        });
      } catch {
        await this.save({
          ...a,
          state: "cancelled",
          sealed: undefined,
          public: undefined,
        });
      }
    }
  }
}
