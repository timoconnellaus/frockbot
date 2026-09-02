<script setup lang="ts">
import { computed, inject } from "vue";
import { frockBotWebDataKey } from "../shared.js";
import PackageIframeHost from "./PackageIframeHost.vue";

const providedWeb = inject(frockBotWebDataKey);
if (!providedWeb)
  throw new Error("Package iframe settings data was not provided");
const web = providedWeb;
const slot = "frockbot.bot-settings-sections";
const contributions = computed(() =>
  (web.value.packageUi?.contributions ?? [])
    .flatMap((contribution) =>
      contribution.mounts
        .filter((mount) => mount.slot === slot)
        .map((mount) => ({ contribution, order: mount.order ?? 0 })),
    )
    .sort(
      (left, right) =>
        left.order - right.order ||
        left.contribution.packageId.localeCompare(right.contribution.packageId),
    ),
);

function settingsFor(packageId: string): Record<string, unknown> {
  const installation = web.value.userSettings?.packages.find(
    (candidate) => candidate.packageId === packageId,
  );
  return installation?.values ?? {};
}
</script>

<template>
  <div v-if="contributions.length > 0" class="package-iframe-settings">
    <PackageIframeHost
      v-for="entry in contributions"
      :key="entry.contribution.packageId"
      :contribution="entry.contribution"
      :slot="slot"
      state-name="settings"
      :state-value="settingsFor(entry.contribution.packageId)"
    />
  </div>
</template>

<style scoped>
.package-iframe-settings {
  display: grid;
  gap: 16px;
  min-width: 0;
}
</style>
