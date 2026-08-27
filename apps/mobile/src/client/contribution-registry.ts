import type { Component } from "vue";

export interface ContributionEntry {
  slot: string;
  id: string;
  order: number;
  component: Component;
}

export interface ContributionRegistry {
  slots(): string[];
  entries(slot: string): ContributionEntry[];
  componentsFor(slot: string): Component[];
}

export function createContributionRegistry(
  entries: readonly ContributionEntry[],
): ContributionRegistry {
  const bySlot = new Map<string, ContributionEntry[]>();
  for (const entry of entries) {
    const slot = entry.slot.trim();
    if (!slot) throw new Error("contribution slot must not be empty");
    const id = entry.id.trim();
    if (!id) throw new Error("contribution id must not be empty");
    const existing = bySlot.get(slot) ?? [];
    if (existing.some((candidate) => candidate.id === id)) {
      throw new Error(
        `contribution "${id}" is already registered for slot "${slot}"`,
      );
    }
    existing.push({ ...entry, slot, id });
    bySlot.set(slot, existing);
  }
  for (const slotEntries of bySlot.values()) {
    slotEntries.sort(
      (left, right) =>
        left.order - right.order || left.id.localeCompare(right.id),
    );
  }
  return {
    slots: () => [...bySlot.keys()].sort(),
    entries: (slot) => [...(bySlot.get(slot) ?? [])],
    componentsFor: (slot) =>
      (bySlot.get(slot) ?? []).map((entry) => entry.component),
  };
}
