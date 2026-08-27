<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import {
  authSessionKey,
  injectRequired,
  mobileBotIdKey,
} from "./app-context.ts";
import MobileShell from "./MobileShell.vue";
import { openExternalUrl } from "./system-browser.ts";

const auth = injectRequired(authSessionKey, "the mobile auth session");
const botId = injectRequired(mobileBotIdKey, "the mobile bot id");

const loading = ref(true);
const ready = ref(false);
const busy = ref(false);
const error = ref<string>();
const notice = ref<string>();
const gatewayUrl = ref("");
const tokenDraft = ref("");
const developmentUserDraft = ref("");

let releaseUnauthorized: (() => void) | undefined;

function failure(cause: unknown, fallback: string): void {
  error.value = cause instanceof Error ? cause.message : fallback;
}

async function saveGateway(): Promise<string> {
  return await auth.setGatewayUrl(gatewayUrl.value);
}

async function connect(): Promise<void> {
  ready.value = await auth.probe(botId.value);
  if (!ready.value) {
    error.value = "The gateway rejected these credentials.";
  }
}

async function useToken(): Promise<void> {
  busy.value = true;
  error.value = undefined;
  notice.value = undefined;
  try {
    gatewayUrl.value = await saveGateway();
    await auth.setDevelopmentUserId(undefined);
    await auth.setToken(tokenDraft.value);
    await connect();
    if (ready.value) tokenDraft.value = "";
  } catch (cause) {
    failure(cause, "Could not use that token");
  } finally {
    busy.value = false;
  }
}

async function useDevelopmentUser(): Promise<void> {
  busy.value = true;
  error.value = undefined;
  notice.value = undefined;
  try {
    gatewayUrl.value = await saveGateway();
    await auth.setToken(undefined);
    await auth.setDevelopmentUserId(developmentUserDraft.value || "development");
    await connect();
  } catch (cause) {
    failure(cause, "Could not start a development session");
  } finally {
    busy.value = false;
  }
}

async function signInWithGoogle(): Promise<void> {
  busy.value = true;
  error.value = undefined;
  notice.value = undefined;
  try {
    const gateway = await saveGateway();
    gatewayUrl.value = gateway;
    const url = await auth.startGoogleSignIn(`${gateway}/`);
    await openExternalUrl(url);
    notice.value =
      "Finish signing in in the browser, then paste the session token below.";
  } catch (cause) {
    failure(cause, "Sign-in could not start");
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  releaseUnauthorized = auth.onUnauthorized(() => {
    ready.value = false;
    error.value = "Your session expired. Sign in again.";
  });
  try {
    const state = await auth.load();
    gatewayUrl.value = state.gatewayUrl;
    developmentUserDraft.value = state.developmentUserId ?? "";
    if (state.gatewayUrl && (state.token || state.developmentUserId)) {
      ready.value = await auth.probe(botId.value);
    }
  } catch (cause) {
    failure(cause, "Could not restore your session");
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(() => releaseUnauthorized?.());
</script>

<template>
  <MobileShell v-if="ready" />
  <main v-else class="mobile-auth">
    <section class="mobile-auth-card" aria-labelledby="mobile-auth-title">
      <div class="mobile-auth-mark" aria-hidden="true">⌁</div>
      <p class="mobile-auth-eyebrow">FrockBot</p>
      <h1 id="mobile-auth-title">Connect to your gateway</h1>
      <p v-if="loading" class="mobile-auth-loading" aria-live="polite">
        Checking your session…
      </p>
      <template v-else>
        <label class="mobile-field">
          <span>Gateway URL</span>
          <input
            v-model="gatewayUrl"
            type="url"
            inputmode="url"
            autocapitalize="none"
            autocomplete="off"
            spellcheck="false"
            placeholder="https://gateway.example.com"
          />
        </label>
        <button
          class="mobile-primary"
          type="button"
          :disabled="busy"
          @click="signInWithGoogle"
        >
          <span class="mobile-google" aria-hidden="true">G</span>
          Continue with Google
        </button>
        <label class="mobile-field">
          <span>Session token</span>
          <input
            v-model="tokenDraft"
            type="password"
            autocapitalize="none"
            autocomplete="off"
            spellcheck="false"
            placeholder="Paste the bearer token"
          />
        </label>
        <button
          class="mobile-secondary"
          type="button"
          :disabled="busy || !tokenDraft"
          @click="useToken"
        >
          Use this token
        </button>
        <details class="mobile-details">
          <summary>Development user</summary>
          <label class="mobile-field">
            <span>User id</span>
            <input
              v-model="developmentUserDraft"
              autocapitalize="none"
              autocomplete="off"
              spellcheck="false"
              placeholder="development"
            />
          </label>
          <button
            class="mobile-secondary"
            type="button"
            :disabled="busy"
            @click="useDevelopmentUser"
          >
            Use development identity
          </button>
          <p class="mobile-hint">
            Only a gateway started with development identity accepts this.
          </p>
        </details>
      </template>
      <p v-if="notice" class="mobile-notice" aria-live="polite">{{ notice }}</p>
      <p v-if="error" class="mobile-error" role="alert">{{ error }}</p>
    </section>
  </main>
</template>
