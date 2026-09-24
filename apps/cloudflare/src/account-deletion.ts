/**
 * The steps of deleting an account, over this Worker's bindings.
 *
 * The saga itself — its order, its record, its retries — is
 * `@frockbot/app/account/deletion`. This file is what each step does here:
 * which object, bucket, index or provider it reaches and how it knows it is
 * done. What only the User's own Durable Object can do — its Bots, its Group
 * Chats, its ledger and its Memory tables — comes in as seams, so every step
 * is testable without one.
 *
 * Each step only deletes, and each is safe to repeat: a provider answering
 * "already gone" is a deletion, never an error.
 */
import type {
  AccountDeletionRecordV1,
  AccountDeletionStepOutcomeV1,
  AccountDeletionStepV1,
} from "@frockbot/app/account/deletion";
import {
  StripeClient,
  deleteAccountCustomersV1,
} from "@frockbot/app/billing/stripe";
import { ComposioClient } from "@frockbot/app/connect/composio";
import type { MemoryVectorIndex } from "@frockbot/app/memory/types";
import {
  WORKSPACE_OBJECT_PREFIX,
  workspaceObjectPrefixV1,
} from "@frockbot/core/workspace-store";
import { stripeConfig, type BillingEnv } from "./billing.js";
import {
  computerHostBindingV1,
  createComputerHostV1,
  type ComputerHostEnvV1,
} from "./computer-host.js";
import { DEPLOYMENT_POLICY_SINGLETON_NAME } from "./deployment-policy.js";

export interface AccountDeletionEnvV1 extends BillingEnv, ComputerHostEnvV1 {
  DEPLOYMENT_POLICY?: DurableObjectNamespace;
  VOICE_ASSISTANTS?: DurableObjectNamespace;
  COMPOSIO_API_KEY?: string;
  MEMORY_FILES?: R2Bucket;
  MEMORY_INDEX?: MemoryVectorIndex;
}

/** What only the User Durable Object can do, handed to the steps. */
export interface AccountDeletionUserSeamsV1 {
  /** Deletes every Group Chat through its own delete command. */
  deleteGroupChats(): Promise<AccountDeletionStepOutcomeV1>;
  /** Deletes every Bot through the Bot delete saga. */
  deleteBots(): Promise<AccountDeletionStepOutcomeV1>;
  /** The payment customer the ledger recorded, if it recorded one. */
  recordedPaymentCustomer(): string | undefined;
  /** User and Group Chat Memory vector ids, a page at a time. */
  vectorIdsAfter(cursor: string | undefined, limit: number): string[];
  /** Forgets the sign-in identity, its sessions and linked accounts. */
  deleteIdentity(): Promise<void>;
  /** Erases the voice session object. */
  eraseVoice(): Promise<void>;
}

const COMPLETE: AccountDeletionStepOutcomeV1 = { status: "complete" };
/** One listing page, and one bulk delete, of object storage or the index. */
const PAGE = 1_000;

interface DeploymentPolicyDeletionRpc {
  closeAccountForDeletion(input: unknown): Promise<unknown>;
  forgetAccount(input: unknown): Promise<unknown>;
}

function deploymentPolicy(
  env: AccountDeletionEnvV1,
): DeploymentPolicyDeletionRpc | undefined {
  const namespace = env.DEPLOYMENT_POLICY;
  // SAFETY: the binding names DeploymentPolicy; these are its deletion doors.
  return namespace
    ? (namespace.get(
        namespace.idFromName(DEPLOYMENT_POLICY_SINGLETON_NAME),
      ) as unknown as DeploymentPolicyDeletionRpc)
    : undefined;
}

/**
 * Every object-storage prefix that holds one User's files: the User's own
 * Skills and Memory, every Plugin-declared root, and every Bot root — which
 * the Bot delete saga already removed, and which are swept again in case a
 * Bot was lost before it could be.
 *
 * Content-addressed stores — Skill bodies, Plugin artifacts and exported
 * templates — are not here. One address can hold the same bytes for two
 * accounts, so deleting it could break another account's Skill or Plugin;
 * once this account is gone nothing names them.
 */
export function accountObjectPrefixesV1(userId: string): string[] {
  const user = encodeURIComponent(userId);
  return [
    workspaceObjectPrefixV1({ kind: "user-instructions", userId }),
    workspaceObjectPrefixV1({ kind: "user-memory", userId }),
    `${WORKSPACE_OBJECT_PREFIX}/package-declared:${user}:`,
    `${WORKSPACE_OBJECT_PREFIX}/bot-instructions:${user}:`,
    `${WORKSPACE_OBJECT_PREFIX}/bot-memory:${user}:`,
  ];
}

