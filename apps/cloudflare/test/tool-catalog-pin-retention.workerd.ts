// The Composio tool-catalog pins in real workerd SQLite, on the same Durable
// Object storage the Bot's admission, event, and settlement writes share. A
// User with one large Connection catalog used to leave a distinct ~1 MB value
// behind on every Turn, forever: the object filled and the next ordinary write
// failed. These bounds are enforced in the durable transaction, so this proves
// them where they actually run — including that reclamation deletes.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  TURN_TOOL_CATALOG_INDEX_KEY_V1,
  TURN_TOOL_CATALOG_PIN_PREFIX_V1,
  TURN_TOOL_CATALOG_TOTAL_BYTES_V1,
  TURN_TOOL_CATALOG_TURN_RETENTION_V1,
  turnToolCatalogPin,
  turnToolCatalogPinKeyV1,
} from "@frockbot/plugin-shell/tool-catalog-pin";
import { describe, expect, test } from "vitest";

const CATALOG_BYTES = 900_000;

/** A catalog the size a real Connection with hundreds of tools reaches. */
function catalog(marker: string): unknown {
  return {
    schemaVersion: 1,
    namespace: marker,
    tools: [
      {
        name: `${marker}_tool`,
        version: "20260905_00",
        description: "d".repeat(CATALOG_BYTES),
      },
    ],
  };
}

async function pinnedKeys(storage: DurableObjectStorage): Promise<string[]> {
  const stored = await storage.list<unknown>({
    prefix: TURN_TOOL_CATALOG_PIN_PREFIX_V1,
  });
  return [...stored.keys()];
}

async function pinnedBytes(storage: DurableObjectStorage): Promise<number> {
  const stored = await storage.list<unknown>({
    prefix: TURN_TOOL_CATALOG_PIN_PREFIX_V1,
  });
  return [...stored.values()].reduce<number>(
    (sum, value) =>
      sum + new TextEncoder().encode(JSON.stringify(value)).byteLength,
    0,
  );
}

describe("pinned external tool catalogs in workerd SQLite", () => {
  test("stay bounded across many Turns instead of filling the Bot's object", async () => {
    const bot = env.BOT_STATES.getByName("tool-catalog-pin-retention-bot");
    await runInDurableObject(bot, async (_instance, state) => {
      const turns = TURN_TOOL_CATALOG_TURN_RETENTION_V1 + 8;
      for (let turn = 0; turn < turns; turn++) {
        const turnId = `retention-turn-${String(turn).padStart(3, "0")}`;
        const pinned = await turnToolCatalogPin(state.storage, turnId)(
          "gmail-account",
          async () => catalog(turnId),
        );
        // Every Turn still gets the schemas it was admitted under.
        expect(pinned).toEqual(catalog(turnId));
        // And it reads the same value back without consulting the provider.
        expect(
          await turnToolCatalogPin(state.storage, turnId)("gmail-account", () =>
            Promise.reject(new Error("the pinned catalog was not durable")),
          ),
        ).toEqual(catalog(turnId));
      }

      // Twenty-four Turns wrote ~900 KB each; at most the byte budget
      // survives, and never more Turns than retention allows.
      const keys = await pinnedKeys(state.storage);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.length).toBeLessThanOrEqual(
        TURN_TOOL_CATALOG_TURN_RETENTION_V1,
      );
      expect(keys.length).toBeLessThan(turns);
      expect(await pinnedBytes(state.storage)).toBeLessThanOrEqual(
        TURN_TOOL_CATALOG_TOTAL_BYTES_V1,
      );
      expect(
        keys.includes(
          turnToolCatalogPinKeyV1("retention-turn-000", "gmail-account"),
        ),
      ).toBe(false);
      expect(
        keys.includes(
          turnToolCatalogPinKeyV1(
            `retention-turn-${String(turns - 1).padStart(3, "0")}`,
            "gmail-account",
          ),
        ),
      ).toBe(true);
      // The account of the pins is reclaimed with them: no row per Turn.
      const index = await state.storage.get<{ entries: unknown[] }>(
        TURN_TOOL_CATALOG_INDEX_KEY_V1,
      );
      expect(index?.entries).toHaveLength(keys.length);
    });
  });

  test("refuse one Turn that alone would exceed the budget", async () => {
    const bot = env.BOT_STATES.getByName("tool-catalog-pin-refusal-bot");
    await runInDurableObject(bot, async (_instance, state) => {
      const pin = turnToolCatalogPin(state.storage, "greedy-turn");
      let refusal: unknown;
      for (let connection = 0; connection < 14; connection++) {
        try {
          await pin(`account-${connection}`, async () =>
            catalog(`account-${connection}`),
          );
        } catch (error) {
          refusal = error;
          break;
        }
      }
      expect((refusal as Error | undefined)?.message).toBe(
        "The Turn's tool catalogs exceed their durable limit",
      );
      expect(await pinnedBytes(state.storage)).toBeLessThanOrEqual(
        TURN_TOOL_CATALOG_TOTAL_BYTES_V1,
      );
      // The refusal left the object usable: an ordinary write still lands.
      await state.storage.put("tool-catalog-pin-probe", { ok: true });
      expect(await state.storage.get("tool-catalog-pin-probe")).toEqual({
        ok: true,
      });
    });
  });
});
