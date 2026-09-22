// The long-term Memory read every prompt uses.
//
// Callers ask this function, not `MemoryStore` directly, so a later Memory
// implementation can change the read without visiting each caller. The store
// behind it today is the Workspace adapter.

import type { WorkspaceMemoryRootV1 } from "@frockbot/core/contracts";
import type { ConcurrencyLimiterV1 } from "@frockbot/core/concurrency";
import { MemoryStore, type MemoryTierReadV1 } from "./store.js";

export async function readLongTermMemoryV1(
  store: Pick<MemoryStore, "read">,
  root: WorkspaceMemoryRootV1,
  options: { inFlight?: ConcurrencyLimiterV1 } = {},
): Promise<MemoryTierReadV1> {
  return store.read(root, options);
}
