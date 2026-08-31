<script setup lang="ts">
import { UiIcon } from "@frockbot/client-ui";
import { inject } from "vue";
import { searchWebDataKey } from "./state.js";

const provided = inject(searchWebDataKey);
if (!provided) throw new Error("Search client data was not provided");
const search = provided;

/*
 * The shortcut hint names the key the reader's own platform uses. Anything
 * else is a hint that is wrong for half the audience.
 */
const isApple =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/u.test(navigator.platform);
const shortcut = isApple ? "⌘K" : "Ctrl K";
</script>

<template>
  <button
    type="button"
    class="search-box"
    aria-label="Search every Bot's conversations"
    @click="search.open()"
  >
    <UiIcon name="search" size="sm" />
    <span class="search-box-label">Search</span>
    <kbd class="search-box-shortcut">{{ shortcut }}</kbd>
  </button>
</template>
