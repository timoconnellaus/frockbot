<script setup lang="ts">
import {
  decodePackageIframePageMessageV1,
  packageIframeToolAllowedV1,
  type PackageIframeContributionViewV1,
  type PackageIframeHostMessageV1,
} from "@frockbot/kernel-contracts";
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { frockBotWebDataKey } from "../shared.js";
import { postPackageIframeHostMessage } from "./package-iframe-host-message.js";

const props = defineProps<{
  contribution: PackageIframeContributionViewV1;
  slot: string;
  stateName: string;
  stateValue: unknown;
}>();
const providedWeb = inject(frockBotWebDataKey);
if (!providedWeb) throw new Error("Package iframe host data was not provided");
const web = providedWeb;
const frame = ref<HTMLIFrameElement>();
const height = ref(240);
const failure = ref<string>();
const lastStateWireByName = new Map<string, string>();
const catalog = computed(() => web.value.packageUi);
const source = computed(() => {
  const origin = catalog.value?.artifactOrigin;
  return origin
    ? `${origin}/packages/${props.contribution.artifact.contentHash}.html`
    : "about:blank";
});

const THEME_TOKEN_NAMES = [
  "surface",
  "surface-raised",
  "surface-subtle",
  "text",
  "text-muted",
  "border",
  "accent-surface",
  "accent-text",
  "radius-card",
] as const;

function themeTokens(): Record<string, string> {
  const styles = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    THEME_TOKEN_NAMES.map((name) => [
      name,
      styles.getPropertyValue(`--frock-${name}`).trim(),
    ]),
  );
}

function post(message: PackageIframeHostMessageV1): void {
  const target = frame.value?.contentWindow;
  if (!target) return;
  try {
    postPackageIframeHostMessage(target, message, lastStateWireByName);
  } catch (error) {
    failure.value =
      error instanceof Error ? error.message : "Package page state is invalid";
  }
}

function initialize(): void {
  const botId = web.value.activeBotId;
  if (!botId) return;
  lastStateWireByName.clear();
  post({
    schemaVersion: 1,
    type: "init",
    themeTokens: themeTokens(),
    packageId: props.contribution.packageId,
    botId,
    slot: props.slot,
  });
  post({
    schemaVersion: 1,
    type: "state",
    name: props.stateName,
    value: props.stateValue,
  });
}

watch(
  () => [props.stateName, props.stateValue] as const,
  () =>
    post({
      schemaVersion: 1,
      type: "state",
      name: props.stateName,
      value: props.stateValue,
    }),
  { deep: true },
);

async function onMessage(event: MessageEvent): Promise<void> {
  if (!frame.value?.contentWindow || event.source !== frame.value.contentWindow)
    return;
  let message;
  try {
    message = decodePackageIframePageMessageV1(event.data);
  } catch {
    return;
  }
  if (message.type === "resize") {
    height.value = Math.min(1_200, Math.max(96, Math.round(message.height)));
    return;
  }
  if (!packageIframeToolAllowedV1(props.contribution, message.name)) {
    failure.value = `This Package did not declare ${message.name}.`;
    return;
  }
  failure.value = undefined;
  try {
    const result = await web.value.callPackageUiTool(
      props.contribution,
      message.name,
      message.input,
    );
    post({
      schemaVersion: 1,
      type: "state",
      name: `tool:${message.name}`,
      value: result,
    });
  } catch (error) {
    failure.value = error instanceof Error ? error.message : "Tool call failed";
    post({
      schemaVersion: 1,
      type: "state",
      name: `tool:${message.name}`,
      value: { isError: true, content: failure.value },
    });
  }
}

onMounted(() => window.addEventListener("message", onMessage));
onBeforeUnmount(() => window.removeEventListener("message", onMessage));
</script>

<template>
  <section class="package-iframe-frame">
    <header class="package-iframe-attribution">
      <strong>{{ contribution.displayName }}</strong>
      <span>{{ contribution.provenance }} Package</span>
    </header>
    <!-- Load eagerly because lazy iframes defer the init/resize handshake until the browser decides the frame is near the viewport, which headless Chromium may never do. -->
    <iframe
      ref="frame"
      :title="`${contribution.displayName} Package page`"
      :src="source"
      :style="{ height: `${height}px` }"
      sandbox="allow-scripts"
      credentialless
      referrerpolicy="no-referrer"
      @load="initialize"
    />
    <p v-if="failure" class="package-iframe-failure" role="alert">
      {{ failure }}
    </p>
  </section>
</template>

<style scoped>
.package-iframe-frame {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface);
}

.package-iframe-attribution {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  min-height: 36px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--frock-border);
  color: var(--frock-text);
  background: var(--frock-surface-subtle);
  font-size: var(--frock-text-xs);
}

.package-iframe-attribution span,
.package-iframe-failure {
  color: var(--frock-text-muted);
}

iframe {
  display: block;
  width: 100%;
  max-width: 100%;
  border: 0;
  background: transparent;
}

.package-iframe-failure {
  margin: 0;
  padding: 8px 12px;
  border-top: 1px solid var(--frock-danger-border);
  color: var(--frock-danger-text);
  font-size: var(--frock-text-xs);
}

@media (max-width: 640px) {
  .package-iframe-attribution {
    align-items: flex-start;
    flex-direction: column;
    gap: 2px;
  }
}
</style>
