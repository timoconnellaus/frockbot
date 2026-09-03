<script setup lang="ts">
import {
  decodePackageIframePageMessageV2,
  packageIframeExternalUrlAllowedV2,
  packageIframeFocusAllowedV2,
  packageIframeToolAllowedV1,
  type PackageIframeBridgeVersionV2,
  type PackageIframeContributionViewV1,
  type PackageIframeHostMessageV2,
  type PackageIframePageViewV1,
} from "@frockbot/kernel-contracts";
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { frockBotWebDataKey } from "../shared.js";
import { postPackageIframeHostMessage } from "./package-iframe-host-message.js";

const props = withDefaults(
  defineProps<{
    contribution: PackageIframeContributionViewV1;
    page: PackageIframePageViewV1;
    slot: string;
    /** The named state feeds this frame receives, by state name. */
    states: Record<string, unknown>;
    /**
     * `flow` gives the frame the height the page asks for; `fill` gives it the
     * height of its container, for a page that owns a whole panel.
     */
    layout?: "flow" | "fill";
    /** A page hosted in a surface has its attribution drawn by the surface. */
    attribution?: boolean;
  }>(),
  { layout: "flow", attribution: true },
);
const providedWeb = inject(frockBotWebDataKey);
if (!providedWeb) throw new Error("Package iframe host data was not provided");
const web = providedWeb;
const frame = ref<HTMLIFrameElement>();
const height = ref(240);
const failure = ref<string>();
const lastStateWireByName = new Map<string, string>();
/*
 * Which bridge this page reads. A page announces version 2 with `hello`; one
 * that never announces is a version 1 page and is only ever sent version 1
 * messages, so a page published before the bump keeps working unchanged.
 */
const bridgeVersion = ref<PackageIframeBridgeVersionV2>(1);
const catalog = computed(() => web.value.packageUi);
const source = computed(() => {
  const origin = catalog.value?.artifactOrigin;
  return origin
    ? `${origin}/packages/${props.page.artifact.contentHash}.html`
    : "about:blank";
});

/*
 * The theme a page is given.
 *
 * Design tokens are the contract between the shell and a Package's page (ADR
 * 0007): a page is handed semantic names, never the shell's stylesheet, and
 * never a colour to hard-code. The list is what an Applet kit needs to build a
 * whole screen — surfaces, text, borders, the accent, the three status
 * colours, the focus ring, geometry, and the type scale — under names that say
 * what a value is for rather than which shell control it came from.
 */
const THEME_TOKENS: ReadonlyArray<readonly [string, string]> = [
  ["surface", "surface"],
  ["surface-raised", "surface-raised"],
  ["surface-subtle", "surface-subtle"],
  ["surface-window", "surface-window"],
  ["text", "text"],
  ["text-muted", "text-muted"],
  ["text-subtle", "text-subtle"],
  ["border", "border"],
  ["border-strong", "border-strong"],
  ["accent", "action-primary"],
  ["accent-hover", "action-primary-hover"],
  ["accent-pressed", "action-primary-pressed"],
  ["accent-surface", "accent-surface"],
  ["accent-text", "accent-text"],
  ["on-accent", "on-accent"],
  ["danger", "danger-text"],
  ["danger-surface", "danger-surface"],
  ["danger-border", "danger-border"],
  ["success", "success"],
  ["success-surface", "success-surface"],
  ["success-border", "success-border"],
  ["warning", "warning"],
  ["warning-surface", "warning-surface"],
  ["warning-border", "warning-border"],
  ["focus-ring", "focus-ring"],
  ["fill-hover", "fill-hover"],
  ["fill-pressed", "fill-pressed"],
  ["radius-control", "radius-control"],
  ["radius-card", "radius-card"],
  ["control-sm", "control-sm"],
  ["control-md", "control-md"],
  ["control-lg", "control-lg"],
  ["font-sans", "font-sans"],
  ["font-mono", "font-mono"],
  ["text-xs", "text-xs"],
  ["text-sm", "text-sm"],
  ["text-base", "text-base"],
  ["text-md", "text-md"],
  ["text-lg", "text-lg"],
  ["text-xl", "text-xl"],
  ["leading-normal", "leading-normal"],
  ["motion-fast", "motion-fast"],
] as const;

