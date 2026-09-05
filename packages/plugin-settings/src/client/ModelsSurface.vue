<script setup lang="ts">
/**
 * Models: which model a Bot runs on, and how to change that.
 *
 * With no model Package enabled the surface used to be one sentence in a box
 * at the top of a full-height drawer — no statement of what was running, and
 * no way to act on the advice it gave. The platform always has an answer to
 * "which model is this", so the surface leads with it, and the way on is a
 * button rather than the name of another surface.
 *
 * What it does not do is make the decision itself. Turning a Package on is
 * Plugins' to own and every control has exactly one home (AGENTS.md,
 * "Settings surfaces"), so this surface says why there is nothing to choose
 * from and opens the surface where that is settled.
 */
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { UiAnchor, UiButton } from "@frockbot/client-ui";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { settingsLinkV1 } from "@frockbot/plugin-shell/settings-links";
import { computed, inject, onMounted } from "vue";
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

/** What this surface can offer once it has said why it is empty. */
const chooserName = computed(
  () => chooser.value?.displayName ?? "Custom models",
);

/**
 * Why the provider choices are not here, in the words of the Package that
 * would bring them.
 *
 * A Package that is installed but off is a switch to flip; one that is not
 * installed yet is an addition to make. Both decisions are Plugins', and this
 * surface only says which one is waiting there.
 */
const reason = computed(() =>
  chooserInstalled.value
    ? `${chooserName.value} is installed but turned off, so there are no providers or models to choose from here.`
    : `${chooserName.value} is not installed, so there are no providers or models to choose from here.`,
);

/**
 * Enablement's home is Plugins, and a control has exactly one home
 * (AGENTS.md, "Settings surfaces"). This surface used to run the enable
 * command itself, which made the same decision available in two places; it
 * now explains what is missing and opens the surface that owns the decision.
 */
function openPlugins(): void {
  surfaces.open("plugins");
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
      <p>{{ reason }}</p>
      <p>
        Turning {{ chooserName }} on is done in Plugins, where every plugin is
        added and switched on or off.
      </p>
      <UiButton variant="primary" @click="openPlugins"> Open Plugins </UiButton>
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
