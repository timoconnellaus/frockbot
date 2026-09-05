<script setup lang="ts">
import { UiAnchor, UiButton } from "@frockbot/client-ui";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { presentClientFailureV1 } from "@frockbot/client-core";
import type {
  Json,
  SettingsFrame,
  SettingsChangeCommand,
} from "@frockbot/protocol-schemas";
import { inject, onMounted, ref } from "vue";
import { settingsLinkV1 } from "@frockbot/plugin-shell/settings-links";
import {
  settingsFrameClientKey,
  type SettingsHome,
} from "./settings-frames.js";
import SettingsFrameSection from "./SettingsFrameSection.vue";
const props = defineProps<{ home: SettingsHome }>();
const emit = defineEmits<{ manage: [] }>();
const client = inject(settingsFrameClientKey);
const web = inject(frockBotWebDataKey);
if (!client || !web) throw new Error("Settings client was not provided");
const frame = ref<SettingsFrame>();
const pending = ref<SettingsChangeCommand>();
const busy = ref(false);
const message = ref<string>();
async function load() {
  if (busy.value) return;
  busy.value = true;
  message.value = undefined;
  try {
    pending.value = client!.pending(props.home);
    frame.value = await client!.load(props.home);
  } catch {
    message.value =
      "Couldn’t load your settings. Check your connection and try again.";
  } finally {
    busy.value = false;
  }
}
async function submit(command: SettingsChangeCommand) {
  if (busy.value) return;
  busy.value = true;
  message.value = undefined;
  let saved = false;
  try {
    const outcome = await client!.save(props.home, command);
    saved = outcome === "applied";
    message.value = saved
      ? "Saved."
      : outcome === "pending"
        ? "Your save is still processing. Check it again in a moment."
        : "These settings couldn’t be saved. Refresh Settings and try again.";
  } catch (error) {
    message.value = presentClientFailureV1(error, "save your settings");
  } finally {
    pending.value = client!.pending(props.home);
    busy.value = false;
  }
  if (saved) {
    await load();
    await web!.value.loadUserSettings();
    if (!message.value) message.value = "Saved.";
  }
}
function save(
  sectionId: string,
  values: Record<string, Json>,
  unset: string[],
) {
  if (!frame.value || pending.value) return;
  void submit({
    schemaVersion: 1,
    commandId: crypto.randomUUID(),
    expectedRevision: frame.value.revision,
    sectionId,
    values,
    ...(unset.length ? { unset } : {}),
  });
}
onMounted(load);
</script>
<template>
  <div class="settings-frame">
    <div class="frame-toolbar">
      <UiButton :disabled="busy" @click="load">Refresh</UiButton>
    </div>
    <p v-if="message" role="status" class="frame-message">{{ message }}</p>
    <div v-if="pending" class="frame-pending" role="status">
      <p>
        A save still needs to be confirmed. Check it before making another
        change.
      </p>
      <UiButton :disabled="busy" @click="submit(pending)">Check save</UiButton>
    </div>
    <div
      v-if="busy && !frame"
      class="frame-loading"
      aria-label="Loading settings"
      role="status"
    >
      <span v-for="i in 3" :key="i" />
    </div>
    <UiButton v-if="!busy && !frame" @click="load">Try again</UiButton>
    <template
      v-for="(section, index) in frame?.sections"
      :key="`${section.id}.${frame?.revision}`"
    >
      <UiAnchor
        v-if="section.id === 'profile'"
        anchor="user-profile"
        label="Your profile"
        :href="settingsLinkV1({ anchor: 'user-profile' })"
      />
      <UiAnchor
        v-if="home === 'application' && index === 1"
        anchor="user-package-settings"
        label="Plugin settings"
        :href="settingsLinkV1({ anchor: 'user-package-settings' })"
      />
      <SettingsFrameSection
        :section="section"
        :revision="frame!.revision"
        :busy="busy || !!pending"
        @save="save"
        @manage="emit('manage')"
      />
    </template>
  </div>
</template>
<style scoped>
.settings-frame {
  min-width: 0;
}
.frame-toolbar {
  display: flex;
  justify-content: flex-end;
}
.frame-message,
.frame-pending {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}
.frame-pending {
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  padding: 16px;
}
.frame-loading {
  display: grid;
  gap: 20px;
  padding: 20px 0;
}
.frame-loading span {
  display: block;
  height: 60px;
  background: var(--frock-surface-subtle);
  border-radius: var(--frock-radius-control);
}
</style>
