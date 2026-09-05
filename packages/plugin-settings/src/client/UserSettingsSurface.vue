<script setup lang="ts">
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { UiButton, UiIcon } from "@frockbot/client-ui";
import { inject } from "vue";
import SettingsFrameView from "./SettingsFrameView.vue";
const surfaces = inject(clientSurfaceRegistryKey);
</script>
<template>
  <div class="settings-form">
    <SettingsFrameView home="application" />
    <UiButton @click="surfaces?.open('models')">Models</UiButton>
    <div class="primary-contributions">
      <k-slot name="frockbot.user-settings-primary-sections" />
    </div>
    <details class="advanced">
      <summary>
        <span>Advanced</span
        ><span class="advanced__marker" aria-hidden="true"
          ><UiIcon name="arrow-down" size="sm"
        /></span>
      </summary>
      <div class="advanced__body">
        <k-slot name="frockbot.user-settings-sections" />
      </div>
    </details>
  </div>
</template>
<style scoped>
.settings-row {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-right: var(--frock-control-sm);
}

.settings-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
}

.profile-intro {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-subtle);
}

.profile-face {
  width: var(--frock-avatar-md);
  height: var(--frock-avatar-md);
  flex: 0 0 auto;
  border-radius: 50%;
  background: linear-gradient(
    135deg,
    var(--frock-surface-accent),
    var(--frock-action-primary)
  );
}

.profile-intro strong,
.profile-intro p {
  display: block;
  margin: 0;
}

.profile-intro strong {
  font-size: var(--frock-text-lg);
  font-weight: 600;
}

.profile-intro p {
  margin-top: 4px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.field-hint {
  margin: -8px 0 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.settings-error {
  margin: 0;
  color: var(--frock-danger-text);
  font-size: var(--frock-text-sm);
}

.settings-actions {
  display: flex;
  justify-content: flex-end;
}

.primary-contributions {
  display: flex;
  flex-direction: column;
  gap: var(--frock-radius-control);
}

.advanced {
  border-top: 1px solid var(--frock-border);
  padding-top: 12px;
}

.advanced summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
  font-weight: 600;
  list-style: none;
  cursor: pointer;
}

.advanced summary::-webkit-details-marker {
  display: none;
}

.advanced__marker {
  display: grid;
  place-items: center;
  transition: transform var(--frock-motion-fast);
}

.advanced[open] .advanced__marker {
  transform: rotate(180deg);
}

.advanced__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 12px;
}
</style>
