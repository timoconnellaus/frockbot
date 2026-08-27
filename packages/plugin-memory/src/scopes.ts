import type { MemoryScope, MemoryTier } from "./types.js";

function requireIdentity(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
}

function stableHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function createMemoryScopes(
  ownerId: string,
  agentId: string,
): Record<MemoryTier, MemoryScope> {
  const owner = requireIdentity(ownerId, "memory owner id");
  const agent = requireIdentity(agentId, "memory agent id");
  const globalHash = stableHash(`global\0${owner}`);
  const agentHash = stableHash(`agent\0${owner}\0${agent}`);
  const encodedOwner = encodeURIComponent(owner);
  const encodedAgent = encodeURIComponent(agent);
  return {
    agent: {
      tier: "agent",
      storagePrefix: `agent:${encodedOwner}:${encodedAgent}`,
      vectorNamespace: `agent:${agentHash.slice(0, 48)}`,
    },
    global: {
      tier: "global",
      storagePrefix: `global:${encodedOwner}`,
      vectorNamespace: `global:${globalHash.slice(0, 48)}`,
    },
  };
}
