import type {
  ClientSurfaceRegistration,
  ClientSurfaceRegistry,
} from "@frockbot/client-core";
import { computed, readonly, ref } from "vue";

export function createClientSurfaceRegistry(): ClientSurfaceRegistry {
  const registrations = new Map<string, ClientSurfaceRegistration>();
  const activeId = ref<string>();
  const active = computed(() => {
    const id = activeId.value;
    return id ? registrations.get(id) : undefined;
  });

  return {
    active,
    activeId: readonly(activeId),
    register(registration: ClientSurfaceRegistration) {
      const id = registration.id.trim();
      if (!id) throw new Error("client surface id must be non-empty");
      if (!registration.title.trim()) {
        throw new Error("client surface title must be non-empty");
      }
      if (registrations.has(id)) {
        throw new Error(`client surface is already registered: ${id}`);
      }
      const stored = { ...registration, id };
      registrations.set(id, stored);
      return () => {
        if (registrations.get(id) !== stored) return;
        registrations.delete(id);
        if (activeId.value === id) activeId.value = undefined;
      };
    },
    has(id: string) {
      return registrations.has(id);
    },
    open(id: string) {
      if (!registrations.has(id)) {
        throw new Error(`client surface is unavailable: ${id}`);
      }
      activeId.value = id;
    },
    close() {
      activeId.value = undefined;
    },
  };
}
