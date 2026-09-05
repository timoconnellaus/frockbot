import type { ConnectionView } from "@frockbot/configuration-core";
import { ComposioClient, ComposioRequestError } from "./composio-client.js";
import {
  decodeConnectedToolsV1,
  object,
  type ConnectedToolV1,
  type ConnectedToolsV1,
} from "./tool-contracts.js";
import type { ComposioStorage } from "./user-configuration.js";

/** User-owned live authorization and provider translation. The Bot records the external effect. */
export class ConnectedAccountTools {
  constructor(
    private readonly host: {
      client: ComposioClient;
      storage: ComposioStorage;
      connection(userId: string, connectionId: string): Promise<ConnectionView>;
    },
  ) {}
  private async active(userId: string, connectionId: string) {
    const connection = await this.host.connection(userId, connectionId);
    const id = connection.safeMetadata.connectedAccountId;
    if (typeof id !== "string")
      throw new Error("This account needs reconnecting");
    const account = await this.host.client.getConnectedAccount(id);
    if (
      account.id !== id ||
      account.userId !== userId ||
      account.toolkitSlug !== connection.safeMetadata.toolkitSlug ||
      account.status !== "ACTIVE" ||
      account.disabled ||
      !account.authConfigId
    )
      throw new Error("This account needs reconnecting");
    return { connection, account };
  }
  async list(userId: string, connectionId: string): Promise<ConnectedToolsV1> {
    const { connection, account } = await this.active(userId, connectionId);
    const key = `composio:tool-catalog:${connectionId}:v1`;
    const cached = await this.host.storage.get<{
      expiresAt: number;
      catalog: unknown;
    }>(key);
    if (cached && cached.expiresAt > Date.now())
      return decodeConnectedToolsV1(cached.catalog);
    const tools = await this.host.client.listTools(
      account.toolkitSlug,
      account.authConfigId!,
    );
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(connectionId),
    );
    const suffix = Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);
    const catalog = decodeConnectedToolsV1({
      schemaVersion: 1,
      namespace: `${account.toolkitSlug}--${suffix}`,
      label: `${connection.safeMetadata.toolkitName ?? account.toolkitSlug} — ${connection.displayName}`,
      tools,
    });
    if (
      new TextEncoder().encode(JSON.stringify(catalog)).byteLength > 1_000_000
    )
      throw new Error("This account has too many tool definitions");
    // Pin each dated definition. An in-flight Turn may still use an older
    // version after the latest catalog changes; a read never rewrites it.
    await this.host.storage.transaction(async (tx) => {
      const versions = (await tx.get<string[]>(`${key}:versions`)) ?? [];
      const additions: string[] = [];
      for (const tool of tools) {
        const id = `${tool.name}:${tool.version}`;
        const stored = await tx.get<ConnectedToolV1>(`${key}:${id}`);
        if (stored && JSON.stringify(stored) !== JSON.stringify(tool))
          throw new Error("The service changed a pinned tool definition");
        if (!stored) additions.push(id);
      }
      if (versions.length + additions.length > 10_000)
        throw new Error(
          "This account reached its tool definition history limit",
        );
      for (const tool of tools)
        await tx.put(`${key}:${tool.name}:${tool.version}`, tool);
      await tx.put(`${key}:versions`, [...versions, ...additions]);
      await tx.put(key, {
        schemaVersion: 1,
        expiresAt: Date.now() + 15 * 60_000,
        catalog,
      });
    });
    return catalog;
  }
  async execute(userId: string, value: Record<string, unknown>) {
    const {
      connectionId,
      toolName,
      version,
      arguments: args,
      effectId,
      sessionId,
    } = value;
    if (
      typeof connectionId !== "string" ||
      typeof toolName !== "string" ||
      !/^[A-Z][A-Z0-9_]{0,199}$/.test(toolName) ||
      typeof version !== "string" ||
      !/^[0-9]{8}_[0-9]+$/.test(version) ||
      !object(args) ||
      typeof effectId !== "string" ||
      !effectId ||
      effectId.length > 200 ||
      typeof sessionId !== "string" ||
      !sessionId ||
      sessionId.length > 200 ||
      new TextEncoder().encode(JSON.stringify(args)).byteLength > 64_000
    )
      throw new Error("The action request is invalid");
    const tool = await this.host.storage.get<ConnectedToolV1>(
      `composio:tool-catalog:${connectionId}:v1:${toolName}:${version}`,
    );
    if (!tool)
      throw new Error("Discover this account’s tools before using one");
    const { connection, account } = await this.active(userId, connectionId);
    if (!toolName.startsWith(`${account.toolkitSlug.toUpperCase()}_`))
      throw new Error("This tool belongs to another connector");
    // Last check is with the durable owner after all provider reads. No await
    // separates its result from starting the provider call.
    const live = await this.host.connection(userId, connectionId);
    if (live.generation !== connection.generation)
      throw new Error("This account changed before the action could start");
    try {
      const result = await this.host.client.executeTool({
        userId,
        connectedAccountId: account.id,
        toolSlug: toolName,
        version: tool.version,
        arguments: args,
      });
      if (!object(result) || typeof result.successful !== "boolean")
        throw new Error("Invalid action result");
      const content = JSON.stringify(result.data ?? {});
      if (new TextEncoder().encode(content).byteLength > 128_000)
        throw new Error("Action result exceeded its limit");
      return {
        content:
          result.successful === false
            ? "The service could not complete this action. Check the account before retrying."
            : content,
        isError: result.successful === false,
      };
    } catch (error) {
      const refused =
        error instanceof ComposioRequestError &&
        [400, 401, 403, 404, 422].includes(error.status);
      return {
        content: refused
          ? "The service refused this action. Check its inputs and connection status."
          : "The action’s outcome could not be confirmed. Do not repeat it; check the account for its result.",
        isError: true,
      };
    }
  }
}
