import {
  canonicalCommandFingerprintV1,
  type ConnectionView,
} from "@frockbot/configuration-core";
import {
  decodeConnectionTriggerCatalogV1,
  decodeRoutineSubscriptionIntentV1,
  decodeRoutineSubscriptionBindingsV1,
  type ConnectionTriggerCatalogV1,
  type ConnectionTriggerTypeV1,
  type ConnectionTriggerStatusV1,
  type RoutineSubscriptionIntentV1,
  type ConnectionEventDeliveryV1,
} from "@frockbot/connection-core";
import { ComposioClient, ComposioRequestError } from "./composio-client.js";
import type { ComposioStorage } from "./user-configuration.js";
import {
  decodeStoredComposioTriggerEvent,
  type ComposioTriggerEventV1,
} from "./webhook.js";
import { object } from "./tool-contracts.js";

const SUBS = "composio:subscriptions:v1",
  GROUPS = "composio:trigger-groups:v1";
const MAX_SUBSCRIPTIONS = 1000,
  MAX_EFFECTS = 20_000,
  MAX_EVENTS = 100_000;
const RETRY_MS = 60_000;
const EPOCH = "composio:subscription-epoch";
type Subscription = {
  schemaVersion: 1;
  botId: string;
  intent: RoutineSubscriptionIntentV1;
  groupId: string;
  revoked?: boolean;
};
type Group = {
  schemaVersion: 1;
  id: string;
  connectionId: string;
  accountId: string;
  toolkit: string;
  triggerType: string;
  config: Record<string, unknown>;
  version: string;
  name: string;
  status: ConnectionTriggerStatusV1 | "deleted";
  providerId?: string;
  repair: boolean;
  revision: number;
  effectId?: string;
  leaseUntil?: number;
  failedDesired?: "active" | "paused" | "deleted";
};
type Delivery = {
  schemaVersion: 1;
  event: ComposioTriggerEventV1;
  targets: Array<{
    id: string;
    botId: string;
    routineId: string;
    delivered: boolean;
  }>;
  status: "pending" | "complete";
};
const subKey = (id: string) => `composio:subscription:${id}`;
const groupKey = (id: string) => `composio:trigger-group:${id}`;
const canonical = (value: unknown) =>
  canonicalCommandFingerprintV1("trigger", value);
async function hash(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function subscription(value: unknown): Subscription {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    typeof value.botId !== "string" ||
    typeof value.groupId !== "string"
  )
    throw new Error("Stored event subscription is invalid");
  return {
    schemaVersion: 1,
    botId: value.botId,
    groupId: value.groupId,
    ...(value.revoked === true ? { revoked: true } : {}),
    intent: decodeRoutineSubscriptionIntentV1(value.intent),
  };
}
function group(value: unknown): Group {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    ![
      "id",
      "connectionId",
      "accountId",
      "toolkit",
      "triggerType",
      "version",
      "name",
    ].every((key) => typeof value[key] === "string") ||
    !object(value.config) ||
    typeof value.repair !== "boolean" ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    ![
      "starting",
      "active",
      "paused",
      "missing",
      "failed",
      "unavailable",
      "deleted",
    ].includes(String(value.status)) ||
    (value.providerId !== undefined && typeof value.providerId !== "string") ||
    (value.effectId !== undefined && typeof value.effectId !== "string") ||
    (value.leaseUntil !== undefined && !Number.isFinite(value.leaseUntil)) ||
    (value.failedDesired !== undefined &&
      !["active", "paused", "deleted"].includes(String(value.failedDesired)))
  )
    throw new Error("Stored event listener is invalid");
  // SAFETY: the stored DTO fields and discriminants are checked above.
  return value as unknown as Group;
}

function delivery(value: unknown): Delivery | undefined {
  if (value === undefined) return undefined;
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    !["pending", "complete"].includes(String(value.status)) ||
    !Array.isArray(value.targets) ||
    value.targets.length > MAX_SUBSCRIPTIONS
  )
    throw new Error("Stored event delivery is invalid");
  return {
    schemaVersion: 1,
    event: decodeStoredComposioTriggerEvent(value.event),
    status: value.status === "pending" ? "pending" : "complete",
    targets: value.targets.map((item) => {
      if (
        !object(item) ||
        ![item.id, item.botId, item.routineId].every(
          (id) =>
            typeof id === "string" &&
            /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id),
        ) ||
        typeof item.delivered !== "boolean"
      )
        throw new Error("Stored event destination is invalid");
      return {
        id: String(item.id),
        botId: String(item.botId),
        routineId: String(item.routineId),
        delivered: item.delivered,
      };
    }),
  };
}

