<script setup lang="ts">
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { authSessionClientKey } from "@frockbot/plugin-auth/shared";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { computed, inject, onBeforeUnmount, onMounted, ref } from "vue";

const providedAuth = inject(authSessionClientKey);
const surfaces = inject(clientSurfaceRegistryKey);
const web = inject(frockBotWebDataKey);
if (!providedAuth || !surfaces || !web)
  throw new Error("settings client services were not provided");
const auth = providedAuth;
const menuOpen = ref(false);
const signOutError = ref<string>();
const developmentIdentity = computed(
  () =>
    auth.projection.value.status === "authenticated" &&
    auth.projection.value.mode === "development",
);

function closeMenu(): void {
  menuOpen.value = false;
}

function openSettings(): void {
  closeMenu();
  surfaces?.open("user-settings");
}

async function signOut(): Promise<void> {
  signOutError.value = undefined;
  try {
    await auth.signOut();
    closeMenu();
  } catch (error) {
    signOutError.value =
      error instanceof Error ? error.message : "Could not sign out";
  }
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
      <button v-if="developmentIdentity" type="button" role="menuitem" disabled>
        Sign out unavailable
      </button>
      <button
        v-else
        type="button"
        role="menuitem"
        :disabled="auth.signingOut.value"
        @click="signOut"
      >
        {{ auth.signingOut.value ? "Signing out…" : "Sign out" }}
      </button>
      <p v-if="developmentIdentity" class="profile-menu-hint">
        Local development identity is selected by the development login URL.
      </p>
      <p v-if="signOutError" class="profile-menu-error" role="alert">
        {{ signOutError }}
      </p>
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

.profile-menu button:hover:not(:disabled) {
  background: var(--frock-surface-subtle);
}

.profile-menu button:disabled {
  color: var(--frock-text-muted);
  cursor: not-allowed;
}

.profile-menu-hint,
.profile-menu-error {
  margin: 5px 10px;
  font-size: 11px;
  line-height: 1.35;
}

.profile-menu-hint {
  color: var(--frock-text-muted);
}

.profile-menu-error {
  color: var(--frock-danger-text);
}
</style>
