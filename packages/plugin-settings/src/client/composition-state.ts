// The hosted Composition surface renders Bot Durable Object state and submits
// commands; it is never an alternate authority. Every response is decoded at
// the seam before it reaches a component.
import {
  decodeCompositionCommandReceiptV1,
  decodeCompositionGenerationListViewV1,
  decodeCompositionGenerationViewV1,
  MAX_COMPOSITION_GENERATION_PAGE_V1,
  type CompositionGenerationViewV1,
  type RevertCompositionCommandV1,
} from "@frockbot/configuration-core";
import type { InjectionKey, Ref } from "vue";
import {
  optimisticRevertGenerationsV1,
  reconcileCompositionRevertV1,
} from "./composition.js";

export interface CompositionWebData {
  botId?: string;
  loading: boolean;
  available: boolean;
  currentGenerationId?: string;
  generations: CompositionGenerationViewV1[];
  selectedGenerationId?: string;
  selected?: CompositionGenerationViewV1;
  error?: string;
  load(botId: string): Promise<void>;
  select(generationId: string | undefined): Promise<void>;
  revert(toGenerationId: string): Promise<void>;
}

export const compositionWebDataKey: InjectionKey<Ref<CompositionWebData>> =
  Symbol("frockbot-composition-web-data");

export type HostedRequest = (
  path: string,
  method?: "GET" | "POST",
  body?: string,
) => Promise<unknown>;

export interface CompositionStateDependencies {
  request?: HostedRequest;
  readAuthenticatedUserId?(): Promise<string>;
  createCommandId?(): string;
  now?(): Date;
}

function generationsPath(botId: string): string {
  return `/api/bots/${encodeURIComponent(botId)}/composition/generations`;
}

/**
 * Builds the reactive Composition state. `state` is the caller's `ref`, so the
 * Package owns the shape and the client plugin owns the reactivity primitive.
 */
export function createCompositionWebData(
  state: Ref<CompositionWebData>,
  dependencies: CompositionStateDependencies,
): CompositionWebData {
  const request = dependencies.request;
  const createCommandId =
    dependencies.createCommandId ?? (() => crypto.randomUUID());
  const now = dependencies.now ?? (() => new Date());

  async function requireUserId(): Promise<string> {
    const userId = await dependencies.readAuthenticatedUserId?.();
    if (!userId) throw new Error("Authenticated User identity is unavailable");
    return userId;
  }

  return {
    loading: false,
    available: Boolean(request),
    generations: [],
    async load(botId: string): Promise<void> {
      if (!request) {
        state.value.error = "Composition history is unavailable";
        return;
      }
      state.value.loading = true;
      state.value.error = undefined;
      try {
        const list = decodeCompositionGenerationListViewV1(
          await request(
            `${generationsPath(botId)}?limit=${MAX_COMPOSITION_GENERATION_PAGE_V1}`,
          ),
        );
        state.value.botId = botId;
        state.value.currentGenerationId = list.currentGenerationId;
        state.value.generations = list.generations;
        if (
          state.value.selectedGenerationId &&
          !list.generations.some(
            (generation) =>
              generation.generationId === state.value.selectedGenerationId,
          )
        ) {
          state.value.selectedGenerationId = undefined;
          state.value.selected = undefined;
        }
      } catch (error) {
        state.value.error =
          error instanceof Error
            ? error.message
            : "Could not load the Composition history";
      } finally {
        state.value.loading = false;
      }
    },
    async select(generationId: string | undefined): Promise<void> {
      state.value.selectedGenerationId = generationId;
      state.value.selected = undefined;
      const botId = state.value.botId;
      if (!request || !botId || !generationId) return;
      try {
        state.value.selected = decodeCompositionGenerationViewV1(
          await request(
            `${generationsPath(botId)}/${encodeURIComponent(generationId)}`,
          ),
        );
      } catch (error) {
        state.value.error =
          error instanceof Error
            ? error.message
            : "Could not load that generation";
      }
    },
    async revert(toGenerationId: string): Promise<void> {
      const botId = state.value.botId;
      const expectedGenerationId = state.value.currentGenerationId;
      if (!request || !botId || !expectedGenerationId) {
        state.value.error = "Composition history is unavailable";
        return;
      }
      const commandId = createCommandId();
      const previous = state.value.generations;
      try {
        const userId = await requireUserId();
        const command: RevertCompositionCommandV1 = {
          schemaVersion: 1,
          type: "composition/revert",
          commandId,
          botId,
          toGenerationId,
          expectedGenerationId,
        };
        state.value.generations = optimisticRevertGenerationsV1({
          generations: previous,
          botId,
          toGenerationId,
          commandId,
          createdAt: now().toISOString(),
          userId,
        });
        state.value.error = undefined;
        const receipt = decodeCompositionCommandReceiptV1(
          await request(
            `/api/bots/${encodeURIComponent(botId)}/composition/revert`,
            "POST",
            JSON.stringify(command),
          ),
        );
        const reconciled = reconcileCompositionRevertV1({
          generations: state.value.generations,
          commandId,
          receipt,
        });
        state.value.generations = reconciled.generations;
        // The authority's records are what the surface shows; the optimistic
        // entry only bridges the round trip. A rejection survives the reload,
        // because it is the answer the User asked for.
        await state.value.load(botId);
        state.value.error = reconciled.failure;
      } catch (error) {
        state.value.generations = previous;
        state.value.error =
          error instanceof Error ? error.message : "Could not revert";
      }
    },
  };
}
