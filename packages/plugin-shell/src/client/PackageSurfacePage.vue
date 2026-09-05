<script setup lang="ts">
/**
 * A Package page hosted as a surface.
 *
 * The surface's chrome — its title and the way out of it — belongs to the
 * shell; the page fills the body and is attributed to the Package that ships
 * it, so a User always knows whose screen they are looking at.
 */
import { computed, inject } from "vue";
import { frockBotWebDataKey } from "../shared.js";
import { appletsBridgeStateV2 } from "./applets-state.js";
import PackageIframeHost from "./PackageIframeHost.vue";
import type { PackageIframeEntryV1 } from "./package-iframe-entries.js";

const props = defineProps<{ entry: PackageIframeEntryV1 }>();
const providedWeb = inject(frockBotWebDataKey);
if (!providedWeb) throw new Error("Package surface data was not provided");
const web = providedWeb;
const states = computed(() => ({ applets: appletsBridgeStateV2(web.value) }));
</script>

<template>
  <div class="package-surface-page">
    <PackageIframeHost
      :contribution="props.entry.contribution"
      :page="props.entry.page"
      :slot="props.entry.slot"
      :states="states"
      :surface-title="props.entry.entry.label"
    />
  </div>
</template>

<style scoped>
.package-surface-page {
  display: grid;
  min-width: 0;
  gap: 16px;
}
</style>
