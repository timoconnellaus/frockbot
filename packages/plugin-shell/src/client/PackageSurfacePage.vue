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
/*
 * A hosted page is a surface like any other, so it has the gutter every other
 * surface has: it used to start at the panel's left edge, which on a phone —
 * where the surface is the whole window — was a card butted against the screen
 * and stopping short of the bottom of it (2026-09-05).
 *
 * The single row stretches, so a short page fills the sheet it was opened in
 * rather than leaving the rest of it empty, and grows past it for a page with
 * more in it than the sheet is tall.
 */
.package-surface-page {
  display: grid;
  box-sizing: border-box;
  min-width: 0;
  min-height: 100%;
  gap: 16px;
  grid-template-rows: minmax(min-content, 1fr);
  padding: 16px 24px 24px;
}
</style>
