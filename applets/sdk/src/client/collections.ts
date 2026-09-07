/**
 * The TanStack DB adapter: one collection per declared table, synced from the
 * Applet socket and mutated back over it.
 *
 * `sync` applies `snapshot` and `changes`; `onInsert`/`onUpdate`/`onDelete`
 * send one `mutate` frame and return its promise, so an `ack` confirms the
 * optimistic write and a `reject` rolls it back.
 */

import { createCollection, type Collection } from "@tanstack/db";

import type { AppletMutationV1 } from "../protocol/index.js";
import type { AppletTransport } from "./transport.js";

export type AppletRow = Record<string, unknown> & { id: string };

export function createAppletCollection(
  name: string,
  transport: AppletTransport,
): Collection<AppletRow, string> {
  return createCollection<AppletRow, string>({
    id: `applet:${name}`,
    getKey: (row) => row.id,
    startSync: true,
    sync: {
      // The server always sends the whole row on update.
      rowUpdateMode: "full",
      sync: ({ begin, write, commit, markReady, truncate }) =>
        transport.registerTable(name, {
          begin: () => begin(),
          write: (message) => {
            if (message.type === "delete") {
              write({ type: "delete", key: message.key! });
              return;
            }
            write({ type: message.type, value: message.value as AppletRow });
          },
          commit: () => {
            commit();
          },
          markReady,
          truncate,
        }),
    },
    onInsert: ({ transaction }) =>
      transport.mutate(
        transaction.mutations.map((mutation): AppletMutationV1 => ({
          table: name,
          op: "insert",
          key: String(mutation.key),
          value: mutation.modified as Record<string, unknown>,
        })),
      ),
    onUpdate: ({ transaction }) =>
      transport.mutate(
        transaction.mutations.map((mutation): AppletMutationV1 => ({
          table: name,
          op: "update",
          key: String(mutation.key),
          value: mutation.changes as Record<string, unknown>,
        })),
      ),
    onDelete: ({ transaction }) =>
      transport.mutate(
        transaction.mutations.map((mutation): AppletMutationV1 => ({
          table: name,
          op: "delete",
          key: String(mutation.key),
        })),
      ),
  });
}
