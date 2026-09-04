<script setup lang="ts">
import { authSessionClientKey } from "../shared.js";
import { computed, inject, onBeforeUnmount, onMounted, ref } from "vue";
import { hostedAuthClient } from "./browser.js";
import { developmentLoginUrl, isLoopbackHost } from "./development-login";
import {
  isAndroidNativeShell,
  requestNativeGoogleCredential,
} from "./native-google.js";

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
const isDesktop = computed(() => Boolean(window.frockbotDesktop));
const isAndroid = isAndroidNativeShell();
const isLocalDevelopment = computed(() =>
  isLoopbackHost(window.location.hostname),
);
const unsubscribers: Array<() => void> = [];
let electronRedirectTimer: ReturnType<
  typeof hostedAuthClient.ensureElectronRedirect
> | null = null;

function electronAuthQuery(): Record<string, string> | null {
  const params = new URLSearchParams(window.location.search);
  const clientId = params.get("client_id");
  const state = params.get("state");
  const codeChallenge = params.get("code_challenge");
  return clientId && state && codeChallenge
    ? {
        client_id: clientId,
        state,
        code_challenge: codeChallenge,
      }
    : null;
}

async function refreshSession(): Promise<void> {
  try {
    await session.refresh();
    error.value = undefined;
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "Could not check your session";
  }
}

async function loadUser(): Promise<void> {
  await session.refresh();
  const query = electronAuthQuery();
  if (
    query &&
    session.projection.value.status === "authenticated" &&
    session.projection.value.mode === "better-auth"
  ) {
    signingIn.value = true;
    const transfer = await hostedAuthClient.electron.transferUser({
      fetchOptions: { query },
    });
    if (transfer.error) throw new Error(transfer.error.message);
  }
}

function signInForDevelopment(): void {
  window.location.assign(developmentLoginUrl(new URL(window.location.href)));
}

async function signIn(): Promise<void> {
  signingIn.value = true;
  error.value = undefined;
  try {
    if (isDesktop.value) {
      await window.requestAuth();
      return;
    }
    if (isAndroid) {
      const credential = await requestNativeGoogleCredential();
      const result = await hostedAuthClient.signIn.social({
        provider: "google",
        idToken: {
          token: credential.idToken,
          nonce: credential.nonce,
        },
      });
      if (result.error) {
        throw new Error(
          "FrockBot could not verify the Google sign-in. Please try again.",
        );
      }
      window.location.reload();
      return;
    }
    const query = electronAuthQuery();
    const callbackURL = new URL("/", window.location.origin);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        callbackURL.searchParams.set(key, value);
      }
    }
    const callback = callbackURL.toString();
    const result = await hostedAuthClient.signIn.social({
      provider: "google",
      callbackURL: callback,
      newUserCallbackURL: callback,
      errorCallbackURL: callback,
      fetchOptions: query ? { query } : undefined,
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
        window.onAuthenticated(() => {
          signingIn.value = false;
          void refreshSession();
        }),
        window.onUserUpdated(() => {
          void refreshSession();
        }),
        window.onAuthError((context) => {
          error.value = context.message ?? "Sign-in failed";
          signingIn.value = false;
        }),
      );
    } else if (electronAuthQuery()) {
      electronRedirectTimer = hostedAuthClient.ensureElectronRedirect();
    }
    await loadUser();
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "Could not check your session";
  }
});

onBeforeUnmount(() => {
  for (const unsubscribe of unsubscribers) unsubscribe();
  if (electronRedirectTimer) clearTimeout(electronRedirectTimer);
});
</script>

<template>
  <k-slot v-if="user" name="authenticated-root" />
  <main v-else class="auth-screen">
    <section class="auth-card" aria-labelledby="auth-title">
      <div class="auth-mark" aria-hidden="true">⌁</div>
      <p class="auth-eyebrow">FrockBot</p>
      <h1 id="auth-title">Welcome back</h1>
      <p class="auth-copy">
        {{
          isAndroid
            ? "Sign in to continue."
            : "Sign in with your browser to continue."
        }}
      </p>
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
          {{
            signingIn
              ? isAndroid
                ? "Signing in…"
                : "Waiting for browser…"
              : "Continue with Google"
          }}
        </button>
      </div>
      <p v-if="error" class="auth-error" role="alert">{{ error }}</p>
      <p v-if="isDesktop && signingIn" class="auth-hint">
        Finish signing in in the browser. You can safely return to FrockBot when
        it closes.
      </p>
    </section>
  </main>
</template>
