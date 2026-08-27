<script setup lang="ts">
import { electronProxyClient } from "@better-auth/electron/proxy";
import { createAuthClient } from "better-auth/client";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  developmentLoginUrl,
  developmentUserFromUrl,
  isLoopbackHost,
} from "./development-login";

const authClient = createAuthClient({
  plugins: [
    electronProxyClient({
      clientID: "frockbot-desktop",
      protocol: { scheme: "com.frockbot.desktop" },
    }),
  ],
});
const loading = ref(true);
const signingIn = ref(false);
const user = ref<{ id: string; name: string; email: string } | null>(null);
const error = ref<string>();
const isDesktop = computed(() => Boolean(window.frockbotDesktop));
const isLocalDevelopment = computed(() =>
  isLoopbackHost(window.location.hostname),
);
const unsubscribers: Array<() => void> = [];
let electronRedirectTimer: ReturnType<
  typeof authClient.ensureElectronRedirect
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

function embeddedUserId(): string | undefined {
  const value = document.body.dataset.frockbotUserId;
  return value && value !== "anonymous" ? value : undefined;
}

async function loadUser(): Promise<void> {
  const developmentUser = developmentUserFromUrl(
    new URL(window.location.href),
  );
  if (developmentUser) {
    user.value = {
      id: developmentUser,
      name: "Local developer",
      email: "dev@localhost",
    };
    return;
  }

  if (isDesktop.value) {
    const current = await window.getUser();
    user.value = current
      ? { id: current.id, name: current.name, email: current.email }
      : null;
    return;
  }

  const query = electronAuthQuery();
  const embedded = embeddedUserId();
  if (!query && embedded) {
    user.value = {
      id: embedded ?? "development",
      name: "FrockBot user",
      email: "",
    };
    return;
  }

  const session = await authClient.getSession();
  if (query && session.data?.user) {
    signingIn.value = true;
    const transfer = await authClient.electron.transferUser({
      fetchOptions: { query },
    });
    if (transfer.error) throw new Error(transfer.error.message);
    return;
  }
  user.value = session.data?.user
    ? {
        id: session.data.user.id,
        name: session.data.user.name,
        email: session.data.user.email,
      }
    : null;
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
    const query = electronAuthQuery();
    const callbackURL = new URL("/", window.location.origin);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        callbackURL.searchParams.set(key, value);
      }
    }
    const callback = callbackURL.toString();
    const result = await authClient.signIn.social({
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
    } else if (electronAuthQuery()) {
      electronRedirectTimer = authClient.ensureElectronRedirect();
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
        Sign in in your browser to keep credentials out of the desktop renderer.
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
          {{ signingIn ? "Waiting for browser…" : "Continue with Google" }}
        </button>
      </div>
      <p v-if="error" class="auth-error" role="alert">{{ error }}</p>
      <p v-if="isDesktop && signingIn" class="auth-hint">
        Finish signing in in the browser. You can safely return to FrockBot when it closes.
      </p>
    </section>
  </main>
</template>
