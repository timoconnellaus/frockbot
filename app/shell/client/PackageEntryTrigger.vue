<script setup lang="ts">
/**
 * One declarative Package entry in the sidebar.
 *
 * Everything drawn here is manifest data — the label, the icon name, and the
 * page the entry opens — so a Package reaches the sidebar without running any
 * code in the app origin. The icon is looked up in the shared set; a Package
 * naming an icon this client does not have falls back to the generic one
 * rather than drawing nothing.
 */
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { UiIcon, uiIconPaths, type UiIconName } from "@frockbot/client-ui";
import { computed, inject } from "vue";
import type { PackageIframeEntryV1 } from "./package-iframe-entries.js";

const props = defineProps<{ entry: PackageIframeEntryV1 }>();
const surfaces = inject(clientSurfaceRegistryKey);
if (!surfaces) throw new Error("client surface registry was not provided");

const icon = computed<UiIconName>(() =>
  Object.hasOwn(uiIconPaths, props.entry.entry.icon)
    ? (props.entry.entry.icon as UiIconName)
    : "plugins",
);

function open(): void {
  if (surfaces?.has(props.entry.surfaceId))
    surfaces.open(props.entry.surfaceId);
}
</script>

<template>
  <button class="package-entry-trigger" type="button" @click="open">
    <span class="package-entry-trigger__icon"><UiIcon :name="icon" /></span>
    {{ entry.entry.label }}
  </button>
</template>

<style scoped>
.package-entry-trigger {
  display: flex;
  width: 100%;
  height: 40px;
  align-items: center;
  gap: 10px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--frock-radius-control);
  color: var(--frock-text);
  background: transparent;
  font-size: var(--frock-text-md);
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--frock-motion-fast);
}

.package-entry-trigger:hover {
  background: var(--frock-fill-hover);
}

.package-entry-trigger:active {
  background: var(--frock-fill-pressed);
}

.package-entry-trigger__icon {
  display: grid;
  width: var(--frock-avatar-sm);
  height: var(--frock-avatar-sm);
  flex: 0 0 auto;
  place-items: center;
  border-radius: 8px;
  color: var(--frock-action-primary);
  background: var(--frock-surface);
  box-shadow: inset 0 0 0 1px var(--frock-border);
}
</style>
