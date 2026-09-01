<script setup lang="ts">
import { UiIcon } from "@frockbot/client-ui";
import { inject } from "vue";
import { searchWebDataKey } from "./state.js";

const provided = inject(searchWebDataKey);
if (!provided) throw new Error("Search client data was not provided");
const search = provided;
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
  </button>
</template>