/** One page of every prefix; done once a pass finds nothing left. */
async function deleteAccountObjects(
  bucket: R2Bucket,
  userId: string,
): Promise<AccountDeletionStepOutcomeV1> {
  let remaining = false;
  for (const prefix of accountObjectPrefixesV1(userId)) {
    const page = await bucket.list({ prefix, limit: PAGE });
    const keys = page.objects.map((object) => object.key);
    if (keys.length > 0) await bucket.delete(keys);
    if (page.truncated) remaining = true;
  }
  return remaining ? { status: "pending" } : COMPLETE;
}

/**
 * The provider's accounts and triggers for this User, found by asking the
 * provider rather than by what this application recorded: a sign-in started
 * and never finished leaves an account no Connection names. Triggers go
 * first, then the accounts, each revoked upstream.
 *
 * A pass that deleted anything is followed by one more that lists again and
 * deletes whatever it still finds, and the step then ends. A provider that
 * keeps listing an account it has accepted the deletion of is keeping its own
 * record, and a third pass would only delete it a third time.
 */
async function deleteConnectedApps(
  client: ComposioClient,
  userId: string,
  record: AccountDeletionRecordV1,
): Promise<AccountDeletionStepOutcomeV1> {
  const triggers = await client.listTriggerInstanceIds(userId);
  for (const id of triggers) await client.deleteTriggerInstance(id);
  const accounts = await client.listConnectedAccountIds(userId);
  for (const id of accounts) await client.deleteConnectedAccount(id);
  if (triggers.length + accounts.length === 0 || record.cursor === "verify")
    return COMPLETE;
  return { status: "pending", cursor: "verify" };
}

/**
 * The payment customer, which ends the subscription with it. With no
 * payments configured there is nothing to reach — unless the ledger recorded
 * a customer, which means payments were on once and a live subscription may
 * still be charging. That is refused, and retried, until someone restores
 * the configuration: finishing the deletion around it would leave the person
 * paying for an account that no longer exists.
 */
async function deletePayments(
  env: AccountDeletionEnvV1,
  userId: string,
  recorded: string | undefined,
): Promise<AccountDeletionStepOutcomeV1> {
  let config: ReturnType<typeof stripeConfig>;
  try {
    config = stripeConfig(env);
  } catch (error) {
    if (recorded === undefined) return COMPLETE;
    throw new Error(
      `payments are not configured, so customer ${recorded} cannot be deleted`,
      { cause: error },
    );
  }
  await deleteAccountCustomersV1(new StripeClient(config), userId, recorded);
  return COMPLETE;
}

/** One page of Memory vectors, deleted from the index by id. */
async function deleteMemoryVectors(
  index: MemoryVectorIndex,
  seams: AccountDeletionUserSeamsV1,
  record: AccountDeletionRecordV1,
): Promise<AccountDeletionStepOutcomeV1> {
  const page = seams.vectorIdsAfter(record.cursor, PAGE);
  if (page.length === 0) return COMPLETE;
  await index.deleteByIds(page);
  return { status: "pending", cursor: page.at(-1)! };
}

/** Runs one step of one account's deletion. */
export async function runAccountDeletionStepV1(
  env: AccountDeletionEnvV1,
  seams: AccountDeletionUserSeamsV1,
  step: AccountDeletionStepV1,
  record: AccountDeletionRecordV1,
): Promise<AccountDeletionStepOutcomeV1> {
  const { userId } = record;
  switch (step) {
    case "access":
      await deploymentPolicy(env)?.closeAccountForDeletion({
        schemaVersion: 1,
        userId,
      });
      return COMPLETE;
    case "voice":
      if (env.VOICE_ASSISTANTS) await seams.eraseVoice();
      return COMPLETE;
    case "groups":
      return seams.deleteGroupChats();
    case "bots":
      return seams.deleteBots();
    case "computer": {
      const binding = computerHostBindingV1(env);
      if (!binding) return COMPLETE;
      const host = createComputerHostV1(binding);
      if (!host.teardown)
        throw new Error("this Computer host cannot tear a Computer down");
      await host.teardown({ userId });
      return COMPLETE;
    }
    case "connected-apps":
      return env.COMPOSIO_API_KEY
        ? deleteConnectedApps(
            new ComposioClient({ apiKey: env.COMPOSIO_API_KEY }),
            userId,
            record,
          )
        : COMPLETE;
    case "payments":
      return deletePayments(env, userId, seams.recordedPaymentCustomer());
    case "files":
      return env.MEMORY_FILES
        ? deleteAccountObjects(env.MEMORY_FILES, userId)
        : COMPLETE;
    case "memory-vectors":
      return env.MEMORY_INDEX
        ? deleteMemoryVectors(env.MEMORY_INDEX, seams, record)
        : COMPLETE;
    case "identity":
      await seams.deleteIdentity();
      return COMPLETE;
    case "admission":
      await deploymentPolicy(env)?.forgetAccount({
        schemaVersion: 1,
        userId,
        ...(record.email === undefined ? {} : { email: record.email }),
      });
      return COMPLETE;
  }
}