function themeTokens(): Record<string, string> {
  const styles = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    THEME_TOKENS.map(([name, token]) => [
      name,
      styles.getPropertyValue(`--frock-${token}`).trim(),
    ]).filter(([, value]) => value !== ""),
  );
}

function post(message: PackageIframeHostMessageV2): void {
  const target = frame.value?.contentWindow;
  if (!target) return;
  try {
    postPackageIframeHostMessage(target, message, lastStateWireByName);
  } catch (error) {
    failure.value =
      error instanceof Error ? error.message : "Package page state is invalid";
  }
}

function postStates(): void {
  for (const [name, value] of Object.entries(props.states)) {
    post({
      schemaVersion: bridgeVersion.value,
      type: "state",
      name,
      value,
    });
  }
}

function initialize(): void {
  const botId = web.value.activeBotId;
  if (!botId) return;
  lastStateWireByName.clear();
  post({
    schemaVersion: bridgeVersion.value,
    type: "init",
    themeTokens: themeTokens(),
    packageId: props.contribution.packageId,
    botId,
    slot: props.slot,
    pageId: props.page.id,
  });
  postStates();
}

watch(() => props.states, postStates, { deep: true });

async function onMessage(event: MessageEvent): Promise<void> {
  if (!frame.value?.contentWindow || event.source !== frame.value.contentWindow)
    return;
  let message;
  try {
    message = decodePackageIframePageMessageV2(event.data);
  } catch {
    return;
  }
  if (message.type === "hello") {
    // The announcement can land before or after the frame's load event, so the
    // handshake is re-sent at the announced version either way.
    if (bridgeVersion.value === message.bridgeVersion) return;
    bridgeVersion.value = message.bridgeVersion;
    initialize();
    return;
  }
  if (message.type === "resize") {
    height.value = Math.min(1_200, Math.max(96, Math.round(message.height)));
    return;
  }
  if (message.type === "focus") {
    if (!packageIframeFocusAllowedV2(props.contribution)) {
      failure.value = "This Package cannot change the focused Applet.";
      return;
    }
    failure.value = undefined;
    await web.value.setFocusedApplet(message.appletId);
    return;
  }
  if (message.type === "openExternal") {
    const origin = catalog.value?.artifactOrigin;
    if (!origin || !packageIframeExternalUrlAllowedV2(message.url, origin)) {
      failure.value = "This Package page can only open its own pages.";
      return;
    }
    failure.value = undefined;
    window.open(message.url, "_blank", "noopener,noreferrer");
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
      schemaVersion: bridgeVersion.value,
      type: "state",
      name: `tool:${message.name}`,
      value: result,
    });
  } catch (error) {
    failure.value = error instanceof Error ? error.message : "Tool call failed";
    post({
      schemaVersion: bridgeVersion.value,
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
  <section class="package-iframe-frame" :class="`package-iframe-${layout}`">
    <header v-if="attribution" class="package-iframe-attribution">
      <strong>{{ contribution.displayName }}</strong>
      <span>{{ contribution.provenance }} Package</span>
    </header>
    <!-- Load eagerly because lazy iframes defer the init/resize handshake until the browser decides the frame is near the viewport, which headless Chromium may never do. -->
    <iframe
      ref="frame"
      :title="`${contribution.displayName} Package page`"
      :src="source"
      :style="layout === 'fill' ? undefined : { height: `${height}px` }"
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

.package-iframe-fill {
  display: flex;
  height: 100%;
  flex-direction: column;
  border: 0;
  border-radius: 0;
}

.package-iframe-fill iframe {
  min-height: 0;
  flex: 1;
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
