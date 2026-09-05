<script setup lang="ts">
/**
 * Models: which model a Bot runs on, and how to change that.
 *
 * With no model Package enabled the surface used to be one sentence in a box
 * at the top of a full-height drawer — no statement of what was running, and
 * no way to act on the advice it gave. The platform always has an answer to
 * "which model is this", so the surface leads with it, and the one thing a
 * User can do from here is a button rather than the name of another surface.
 */
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { UiAnchor, UiButton } from "@frockbot/client-ui";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { settingsLinkV1 } from "@frockbot/plugin-shell/settings-links";
import { computed, inject, onMounted, ref } from "vue";
import {
  isModelProviderPackage,
  isPackageInstalled,
  packagesForHome,
} from "./package-surfaces.js";

const providedSurfaces = inject(clientSurfaceRegistryKey);
const providedWeb = inject(frockBotWebDataKey);
if (!providedSurfaces || !providedWeb) {
  throw new Error("settings client services were not provided");
}
const surfaces = providedSurfaces;
const web = providedWeb;

const defaultModelLink = settingsLinkV1({ anchor: "user-default-model" });
const providersLink = settingsLinkV1({ anchor: "user-model-providers" });

/** The line the composer shows, which is the platform's own answer. */
const modelLabel = computed(() => web.value.modelLabel);

const installations = computed(() => web.value.userSettings?.packages ?? []);

/**
 * The Package that turns this surface into a chooser: one whose configuration
 * home is Models, that a User can turn off, and that provides no model of its
 * own — it adds the choice rather than a provider. Derived from manifest facts
 * like every other routing decision here, so a different Package taking that
 * role needs no edit to this surface.
 */
const chooser = computed(() =>
  packagesForHome(web.value.pluginCatalog, "models").find(
    (item) => !item.platformOwned && !isModelProviderPackage(item),
  ),
);

const chooserInstalled = computed(() =>
  chooser.value
    ? isPackageInstalled(installations.value, chooser.value.packageId)
    : false,
);

const enabling = ref(false);

/**
 * Turn the chooser on from here. Enablement's home is Plugins, and this is
 * that same command rather than a second one: a Package this surface is about
 * is worth one press where the User is already reading about it. A Package
 * that is not installed at all is an install decision, which belongs on
 * Plugins, so that case opens Plugins instead.
 */
async function enableChooser(): Promise<void> {
  const item = chooser.value;
  if (!item || !chooserInstalled.value) {
    surfaces.open("plugins");
    return;
  }
  enabling.value = true;
  try {
    await web.value.setPackageEnabled(item.packageId, true);
    await web.value.loadUserSettings();
  } catch (error) {
    web.value.settingsError =
      error instanceof Error
        ? error.message
        : `Could not turn on ${item.displayName}`;
  } finally {
    enabling.value = false;
  }
}

onMounted(async () => {
  await web.value.loadPluginCatalog();
  await web.value.loadUserSettings();
});
</script>

<template>
  <div class="models-surface">
    <UiAnchor
      anchor="user-default-model"
      label="Default model"
      :href="defaultModelLink"
      class="models-anchor"
    />
    <section class="models-current">
      <h3>Model in use</h3>
      <p class="models-current__name">{{ modelLabel }}</p>
    </section>
    <div class="models-sections">
      <k-slot name="frockbot.models-sections" />
    </div>
    <UiAnchor
      anchor="user-model-providers"
      label="Model providers"
      :href="providersLink"
      class="models-anchor"
    />
    <section class="models-empty">
      <p>
        FrockBot picks the model for every Bot you own and keeps it working, so
        there is nothing to set up.
      </p>
      <p>
        Turn on {{ chooser?.displayName ?? "Custom models" }} to connect your
        own provider and choose the model yourself.
      </p>
      <UiButton variant="primary" :disabled="enabling" @click="enableChooser">
        <template v-if="enabling">Turning on…</template>
        <template v-else-if="chooserInstalled">
          Turn on {{ chooser?.displayName ?? "Custom models" }}
        </template>
        <template v-else>Open Plugins</template>
      </UiButton>
    </section>
    <p v-if="web.settingsError" class="settings-error" role="alert">
      {{ web.settingsError }}
    </p>
  </div>
</template>

<style scoped>
.models-surface {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
}

.models-anchor {
  min-height: 1px;
}

.models-sections {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.models-current {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-raised);
}

.models-current h3 {
  margin: 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
  font-weight: 700;
  letter-spacing: var(--frock-tracking-eyebrow);
  text-transform: uppercase;
}

.models-current__name {
  margin: 0;
  color: var(--frock-text);
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.models-empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  margin: 0;
  padding: 12px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-subtle);
}

.models-empty p {
  margin: 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
  line-height: var(--frock-leading-normal);
}

/* With a chooser enabled the sections above are the surface; the pitch goes. */
.models-sections:not(:empty) ~ .models-empty {
  display: none;
}

.settings-error {
  margin: 0;
  color: var(--frock-danger-text);
  font-size: var(--frock-text-sm);
}
</style>
