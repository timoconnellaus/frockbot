<script setup lang="ts">
import FrockBotApp from "@frockbot/webui-shell/client/FrockBotApp.vue";
import { createAuthClient } from "better-auth/client";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

const authClient = createAuthClient();
const loading = ref(true);
const signingIn = ref(false);
const user = ref<{ id: string; name: string; email: string } | null>(null);
const error = ref<string>();
const isDesktop = computed(() => Boolean(window.frockbotDesktop));
const unsubscribers: Array<() => void> = [];

function embeddedUserId(): string | undefined {
  const value = document.body.dataset.frockbotUserId;
  return value && value !== "anonymous" ? value : undefined;
}

async function loadUser(): Promise<void> {
  if (isDesktop.value) {
    const current = await window.getUser();
    user.value = current
      ? { id: current.id, name: current.name, email: current.email }
      : null;
    return;
  }

  const embedded = embeddedUserId();
  if (embedded || import.meta.env.DEV) {
    user.value = {
      id: embedded ?? "development",
      name: "FrockBot user",
      email: "",
    };
    return;
  }

  const session = await authClient.getSession();
  user.value = session.data?.user
    ? {
        id: session.data.user.id,
        name: session.data.user.name,
        email: session.data.user.email,
      }
    : null;
}

async function signIn(): Promise<void> {
  signingIn.value = true;
  error.value = undefined;
  try {
    if (isDesktop.value) {
      await window.requestAuth({ provider: "google" });
      return;
    }
    const result = await authClient.signIn.social({
      provider: "google",
      callbackURL: new URL("/", window.location.origin).toString(),
    });
    if (result.error) throw new Error(result.error.message);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Sign-in failed";
    signingIn.value = false;
  }
}

onMounted(async () => {
  try {
    if (isDesktop.value) {
      unsubscribers.push(
        window.onAuthenticated((authenticatedUser) => {
          user.value = {
            id: authenticatedUser.id,
            name: authenticatedUser.name,
            email: authenticatedUser.email,
          };
          signingIn.value = false;
          error.value = undefined;
        }),
        window.onUserUpdated((updatedUser) => {
          user.value = updatedUser
            ? {
                id: updatedUser.id,
                name: updatedUser.name,
                email: updatedUser.email,
              }
            : null;
        }),
        window.onAuthError((context) => {
          error.value = context.message ?? "Sign-in failed";
          signingIn.value = false;
        }),
      );
    }
    await loadUser();
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "Could not check your session";
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(() => {
  for (const unsubscribe of unsubscribers) unsubscribe();
});
</script>

<template>
  <FrockBotApp v-if="user" />
  <main v-else class="auth-screen">
    <section class="auth-card" aria-labelledby="auth-title">
      <div class="auth-mark" aria-hidden="true">⌁</div>
      <p class="auth-eyebrow">FrockBot</p>
      <h1 id="auth-title">Welcome back</h1>
      <p class="auth-copy">
        Sign in in your browser to keep credentials out of the desktop renderer.
      </p>
      <div v-if="loading" class="auth-loading" aria-live="polite">
        Checking your session…
      </div>
      <button
        v-else
        class="google-button"
        type="button"
        :disabled="signingIn"
        @click="signIn"
      >
        <span class="google-g" aria-hidden="true">G</span>
        {{ signingIn ? "Waiting for browser…" : "Continue with Google" }}
      </button>
      <p v-if="error" class="auth-error" role="alert">{{ error }}</p>
      <p v-if="isDesktop && signingIn" class="auth-hint">
        Finish signing in in the browser. You can safely return to FrockBot when it closes.
      </p>
    </section>
  </main>
</template>
