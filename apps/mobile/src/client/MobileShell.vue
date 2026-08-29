<script setup lang="ts">
import FrockBotApp from "@frockbot/plugin-shell/client/FrockBotApp.vue";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { computed, inject, ref } from "vue";
import {
  authSessionKey,
  injectRequired,
  mobileBotIdKey,
  mobileHostKey,
} from "./app-context.ts";
import { WRITE_CLIPBOARD_TEXT_COMMAND } from "./commands.ts";

const web = injectRequired(frockBotWebDataKey, "the FrockBot web data");
const auth = injectRequired(authSessionKey, "the mobile auth session");
const botId = injectRequired(mobileBotIdKey, "the mobile bot id");
const host = inject(mobileHostKey, undefined);

const settingsOpen = ref(false);
const botDraft = ref(botId.value);
const status = ref<string>();

const lastAssistantText = computed(() => {
  const message = [...web.value.messages]
    .reverse()
    .find((entry) => entry.role === "assistant" && entry.text.trim());
  return message?.text ?? "";
});
const canAct = computed(() => Boolean(host) && lastAssistantText.value !== "");

function report(message: string): void {
  status.value = message;
  setTimeout(() => {
    if (status.value === message) status.value = undefined;
  }, 2_500);
}

async function copyLastReply(): Promise<void> {
  if (!host) return;
  try {
    await host.invoke(WRITE_CLIPBOARD_TEXT_COMMAND, {
      text: lastAssistantText.value,
    });
    report("Copied the last reply.");
  } catch (error) {
    report(error instanceof Error ? error.message : "Copy failed.");
  }
}

async function shareLastReply(): Promise<void> {
  if (!host) return;
  try {
    await host.share({ title: "FrockBot", text: lastAssistantText.value });
    report("Shared the last reply.");
  } catch (error) {
    report(error instanceof Error ? error.message : "Share failed.");
  }
}

function applyBot(): void {
  const next = botDraft.value.trim() || "default";
  botDraft.value = next;
  if (next === botId.value) return;
  botId.value = next;
  settingsOpen.value = false;
}

async function signOut(): Promise<void> {
  await auth.signOut();
  window.location.reload();
}
</script>

<template>
  <div class="mobile-root">
    <header class="mobile-topbar">
      <strong>{{ botId }}</strong>
      <button
        type="button"
        class="mobile-icon"
        aria-label="Mobile settings"
        @click="settingsOpen = !settingsOpen"
      >
        ⋯
      </button>
    </header>
    <section v-if="settingsOpen" class="mobile-settings">
      <label class="mobile-field">
        <span>Bot</span>
        <input
          v-model="botDraft"
          autocapitalize="none"
          autocomplete="off"
          spellcheck="false"
          @keydown.enter.prevent="applyBot"
        />
      </label>
      <div class="mobile-settings-actions">
        <button type="button" class="mobile-secondary" @click="applyBot">
          Switch bot
        </button>
        <button type="button" class="mobile-secondary" @click="signOut">
          Sign out
        </button>
      </div>
    </section>
    <div class="mobile-surface">
      <FrockBotApp />
    </div>
    <footer class="mobile-actions">
      <button
        type="button"
        class="mobile-secondary"
        :disabled="!canAct"
        @click="copyLastReply"
      >
        Copy reply
      </button>
      <button
        type="button"
        class="mobile-secondary"
        :disabled="!canAct"
        @click="shareLastReply"
      >
        Share reply
      </button>
      <span v-if="status" class="mobile-status" aria-live="polite">
        {{ status }}
      </span>
    </footer>
  </div>
</template>
