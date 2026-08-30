<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref } from "vue";
import {
  authSessionKey,
  injectRequired,
  mobileHostKey,
} from "./app-context.ts";
import { handleHostedMobileMessage } from "./hosted-bridge.ts";

const props = defineProps<{ gatewayUrl: string }>();
const auth = injectRequired(authSessionKey, "the mobile auth session");
const host = inject(mobileHostKey);
const frame = ref<HTMLIFrameElement>();
const hostedOrigin = computed(() => new URL(props.gatewayUrl).origin);
const source = computed(
  () => `${props.gatewayUrl.replace(/\/$/, "")}/?mobile_shell=1`,
);
async function receive(event: MessageEvent): Promise<void> {
  await handleHostedMobileMessage(event, {
    hostedOrigin: hostedOrigin.value,
    frameWindow: frame.value?.contentWindow,
    authorizedFetch: (path, init) => auth.authorizedFetch(path, init),
    invoke: (commandId, input) => {
      if (!host) throw new Error("Mobile capability host is unavailable");
      return host.invoke(commandId, input);
    },
    post: (message) =>
      frame.value?.contentWindow?.postMessage(message, hostedOrigin.value),
  });
}
onMounted(() => window.addEventListener("message", receive));
onBeforeUnmount(() => window.removeEventListener("message", receive));
</script>
<template>
  <iframe
    ref="frame"
    class="hosted-mobile-app"
    :src="source"
    title="FrockBot"
    allow="clipboard-read; clipboard-write"
  />
</template>