/** Validate the common JSON Schema controls before recording a Routine. Provider-specific constraints remain provider refusals. */
function validateConfig(
  value: unknown,
  schema: Record<string, unknown>,
  path = "event settings",
  depth = 0,
): void {
  if (depth > 20) throw new Error("Event settings are too deeply nested");
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) => canonical(item) === canonical(value))
  )
    throw new Error(`Choose an available value for ${path}`);
  if (schema.type === "object") {
    if (!object(value)) throw new Error(`Enter an object for ${path}`);
    const properties = object(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : [])
      if (typeof key === "string" && value[key] === undefined)
        throw new Error(`Enter ${key.replaceAll("_", " ")}`);
    for (const [key, item] of Object.entries(value)) {
      if (
        !Object.hasOwn(properties, key) &&
        schema.additionalProperties === false
      )
        throw new Error(`Unrecognized event setting: ${key}`);
      if (object(properties[key]))
        validateConfig(
          item,
          properties[key],
          key.replaceAll("_", " "),
          depth + 1,
        );
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`Enter a list for ${path}`);
    if (object(schema.items))
      for (const item of value)
        validateConfig(item, schema.items, path, depth + 1);
  } else if (schema.type === "string" && typeof value !== "string")
    throw new Error(`Enter text for ${path}`);
  else if (schema.type === "boolean" && typeof value !== "boolean")
    throw new Error(`Choose yes or no for ${path}`);
  else if (
    (schema.type === "number" || schema.type === "integer") &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      (schema.type === "integer" && !Number.isInteger(value)))
  )
    throw new Error(`Enter a number for ${path}`);
  if (
    typeof value === "number" &&
    ((typeof schema.minimum === "number" && value < schema.minimum) ||
      (typeof schema.maximum === "number" && value > schema.maximum))
  )
    throw new Error(`Choose a value within the limits for ${path}`);
}

