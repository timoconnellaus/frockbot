<script setup lang="ts">
import { authSessionClientKey } from "../shared.js";
import { computed, inject, onMounted, ref } from "vue";
import { hostedAuthClient } from "./browser.js";
import { developmentLoginUrl, isLoopbackHost } from "./development-login";

const providedSession = inject(authSessionClientKey);
if (!providedSession) throw new Error("auth session client was not provided");
const session = providedSession;

const signingIn = ref(false);
const error = ref<string>();
const user = computed(() =>
  session.projection.value.status === "authenticated"
    ? session.projection.value.user
    : null,
);
const loading = computed(() => session.projection.value.status === "loading");
const isLocalDevelopment = computed(() =>
  isLoopbackHost(window.location.hostname),
);

function signInForDevelopment(): void {
  window.location.assign(developmentLoginUrl(new URL(window.location.href)));
}

async function signIn(): Promise<void> {
  signingIn.value = true;
  error.value = undefined;
  try {
    const callback = new URL("/", window.location.origin).toString();
    const result = await hostedAuthClient.signIn.social({
      provider: "google",
      callbackURL: callback,
      newUserCallbackURL: callback,
      errorCallbackURL: callback,
    });
    if (result.error) throw new Error(result.error.message);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Sign-in failed";
    signingIn.value = false;
  }
}

onMounted(async () => {
  try {
    await session.refresh();
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "Could not check your session";
  }
});
</script>

<template>
  <k-slot v-if="user" name="authenticated-root" />
  <main v-else class="auth-screen">
    <section class="auth-card" aria-labelledby="auth-title">
      <div class="auth-mark" aria-hidden="true">⌁</div>
      <p class="auth-eyebrow">FrockBot</p>
      <h1 id="auth-title">Welcome back</h1>
      <p class="auth-copy">Sign in with your browser to continue.</p>
      <div v-if="loading" class="auth-loading" aria-live="polite">
        Checking your session…
      </div>
      <div v-else class="auth-actions">
        <button
          v-if="isLocalDevelopment"
          class="dev-button"
          type="button"
          :disabled="signingIn"
          @click="signInForDevelopment"
        >
          Continue as local developer
        </button>
        <button
          class="google-button"
          type="button"
          :disabled="signingIn"
          @click="signIn"
        >
          <span class="google-g" aria-hidden="true">G</span>
          {{ signingIn ? "Waiting for browser…" : "Continue with Google" }}
        </button>
      </div>
      <p v-if="error" class="auth-error" role="alert">{{ error }}</p>
    </section>
  </main>
</template>
