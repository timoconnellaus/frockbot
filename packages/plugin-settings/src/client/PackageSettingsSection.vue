<script setup lang="ts">
/**
 * The knobs of enabled Packages that configure nothing external — no model
 * provider account, no Connection — and so have no surface of their own. They
 * are still configuration, and configuration never lives in Plugins, so their
 * home is Application settings.
 */
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { computed, inject } from "vue";
import { configurablePackages } from "./package-surfaces.js";
import PackageSettingsForm from "./PackageSettingsForm.vue";

const providedWeb = inject(frockBotWebDataKey);
if (!providedWeb) throw new Error("shell client data was not provided");
const web = providedWeb;

const packages = computed(() =>
  configurablePackages({
    catalog: web.value.pluginCatalog,
    packages: web.value.userSettings?.packages ?? [],
    home: "user-settings",
  }),
);
</script>

<template>
  <div v-if="packages.length > 0" class="package-settings">
    <article
      v-for="item in packages"
      :key="item.packageId"
      class="package-settings-card"
    >
      <strong>{{ item.displayName }}</strong>
      <PackageSettingsForm :item="item" />
    </article>
  </div>
  <p v-else class="package-settings-empty">
    No enabled Package has settings of its own.
  </p>
</template>

<style scoped>
.package-settings {
  display: grid;
  gap: 12px;
}

.package-settings-card {
  padding: 12px 8px 4px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-raised);
}

.package-settings-card strong {
  padding-left: 8px;
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.package-settings-empty {
  margin: 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}
</style>