/** User-owned subscriptions, provider effects, and durable event routing. */
export class ComposioTriggerSubscriptions {
  constructor(
    private readonly host: {
      storage: ComposioStorage;
      client?: ComposioClient;
      webhookConfigured: boolean;
      connections(): Promise<ConnectionView[]>;
      deliver?(
        userId: string,
        botId: string,
        input: ConnectionEventDeliveryV1,
      ): Promise<unknown>;
    },
  ) {}
  private async wake(delay = RETRY_MS) {
    await this.host.storage.transaction(async (tx) => {
      await tx.setAlarm(
        Math.min((await tx.getAlarm?.()) ?? Infinity, Date.now() + delay),
      );
    });
  }
  private async subscriptions(): Promise<Subscription[]> {
    const ids = (await this.host.storage.get<string[]>(SUBS)) ?? [];
    return Promise.all(
      ids.map(async (id) =>
        subscription(await this.host.storage.get(subKey(id))),
      ),
    );
  }
  private async groups(): Promise<Group[]> {
    const ids = (await this.host.storage.get<string[]>(GROUPS)) ?? [];
    return Promise.all(
      ids.map(async (id) => group(await this.host.storage.get(groupKey(id)))),
    );
  }
  private async active(userId: string, connectionId: string) {
    const connection = (await this.host.connections()).find(
      (row) => row.connectionId === connectionId && row.state === "ready",
    );
    const id = connection?.safeMetadata.connectedAccountId;
    if (!connection || typeof id !== "string" || !this.host.client)
      throw new Error("This connection is unavailable");
    const account = await this.host.client.getConnectedAccount(id);
    if (
      account.id !== id ||
      account.userId !== userId ||
      account.alias !== connectionId ||
      account.status !== "ACTIVE" ||
      account.disabled ||
      account.toolkitSlug !== connection.safeMetadata.toolkitSlug
    )
      throw new Error("This connection needs reconnecting");
    const live = (await this.host.connections()).find(
      (row) => row.connectionId === connectionId && row.state === "ready",
    );
    if (!live || live.generation !== connection.generation)
      throw new Error("This connection changed before listening could start");
    return { connection, account };
  }
  async catalog(userId: string): Promise<ConnectionTriggerCatalogV1> {
    if (!this.host.client || !this.host.webhookConfigured)
      return { schemaVersion: 1, items: [] };
    const connections = (await this.host.connections()).filter(
      (row) => row.state === "ready",
    );
    const items: ConnectionTriggerTypeV1[] = [];
    for (const row of connections) {
      let active;
      try {
        active = await this.active(userId, row.connectionId);
      } catch {
        continue;
      }
      const { connection, account } = active;
      const key = `composio:trigger-types:${account.toolkitSlug}:v1`;
      let cached = await this.host.storage.get<{
        schemaVersion: number;
        expiresAt: number;
        types: Awaited<ReturnType<ComposioClient["listTriggerTypes"]>>;
      }>(key);
      if (
        !cached ||
        cached.schemaVersion !== 1 ||
        cached.expiresAt <= Date.now()
      ) {
        cached = {
          schemaVersion: 1,
          expiresAt: Date.now() + 15 * 60_000,
          types: await this.host.client.listTriggerTypes(account.toolkitSlug),
        };
        await this.host.storage.put(key, cached);
      }
      const connectorName = String(
        connection.safeMetadata.toolkitName ?? account.toolkitSlug,
      );
      for (const type of cached.types.filter((type) => !type.needsSetup))
        items.push({
          connectionId: row.connectionId,
          connectorName,
          accountName: connection.displayName,
          triggerType: type.slug,
          name: type.name.toLowerCase().includes(connectorName.toLowerCase())
            ? type.name
            : `${type.name} in ${connectorName}`,
          description: type.description,
          configSchema: type.configSchema,
          version: type.version,
        });
    }
    return decodeConnectionTriggerCatalogV1({ schemaVersion: 1, items });
  }
  async validate(
    userId: string,
    trigger: {
      connectionId: string;
      triggerType: string;
      config: Record<string, unknown>;
    },
  ): Promise<ConnectionTriggerTypeV1> {
    const selected = (await this.catalog(userId)).items.find(
      (item) =>
        item.connectionId === trigger.connectionId &&
        item.triggerType === trigger.triggerType,
    );
    if (!selected)
      throw new Error("Choose an available event from an existing connection");
    validateConfig(trigger.config, selected.configSchema);
    return selected;
  }
  async sync(userId: string, botId: string, input: unknown): Promise<void> {
    const intent = decodeRoutineSubscriptionIntentV1(input);
    const oldValue = await this.host.storage.get<unknown>(
      subKey(intent.subscriptionId),
    );
    const old = oldValue === undefined ? undefined : subscription(oldValue);
    if (
      old &&
      (old.botId !== botId || old.intent.routineId !== intent.routineId)
    )
      throw new Error("This subscription belongs to another Routine");
    if (old && old.intent.revision > intent.revision) return;
    if (old && old.intent.revision === intent.revision) {
      if (canonical(old.intent) !== canonical(intent))
        throw new Error("Routine subscription revision was reused");
      await this.reconcile(userId);
      return;
    }
    if (old && canonical(old.intent.trigger) !== canonical(intent.trigger))
      throw new Error("An event binding cannot change its account or filters");
    let nextGroup: Group | undefined;
    if (!intent.deleted && old && !intent.enabled) {
      nextGroup = group(await this.host.storage.get(groupKey(old.groupId)));
    } else if (!intent.deleted) {
      const trigger = intent.trigger!;
      const type = await this.validate(userId, trigger);
      const { account } = await this.active(userId, trigger.connectionId);
      const id = await hash(
        canonical({
          accountId: account.id,
          type: trigger.triggerType,
          config: trigger.config,
        }),
      );
      nextGroup = {
        schemaVersion: 1,
        id,
        connectionId: trigger.connectionId,
        accountId: account.id,
        toolkit: account.toolkitSlug,
        triggerType: trigger.triggerType,
        config: trigger.config,
        version: type.version,
        name: type.name,
        status: "starting",
        repair: true,
        revision: 1,
      };
    }
    // A delete may overtake the first create RPC. Retain its revision even before a provider group exists.
    await this.host.storage.transaction(async (tx) => {
      const liveValue = await tx.get<unknown>(subKey(intent.subscriptionId));
      const live =
        liveValue === undefined ? undefined : subscription(liveValue);
      if (live && live.intent.revision >= intent.revision) return;
      if (await tx.get(`composio:deleted-bot:${botId}`))
        throw new Error("This Bot was deleted");
      const ids = (await tx.get<string[]>(SUBS)) ?? [];
      if (!ids.includes(intent.subscriptionId)) {
        if (ids.length >= MAX_SUBSCRIPTIONS)
          throw new Error(
            "Your account has reached its event subscription limit",
          );
        await tx.put(SUBS, [...ids, intent.subscriptionId]);
      }
      if (nextGroup) {
        const groups = (await tx.get<string[]>(GROUPS)) ?? [];
        if (!groups.includes(nextGroup.id)) {
          if (groups.length >= MAX_SUBSCRIPTIONS)
            throw new Error(
              "Your account has reached its event listener limit",
            );
          await tx.put(GROUPS, [...groups, nextGroup.id]);
        }
        const existing = await tx.get<unknown>(groupKey(nextGroup.id));
        await tx.put(
          groupKey(nextGroup.id),
          existing === undefined
            ? nextGroup
            : {
                ...group(existing),
                repair: true,
                revision: group(existing).revision + 1,
                ...(group(existing).status === "deleted"
                  ? { status: "starting" as const }
                  : {}),
              },
        );
      }
      if (live?.groupId && live.groupId !== nextGroup?.id) {
        const previousGroup = group(await tx.get(groupKey(live.groupId)));
        await tx.put(groupKey(live.groupId), {
          ...previousGroup,
          revision: previousGroup.revision + 1,
        });
      }
      await tx.put(EPOCH, ((await tx.get<number>(EPOCH)) ?? 0) + 1);
      await tx.put(subKey(intent.subscriptionId), {
        schemaVersion: 1,
        botId,
        intent,
        groupId: nextGroup?.id ?? old?.groupId ?? "",
        // A newer explicit Routine edit may bind a reconnected account after active authorization above.
        ...(live?.revoked && (!nextGroup || !intent.enabled)
          ? { revoked: true }
          : {}),
      } satisfies Subscription);
      await tx.setAlarm(
        Math.min((await tx.getAlarm?.()) ?? Infinity, Date.now() + RETRY_MS),
      );
    });
    await this.reconcile(userId);
  }
  /** A delete is a tombstone first, so a late provider response never restores the grant. */
  async removeConnection(userId: string, connectionId: string): Promise<void> {
    await this.removeWhere(
      userId,
      (sub) => sub.intent.trigger?.connectionId === connectionId,
    );
  }
  async removeBot(userId: string, botId: string): Promise<void> {
    await this.host.storage.put(`composio:deleted-bot:${botId}`, {
      schemaVersion: 1,
    });
    await this.removeWhere(userId, (sub) => sub.botId === botId);
  }
  private async removeWhere(
    userId: string,
    matches: (sub: Subscription) => boolean,
  ): Promise<void> {
    await this.host.storage.transaction(async (tx) => {
      const ids = (await tx.get<string[]>(SUBS)) ?? [];
      for (const id of ids) {
        const sub = subscription(await tx.get(subKey(id)));
        if (!matches(sub) || sub.revoked || sub.intent.deleted) continue;
        await tx.put(EPOCH, ((await tx.get<number>(EPOCH)) ?? 0) + 1);
        await tx.put(subKey(id), { ...sub, revoked: true });
        if (sub.groupId) {
          const previousGroup = group(await tx.get(groupKey(sub.groupId)));
          await tx.put(groupKey(sub.groupId), {
            ...previousGroup,
            revision: previousGroup.revision + 1,
          });
        }
      }
      await tx.setAlarm(
        Math.min((await tx.getAlarm?.()) ?? Infinity, Date.now() + RETRY_MS),
      );
    });
    await this.reconcile(userId);
  }
  async statuses(
    userId: string,
    botId: string,
    currentBindings: unknown,
  ): Promise<
    Record<string, { status: ConnectionTriggerStatusV1; name: string }>
  > {
    const bindings = decodeRoutineSubscriptionBindingsV1(currentBindings);
    await this.reconcile(userId);
    const groups = new Map(
      (await this.groups()).map((item) => [item.id, item]),
    );
    const result: Record<
      string,
      { status: ConnectionTriggerStatusV1; name: string }
    > = {};
    for (const sub of await this.subscriptions()) {
      if (
        sub.botId !== botId ||
        bindings[sub.intent.routineId] !== sub.intent.subscriptionId
      )
        continue;
      const held = groups.get(sub.groupId);
      result[sub.intent.routineId] = {
        status:
          sub.intent.deleted ||
          sub.revoked ||
          !this.host.webhookConfigured ||
          !this.host.client
            ? "unavailable"
            : held?.status === "active" && !sub.intent.enabled
              ? "paused"
              : held?.status === "deleted"
                ? "unavailable"
                : (held?.status ?? "failed"),
        name: held?.name ?? "Service event",
      };
    }
    return result;
  }
  async reconcile(userId: string): Promise<void> {
    if (!this.host.client) return;
    for (const held of await this.groups()) {
      if (held.status === "deleted") continue;
      try {
        await this.reconcileGroup(userId, held.id);
      } catch {
        await this.wake();
      }
    }
  }
  private async reconcileGroup(userId: string, id: string) {
    const client = this.host.client!;
    let held = group(await this.host.storage.get(groupKey(id)));
    if (held.effectId && (held.leaseUntil ?? 0) > Date.now()) {
      await this.wake();
      return;
    }
    let epoch = (await this.host.storage.get<number>(EPOCH)) ?? 0;
    const connection = (await this.host.connections()).find(
      (row) => row.connectionId === held.connectionId,
    );
    const revoked =
      !connection ||
      connection.state === "revoked" ||
      connection.safeMetadata.connectedAccountId !== held.accountId;
    let instances: Awaited<ReturnType<ComposioClient["listTriggerInstances"]>>;
    try {
      instances = await client.listTriggerInstances(held.accountId);
    } catch (error) {
      if (error instanceof ComposioRequestError && error.status === 404)
        instances = [];
      else {
        await this.mark(id, { status: "unavailable" }, held, epoch);
        throw error;
      }
    }
    const instance = instances.find((item) =>
      held.providerId
        ? item.id === held.providerId
        : item.triggerType === held.triggerType &&
          canonical(item.config) === canonical(held.config),
    );
    const currentConnection = (await this.host.connections()).find(
      (row) => row.connectionId === held.connectionId,
    );
    if (currentConnection?.generation !== connection?.generation) {
      await this.wake(0);
      return;
    }
    // Bind an observed provider ID and snapshot all its references atomically.
    // Even a paused local config may normalize to an existing enabled instance.
    const snapshot = await this.host.storage.transaction(async (tx) => {
      let live = group(await tx.get(groupKey(id)));
      if (
        ((await tx.get<number>(EPOCH)) ?? 0) !== epoch ||
        live.revision !== held.revision ||
        live.effectId !== held.effectId
      )
        return undefined;
      const groups = await Promise.all(
        ((await tx.get<string[]>(GROUPS)) ?? []).map(async (key) =>
          group(await tx.get(groupKey(key))),
        ),
      );
      if (
        groups.some(
          (item) =>
            item.id !== id &&
            item.accountId === held.accountId &&
            item.triggerType === held.triggerType &&
            item.effectId &&
            (item.leaseUntil ?? 0) > Date.now(),
        )
      )
        return undefined;
      let nextEpoch = epoch;
      if (instance && live.providerId !== instance.id) {
        live = { ...live, providerId: instance.id };
        await tx.put(groupKey(id), live);
        await tx.put(EPOCH, ++nextEpoch);
      }
      const subscriptions = await Promise.all(
        ((await tx.get<string[]>(SUBS)) ?? []).map(async (key) =>
          subscription(await tx.get(subKey(key))),
        ),
      );
      return {
        held: live,
        epoch: nextEpoch,
        groups: groups.map((item) => (item.id === id ? live : item)),
        subscriptions,
      };
    });
    if (!snapshot) {
      await this.wake();
      return;
    }
    held = snapshot.held;
    epoch = snapshot.epoch;
    const shared = new Set(
      snapshot.groups
        .filter(
          (item) =>
            item.id === id ||
            (held.providerId &&
              item.providerId === held.providerId &&
              item.accountId === held.accountId),
        )
        .map((item) => item.id),
    );
    const refs = snapshot.subscriptions.filter(
      (sub) => shared.has(sub.groupId) && !sub.intent.deleted && !sub.revoked,
    );
    const ownRefs = refs.filter((sub) => sub.groupId === id);
    const wanted = (
      subscriptions: Subscription[],
    ): "active" | "paused" | "deleted" =>
      !subscriptions.length || revoked
        ? "deleted"
        : subscriptions.some((sub) => sub.intent.enabled) &&
            connection?.state === "ready" &&
            this.host.webhookConfigured
          ? "active"
          : "paused";
    const desired = wanted(refs),
      ownDesired = wanted(ownRefs);
    if (
      held.status === "failed" &&
      !held.repair &&
      held.failedDesired === desired
    )
      return;
    if (desired === "deleted" && !instance) {
      await this.mark(
        id,
        {
          status: "deleted",
          effectId: undefined,
          leaseUntil: undefined,
          repair: false,
        },
        held,
        epoch,
      );
      return;
    }
    if (!instance && held.providerId && !held.repair) {
      await this.mark(
        id,
        {
          status: "missing",
          effectId: undefined,
          leaseUntil: undefined,
        },
        held,
        epoch,
      );
      return;
    }
    if (!instance && desired === "paused") {
      await this.mark(
        id,
        {
          status: "paused",
          effectId: undefined,
          leaseUntil: undefined,
        },
        held,
        epoch,
      );
      return;
    }
    if (
      instance &&
      desired !== "deleted" &&
      instance.disabled === (desired === "paused")
    ) {
      await this.mark(
        id,
        {
          status: ownDesired,
          repair: false,
          effectId: undefined,
          leaseUntil: undefined,
        },
        held,
        epoch,
      );
      return;
    }
    if (
      instance &&
      desired !== "active" &&
      snapshot.groups.some(
        (item) =>
          item.id !== id &&
          item.accountId === held.accountId &&
          item.triggerType === held.triggerType &&
          !item.providerId &&
          (item.effectId !== undefined || item.status === "starting"),
      )
    ) {
      await this.wake();
      return;
    }
    // An external read may have overlapped another Routine write. Claim only
    // the desired state observed here; another pass reconciles any later one.
    const action =
      desired === "deleted"
        ? "delete"
        : instance
          ? desired === "active"
            ? "enable"
            : "disable"
          : "create";
    const effectId = crypto.randomUUID();
    const claimedEpoch = await this.host.storage.transaction(async (tx) => {
      const live = group(await tx.get(groupKey(id)));
      if (
        ((await tx.get<number>(EPOCH)) ?? 0) !== epoch ||
        live.revision !== held.revision ||
        live.effectId !== held.effectId ||
        (live.effectId && (live.leaseUntil ?? 0) > Date.now())
      ) {
        await tx.setAlarm(
          Math.min((await tx.getAlarm?.()) ?? Infinity, Date.now()),
        );
        return false;
      }
      for (const otherId of (await tx.get<string[]>(GROUPS)) ?? []) {
        if (otherId === id) continue;
        const other = group(await tx.get(groupKey(otherId)));
        if (other.effectId && (other.leaseUntil ?? 0) > Date.now()) {
          await tx.setAlarm(
            Math.min(
              (await tx.getAlarm?.()) ?? Infinity,
              Date.now() + RETRY_MS,
            ),
          );
          return false;
        }
      }
      const count =
        (await tx.get<number>("composio:trigger-effect-count")) ?? 0;
      if (count >= MAX_EFFECTS) {
        await tx.put(groupKey(id), { ...live, status: "failed" });
        return false;
      }
      await tx.put("composio:trigger-effect-count", count + 1);
      await tx.put(`composio:trigger-effect:${effectId}`, {
        schemaVersion: 1,
        groupId: id,
        action,
        status: "intent",
        intentAt: Date.now(),
        reconciliation:
          "Read the account/type/config instance before repeating the idempotent upsert, status change, or deletion",
      });
      await tx.put(groupKey(id), {
        ...live,
        effectId,
        leaseUntil: Date.now() + RETRY_MS,
        status: "starting",
      });
      await tx.setAlarm(
        Math.min((await tx.getAlarm?.()) ?? Infinity, Date.now() + RETRY_MS),
      );
      const nextEpoch = epoch + 1;
      await tx.put(EPOCH, nextEpoch);
      return nextEpoch;
    });
    if (claimedEpoch === false) return;
    epoch = claimedEpoch;
    let providerId = instance?.id;
    let dispatched = false;
    try {
      if (action === "create" || action === "enable") {
        const authorization = await this.active(userId, held.connectionId);
        if (authorization.account.id !== held.accountId)
          throw new Error("This listener belongs to a previous connection");
      }
      const dispatch = group(await this.host.storage.get(groupKey(id)));
      const liveConnection = (await this.host.connections()).find(
        (row) => row.connectionId === held.connectionId,
      );
      if (
        liveConnection?.generation !== connection?.generation ||
        ((await this.host.storage.get<number>(EPOCH)) ?? 0) !== epoch ||
        dispatch.revision !== held.revision ||
        dispatch.effectId !== effectId
      ) {
        await this.host.storage.transaction(async (tx) => {
          const live = group(await tx.get(groupKey(id)));
          if (live.effectId === effectId)
            await tx.put(groupKey(id), {
              ...live,
              effectId: undefined,
              leaseUntil: undefined,
            });
          await tx.put(`composio:trigger-effect:${effectId}`, {
            ...(await tx.get<Record<string, unknown>>(
              `composio:trigger-effect:${effectId}`,
            )),
            status: "cancelled-before-dispatch",
            resultAt: Date.now(),
          });
        });
        await this.wake(0);
        return;
      }
      dispatched = true;
      if (action === "create")
        providerId = await client.upsertTrigger({
          accountId: held.accountId,
          triggerType: held.triggerType,
          toolkit: held.toolkit,
          version: held.version,
          config: held.config,
        });
      else if (action === "delete") await client.deleteTrigger(providerId!);
      else await client.setTriggerEnabled(providerId!, action === "enable");
      await this.host.storage.transaction(async (tx) => {
        await tx.put(`composio:trigger-effect:${effectId}`, {
          ...(await tx.get<Record<string, unknown>>(
            `composio:trigger-effect:${effectId}`,
          )),
          status: "completed",
          resultAt: Date.now(),
          ...(providerId ? { providerId } : {}),
        });
        const live = group(await tx.get(groupKey(id)));
        // Reads begun before or during this mutation cannot settle its old
        // provider state, even when DELETE/PATCH leaves the ID unchanged.
        await tx.put(EPOCH, ((await tx.get<number>(EPOCH)) ?? 0) + 1);
        if (live.effectId === effectId)
          await tx.put(groupKey(id), {
            ...live,
            providerId,
            status: live.revision === held.revision ? ownDesired : "starting",
            repair: live.revision === held.revision ? false : live.repair,
            effectId: undefined,
            leaseUntil: undefined,
          });
      });
    } catch (error) {
      const refused =
        !dispatched ||
        (error instanceof ComposioRequestError &&
          [400, 401, 403, 404, 422].includes(error.status));
      await this.host.storage.transaction(async (tx) => {
        await tx.put(`composio:trigger-effect:${effectId}`, {
          ...(await tx.get<Record<string, unknown>>(
            `composio:trigger-effect:${effectId}`,
          )),
          status: refused ? "refused" : "unknown",
          resultAt: Date.now(),
        });
        if (dispatched)
          await tx.put(EPOCH, ((await tx.get<number>(EPOCH)) ?? 0) + 1);
      });
      await this.mark(
        id,
        {
          status: refused ? "failed" : "unavailable",
          ...(refused ? { failedDesired: desired } : {}),
          ...(refused
            ? { effectId: undefined, leaseUntil: undefined, repair: false }
            : {}),
        },
        { ...held, effectId },
      );
      await this.wake();
    }
  }
  private async mark(
    id: string,
    patch: Partial<Group>,
    observed: Group,
    observedEpoch?: number,
  ) {
    await this.host.storage.transaction(async (tx) => {
      const live = group(await tx.get(groupKey(id)));
      if (
        (observedEpoch !== undefined &&
          ((await tx.get<number>(EPOCH)) ?? 0) !== observedEpoch) ||
        live.revision !== observed.revision ||
        live.effectId !== observed.effectId
      )
        return;
      if (
        live.effectId &&
        Object.hasOwn(patch, "effectId") &&
        patch.effectId === undefined
      ) {
        const effectKey = `composio:trigger-effect:${live.effectId}`;
        const effect = await tx.get<Record<string, unknown>>(effectKey);
        if (effect?.status === "intent" || effect?.status === "unknown")
          await tx.put(effectKey, {
            ...effect,
            status: "reconciled",
            resultAt: Date.now(),
            observedStatus: patch.status,
          });
      }
      await tx.put(groupKey(id), { ...live, ...patch });
    });
  }
  async receive(userId: string, event: ComposioTriggerEventV1): Promise<void> {
    if (!this.host.client || !this.host.webhookConfigured)
      throw new Error("Event delivery is unavailable");
    const account = await this.host.client.getConnectedAccount(event.accountId);
    if (account.userId !== userId || !account.alias)
      throw new Error("Event account is unavailable");
    const authorization = await this.active(userId, account.alias);
    if (authorization.account.id !== event.accountId)
      throw new Error("This event belongs to a previous connection");
    const key = `composio:event:${await hash(event.eventId)}`;
    const previous = delivery(await this.host.storage.get<unknown>(key));
    if (previous?.status === "complete") return;
    if (!previous) {
      // A delivery can overtake the create response. Bind it through the
      // provider's confirmed configuration to a group we already issued.
      const instance = (
        await this.host.client.listTriggerInstances(event.accountId)
      ).find(
        (item) =>
          item.id === event.triggerId && item.triggerType === event.triggerType,
      );
      if (!instance) return;
      const candidates = (await this.groups()).filter(
        (item) =>
          item.connectionId === account.alias &&
          item.accountId === event.accountId &&
          item.triggerType === event.triggerType,
      );
      if (
        candidates.some(
          (item) =>
            !item.providerId &&
            (item.effectId !== undefined || item.status === "starting"),
        )
      )
        throw new Error(
          "This event is awaiting a potentially shared listener's creation result",
        );
      let sources = candidates.filter(
        (item) => item.providerId === event.triggerId,
      );
      if (!sources.length)
        sources = candidates.filter(
          (item) =>
            !item.providerId &&
            canonical(item.config) === canonical(instance.config),
        );
      if (!sources.length) {
        if (
          candidates.some(
            (item) =>
              !item.providerId &&
              item.status !== "deleted" &&
              item.status !== "failed",
          )
        )
          throw new Error(
            "This event is awaiting its listener's creation result",
          );
        return;
      }
      const sourceIds = new Set(sources.map((item) => item.id));
      const targets = (await this.subscriptions())
        .filter(
          (sub) =>
            sourceIds.has(sub.groupId) &&
            sub.intent.enabled &&
            !sub.intent.deleted &&
            !sub.revoked,
        )
        .map((sub) => ({
          id: sub.intent.subscriptionId,
          botId: sub.botId,
          routineId: sub.intent.routineId,
          delivered: false,
        }));
      await this.host.storage.transaction(async (tx) => {
        if (await tx.get(key)) return;
        const count = (await tx.get<number>("composio:event-count")) ?? 0;
        if (count >= MAX_EVENTS)
          throw new Error("Your account has reached its event history limit");
        const pending =
          (await tx.get<string[]>("composio:pending-events")) ?? [];
        if (pending.length >= 1000)
          throw new Error("Too many events are awaiting delivery");
        await tx.put("composio:event-count", count + 1);
        await tx.put("composio:pending-events", [...pending, key]);
        await tx.put(key, {
          schemaVersion: 1,
          event,
          targets,
          status: "pending",
        } satisfies Delivery);
        await tx.setAlarm(
          Math.min((await tx.getAlarm?.()) ?? Infinity, Date.now() + RETRY_MS),
        );
      });
    }
    await this.deliverEvent(userId, key);
  }
  private async deliverEvent(userId: string, key: string) {
    const record = delivery(await this.host.storage.get<unknown>(key));
    if (!record || record.status === "complete") return;
    if (!this.host.deliver) throw new Error("Routine delivery is unavailable");
    for (const target of record.targets) {
      if (target.delivered) continue;
      const live = subscription(await this.host.storage.get(subKey(target.id)));
      const connection = (await this.host.connections()).find(
        (row) => row.connectionId === live.intent.trigger?.connectionId,
      );
      const currentGroup = live.groupId
        ? group(await this.host.storage.get(groupKey(live.groupId)))
        : undefined;
      if (
        !live.intent.deleted &&
        !live.revoked &&
        live.intent.enabled &&
        currentGroup?.accountId === record.event.accountId &&
        connection?.safeMetadata.connectedAccountId ===
          record.event.accountId &&
        connection?.state === "ready"
      ) {
        await this.active(userId, live.intent.trigger!.connectionId);
        const receipt = await this.host.deliver(userId, target.botId, {
          routineId: target.routineId,
          subscriptionId: target.id,
          deliveryId: await hash(`${target.id}:${record.event.eventId}`),
          body: JSON.stringify(record.event.data),
          contentType: "application/json",
        });
        if (
          !object(receipt) ||
          (receipt.status !== "accepted" && receipt.status !== "duplicate")
        )
          throw new Error("Routine event was not admitted");
      }
      target.delivered = true;
      await this.host.storage.transaction(async (tx) => {
        const current = delivery(await tx.get<unknown>(key));
        if (!current || current.status === "complete") return;
        await tx.put(key, {
          ...current,
          targets: current.targets.map((item) =>
            item.id === target.id ? { ...item, delivered: true } : item,
          ),
        });
      });
    }
    await this.host.storage.transaction(async (tx) => {
      // Retain the event ID and destinations permanently; release payload bytes.
      const current = delivery(await tx.get<unknown>(key));
      if (
        !current ||
        current.status === "complete" ||
        current.targets.some((target) => !target.delivered)
      )
        return;
      await tx.put(key, {
        ...current,
        event: { ...record.event, data: null },
        status: "complete",
      });
      const pending = (await tx.get<string[]>("composio:pending-events")) ?? [];
      await tx.put(
        "composio:pending-events",
        pending.filter((id) => id !== key),
      );
    });
  }
  async alarm(userId: string) {
    await this.reconcile(userId);
    for (const key of (await this.host.storage.get<string[]>(
      "composio:pending-events",
    )) ?? []) {
      try {
        await this.deliverEvent(userId, key);
      } catch {
        await this.wake();
      }
    }
  }
}
