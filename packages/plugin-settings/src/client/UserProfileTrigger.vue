<script setup lang="ts">
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { inject, onBeforeUnmount, onMounted, ref } from "vue";

const surfaces = inject(clientSurfaceRegistryKey);
const web = inject(frockBotWebDataKey);
if (!surfaces || !web)
  throw new Error("settings client services were not provided");
const menuOpen = ref(false);

function closeMenu(): void {
  menuOpen.value = false;
}

function openSettings(): void {
  closeMenu();
  surfaces?.open("user-settings");
}

onMounted(() => window.addEventListener("pointerdown", closeMenu));
onBeforeUnmount(() => window.removeEventListener("pointerdown", closeMenu));
</script>

<template>
  <div class="profile-area" @pointerdown.stop>
    <button
      class="profile-trigger"
      type="button"
      :aria-expanded="menuOpen"
      aria-haspopup="menu"
      @click="menuOpen = !menuOpen"
    >
      <span class="profile-face" aria-hidden="true" />
      {{ web.userSettings?.profile.name ?? "FrockBot user" }}
    </button>
    <div v-if="menuOpen" class="profile-menu" role="menu">
      <button type="button" role="menuitem" @click="openSettings">
        Settings
      </button>
    </div>
  </div>
</template>

<style scoped>
.profile-area {
  position: relative;
}

.profile-trigger {
  display: flex;
  width: 100%;
  height: 40px;
  align-items: center;
  gap: 10px;
  padding: 0 8px;
  border-radius: var(--frock-radius-control);
  color: var(--frock-text);
  background: transparent;
  font-size: var(--frock-text-md);
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--frock-motion-fast);
}

.profile-trigger:hover,
.profile-trigger[aria-expanded="true"] {
  background: var(--frock-fill-hover);
}

.profile-trigger:active {
  background: var(--frock-fill-pressed);
}

.profile-face {
  width: var(--frock-avatar-sm);
  height: var(--frock-avatar-sm);
  flex: 0 0 auto;
  border-radius: 50%;
  background: linear-gradient(
    135deg,
    var(--frock-surface-accent),
    var(--frock-action-primary)
  );
}

.profile-menu {
  position: absolute;
  z-index: var(--frock-layer-menu);
  right: 0;
  bottom: 44px;
  left: 0;
  padding: 6px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-control);
  background: var(--frock-surface-raised);
  box-shadow: var(--frock-shadow-floating);
  animation: frock-rise-in var(--frock-motion-fast) both;
}

.profile-menu button {
  width: 100%;
  padding: 8px 10px;
  border-radius: 7px;
  background: transparent;
  font-size: var(--frock-text-base);
  text-align: left;
  cursor: pointer;
  transition: background-color var(--frock-motion-fast);
}

.profile-menu button:hover {
  background: var(--frock-fill-hover);
}
</style>
