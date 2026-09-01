import type { ToolDefinition } from "@frockbot/kernel-contracts";
import type { ComputerHandle } from "@frockbot/computer-core";
import type { Plugin } from "cordis";
import {
  decodePublishPackageCommandV1,
  decodeRollbackPackageCommandV1,
  type PackageCandidateV1,
  type PackagePublicationReceiptV1,
  type PackageRevisionHistoryV1,
  type PublishPackageCommandV1,
  type RollbackPackageCommandV1,
} from "./shared.js";

export const SETUP_DIRECTORY = "/home/box/setup";
export const SETUP_APPLICATION_FILE = "dist/application.mjs";

export interface PackagePublisherAgentHost {
  read(): Promise<PackageRevisionHistoryV1>;
  publish(
    command: PublishPackageCommandV1,
  ): Promise<PackagePublicationReceiptV1>;
  rollback(
    command: RollbackPackageCommandV1,
  ): Promise<PackagePublicationReceiptV1>;
}

export interface PackagePublisherAgentConfig {
  userId: string;
  defaultProviderId: string;
}

async function executeText(
  computer: ComputerHandle,
  command: string,
  maxOutputBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (!computer.exec) {
    throw new Error("The selected Computer cannot run setup commands");
  }
  const result = await computer.exec.execute(
    {
      executable: "/bin/bash",
      args: ["-lc", command],
      timeoutMs: 120_000,
      maxOutputBytes,
    },
    { signal },
  );
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(stderr || `setup command exited ${result.exitCode}`);
  }
  if (result.outputTruncated)
    throw new Error("setup output exceeded its limit");
  return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
}

function publishCommand(
  input: unknown,
  commandId: string,
  expectedRevision: number,
): PublishPackageCommandV1 {
  return decodePublishPackageCommandV1({
    schemaVersion: 1,
    commandId,
    expectedRevision,
    candidate: input,
  });
}

function rollbackCommand(
  input: unknown,
  commandId: string,
  expectedRevision: number,
): RollbackPackageCommandV1 {
  const value =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  return decodeRollbackPackageCommandV1({
    schemaVersion: 1,
    commandId,
    expectedRevision,
    packageRevision: value.packageRevision,
  });
}

export function createPackagePublisherAgentPlugin(
  host: PackagePublisherAgentHost,
  config: PackagePublisherAgentConfig,
): Plugin.Function {
  const userId = config.userId.trim();
  const defaultProviderId = config.defaultProviderId.trim();
  if (!userId) throw new Error("Package Publisher user id must be non-empty");
  if (!defaultProviderId) {
    throw new Error("Package Publisher provider id must be non-empty");
  }
  const plugin: Plugin.Function = (ctx) => {
    const list: ToolDefinition = {
      name: "list_setup_revisions",
      // A general work tool: `executor` reach only.
      admission: { subagentRoles: ["executor"] },
      description:
        "List the immutable setup revisions published for this User and identify the active revision.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      idempotent: true,
      validate: (input) =>
        Boolean(
          input &&
          typeof input === "object" &&
          !Array.isArray(input) &&
          Object.keys(input).length === 0,
        ),
      execute: async () => ({
        content: JSON.stringify(await host.read()),
        isError: false,
      }),
    };
    const publish: ToolDefinition = {
      name: "publish_setup",
      // A general work tool: `executor` reach only.
      admission: { subagentRoles: ["executor"] },
      description: `Publish and activate the tested Git setup in ${SETUP_DIRECTORY}. The committed source is archived from HEAD, the built application is read from ${SETUP_APPLICATION_FILE}, and all required check results must be provided. This affects all Bots owned by the User.`,
      inputSchema: {
        type: "object",
        properties: {
          checks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                status: { type: "string", enum: ["passed", "failed"] },
              },
              required: ["name", "status"],
              additionalProperties: false,
            },
          },
        },
        required: ["checks"],
        additionalProperties: false,
      },
      idempotent: false,
      validate: (input) => {
        try {
          const value = input as { checks?: unknown };
          publishCommand(
            {
              source: "pending",
              applicationArtifact: "pending",
              checks: value?.checks,
            },
            "validate",
            0,
          );
          return true;
        } catch {
          return false;
        }
      },
      execute: async (input, context) => {
        // One Computer per User (ADR 0012): the assignment is keyed by the
        // User, and the Bot attaches to it as a tenant.
        const identity = { userId };
        if (!ctx.computers.assignment(identity)) {
          ctx.computers.assign(identity, defaultProviderId);
        }
        const computer = await ctx.computers.open(
          identity,
          { botId: context.botId },
          { signal: context.signal },
        );
        let candidate: PackageCandidateV1;
        try {
          await executeText(
            computer,
            `mkdir -p ${SETUP_DIRECTORY} && (git -C ${SETUP_DIRECTORY} rev-parse --git-dir >/dev/null 2>&1 || git -C ${SETUP_DIRECTORY} init)`,
            10_000,
            context.signal,
          );
          const [source, applicationArtifact] = await Promise.all([
            executeText(
              computer,
              `git -C ${SETUP_DIRECTORY} archive --format=tar HEAD | base64 -w0`,
              5_000_000,
              context.signal,
            ),
            executeText(
              computer,
              `cat ${SETUP_DIRECTORY}/${SETUP_APPLICATION_FILE}`,
              10_000_000,
              context.signal,
            ),
          ]);
          candidate = {
            source,
            applicationArtifact,
            checks: (input as { checks: PackageCandidateV1["checks"] }).checks,
          };
        } finally {
          await computer.close();
        }
        const current = await host.read();
        const receipt = await host.publish(
          publishCommand(candidate, crypto.randomUUID(), current.revision),
        );
        return {
          content: JSON.stringify(receipt),
          isError: receipt.status === "failed",
        };
      },
    };
    const rollback: ToolDefinition = {
      name: "rollback_setup",
      // A general work tool: `executor` reach only.
      admission: { subagentRoles: ["executor"] },
      description:
        "Activate an earlier immutable setup revision for all Bots owned by the User.",
      inputSchema: {
        type: "object",
        properties: { packageRevision: { type: "integer", minimum: 1 } },
        required: ["packageRevision"],
        additionalProperties: false,
      },
      idempotent: false,
      validate: (input) => {
        try {
          rollbackCommand(input, "validate", 0);
          return true;
        } catch {
          return false;
        }
      },
      execute: async (input) => {
        const current = await host.read();
        const receipt = await host.rollback(
          rollbackCommand(input, crypto.randomUUID(), current.revision),
        );
        return { content: JSON.stringify(receipt), isError: false };
      },
    };
    return [
      ctx.tools.register(list),
      ctx.tools.register(publish),
      ctx.tools.register(rollback),
      ctx.systemPrompt.register({
        id: "package-publisher-workspace",
        order: 90,
        render: () =>
          [
            "## Editable setup",
            `Edit and test the User's shared setup in ${SETUP_DIRECTORY} using the Computer.`,
            `Publishing archives the current Git HEAD and reads ${SETUP_APPLICATION_FILE} from that fixed folder; file editing itself is not owned by the Package Publisher.`,
            "Commit the intended source, run the setup's required checks, and call publish_setup only after they pass.",
          ].join("\n"),
      }),
    ];
  };
  plugin.inject = ["computers", "tools", "systemPrompt"];
  return plugin;
}
