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
const isAdmin = computed(
  () =>
    auth.projection.value.status === "authenticated" &&
    auth.projection.value.user.isAdmin,
);

function closeMenu(): void {
  menuOpen.value = false;
}

function openSurface(id: string): void {
  closeMenu();
  surfaces?.open(id);
}

function openAdmin(): void {
  closeMenu();
  surfaces?.open("admin");
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
      <button v-if="isAdmin" type="button" role="menuitem" @click="openAdmin">
        Admin
      </button>
      <button
        type="button"
        role="menuitem"
        @click="openSurface('user-settings')"
      >
        Settings
      </button>
      <!-- The three Package surfaces are reachable where the User already is,
           and gated exactly as the sidebar's Connectors trigger is: a shell
           without the Connection protocol shows none of them. -->
      <template v-if="web.connectionsAvailable">
        <button type="button" role="menuitem" @click="openSurface('models')">
          Models
        </button>
        <button type="button" role="menuitem" @click="openSurface('plugins')">
          Plugins
        </button>
        <button
          type="button"
          role="menuitem"
          @click="openSurface('connections')"
        >
          Connectors
        </button>
      </template>
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

.profile-menu button:hover:not(:disabled) {
  background: var(--frock-fill-hover);
}

.profile-menu button:disabled {
  color: var(--frock-text-muted);
  cursor: not-allowed;
}

.profile-menu-hint,
.profile-menu-error {
  margin: 5px 10px;
  font-size: var(--frock-text-xs);
  line-height: var(--frock-leading-snug);
}

.profile-menu-hint {
  color: var(--frock-text-muted);
}

.profile-menu-error {
  color: var(--frock-danger-text);
}
</style>
