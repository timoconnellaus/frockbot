<script setup lang="ts">
import { UiIconButton } from "@frockbot/client-ui";
import { inject } from "vue";
import { flockWebDataKey } from "./state.js";

const flock = inject(flockWebDataKey);
if (!flock) throw new Error("Flock client data was not provided");
</script>

<template>
  <UiIconButton
    class="flock-create-button"
    icon="plus"
    label="Create Bot"
    size="md"
    @click="flock.openCreate"
  />
</template>
