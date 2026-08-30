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
  height: 42px;
  align-items: center;
  gap: 9px;
  padding: 0 8px;
  color: var(--frock-text);
  background: transparent;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.profile-trigger:hover {
  background: var(--frock-surface);
}

.profile-face {
  width: 28px;
  height: 28px;
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
  bottom: 42px;
  left: 0;
  padding: 6px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-control);
  background: var(--frock-surface-raised);
  box-shadow: var(--frock-shadow-floating);
}

.profile-menu button {
  width: 100%;
  padding: 9px 10px;
  border-radius: 7px;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.profile-menu button:hover {
  background: var(--frock-surface-subtle);
}
</style>
