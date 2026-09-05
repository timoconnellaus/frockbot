<script setup lang="ts">
import { UiButton } from "@frockbot/client-ui";
import type {
  Json,
  SettingChoice,
  SettingsOptionsPage,
} from "@frockbot/protocol-schemas";
import { inject, nextTick, onBeforeUnmount, ref } from "vue";
import { settingsFrameClientKey } from "./settings-frames.js";
const props = defineProps<{
  revision: number;
  value: Json;
  label: string;
  disabled: boolean;
}>();
const emit = defineEmits<{ choose: [choice: SettingChoice] }>();
const client = inject(settingsFrameClientKey);
const dialog = ref<HTMLDialogElement>();
const query = ref("");
const page = ref<SettingsOptionsPage>();
const busy = ref(false);
const failed = ref(false);
let cursor: number | undefined;
const previous = ref<(number | undefined)[]>([]);
let request = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
async function load() {
  const ticket = ++request;
  busy.value = true;
  failed.value = false;
  try {
    if (!client) throw new Error("Settings unavailable");
    const result = await client.options({
      schemaVersion: 1,
      source: "account-models",
      revision: props.revision,
      query: query.value,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (ticket !== request) return;
    page.value = result;
  } catch {
    if (ticket === request) failed.value = true;
  } finally {
    if (ticket === request) busy.value = false;
  }
}
async function open() {
  query.value = "";
  cursor = undefined;
  previous.value = [];
  page.value = undefined;
  await nextTick();
  dialog.value?.showModal();
  void load();
}
function search() {
  clearTimeout(timer);
  request++;
  cursor = undefined;
  previous.value = [];
  page.value = undefined;
  busy.value = true;
  timer = setTimeout(load, 300);
}
function close() {
  clearTimeout(timer);
  request++;
  dialog.value?.close();
}
function choose(choice: SettingChoice) {
  emit("choose", choice);
  close();
}
onBeforeUnmount(close);
</script>
<template>
  <UiButton type="button" :disabled="disabled" @click="open">{{
    label
  }}</UiButton>
  <dialog ref="dialog" aria-labelledby="model-picker-title" @cancel="close">
    <div class="picker-heading">
      <h3 id="model-picker-title">Choose a model</h3>
      <UiButton type="button" @click="close">Done</UiButton>
    </div>
    <label class="search-label" for="settings-model-search"
      >Search models</label
    >
    <input
      id="settings-model-search"
      v-model="query"
      type="search"
      maxlength="100"
      autofocus
      @input="search"
    />
    <div class="picker-results" :aria-busy="busy">
      <div
        v-if="busy"
        class="picker-loading"
        role="status"
        aria-label="Loading models"
      >
        <span v-for="i in 5" :key="i" />
      </div>
      <div v-else-if="failed" role="alert" class="picker-empty">
        <p>
          Models couldn’t load. Check your connection and try again. If Settings
          changed, return to Models and refresh.
        </p>
        <UiButton type="button" @click="load">Try again</UiButton>
      </div>
      <p v-else-if="!page?.items.length" class="picker-empty">
        No matching models. Try another name, or connect a provider on Models.
      </p>
      <ul v-else aria-label="Available models">
        <li v-for="choice in page.items" :key="JSON.stringify(choice.value)">
          <button
            type="button"
            :aria-pressed="
              JSON.stringify(value) === JSON.stringify(choice.value)
            "
            @click="choose(choice)"
          >
            <span>{{ choice.label }}</span
            ><span
              v-if="JSON.stringify(value) === JSON.stringify(choice.value)"
              aria-hidden="true"
              >✓</span
            >
          </button>
        </li>
      </ul>
    </div>
    <div class="picker-pages">
      <UiButton
        type="button"
        :disabled="busy || !previous.length"
        @click="
          cursor = previous.pop();
          load();
        "
        >Previous</UiButton
      >
      <UiButton
        type="button"
        :disabled="busy || failed || page?.nextCursor === undefined"
        @click="
          previous.push(cursor);
          cursor = page?.nextCursor;
          load();
        "
        >More models</UiButton
      >
    </div>
  </dialog>
</template>
<style scoped>
dialog {
  width: min(560px, calc(100vw - 32px));
  max-height: calc(100dvh - 48px);
  padding: 24px;
  box-sizing: border-box;
  color: var(--frock-text);
  background: var(--frock-surface);
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
}
dialog::backdrop {
  background: var(--frock-overlay-tint);
}
.picker-heading,
.picker-pages {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}
h3 {
  margin: 0;
  font-size: var(--frock-text-md);
}
.search-label {
  display: block;
  margin: 20px 0 8px;
  font-size: var(--frock-text-sm);
}
input {
  box-sizing: border-box;
  width: 100%;
}
.picker-results {
  height: min(45dvh, 400px);
  overflow: auto;
  margin: 16px 0;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
li button {
  display: flex;
  width: 100%;
  gap: 12px;
  justify-content: space-between;
  padding: 14px 12px;
  border: 0;
  border-radius: var(--frock-radius-control);
  color: var(--frock-text);
  background: transparent;
  text-align: left;
  font: inherit;
  cursor: pointer;
}
li button span {
  min-width: 0;
  overflow-wrap: anywhere;
}
li button:hover,
li button[aria-pressed="true"] {
  background: var(--frock-surface-subtle);
}
li button:focus-visible {
  outline: 2px solid var(--frock-border-focus);
  outline-offset: -2px;
}
.picker-empty {
  color: var(--frock-text-muted);
  line-height: 1.6;
}
.picker-loading {
  display: grid;
  gap: 12px;
}
.picker-loading span {
  height: 48px;
  background: var(--frock-surface-subtle);
  border-radius: var(--frock-radius-control);
}
</style>
