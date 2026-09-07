<script setup lang="ts">
import { UiConfirmDialog } from "@frockbot/client-ui";
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { sheepCatalog } from "../shared.js";
import { flockWebDataKey } from "./state.js";
import { dialogFocusWrapTarget } from "./dialog-focus.js";
import SheepAvatar from "./SheepAvatar.vue";
const providedFlock = inject(flockWebDataKey);
if (!providedFlock) throw new Error("Flock client data was not provided");
const flock = providedFlock;

/**
 * The name the confirmation names. The live profile is the Bot's current name;
 * the registration seed is what it was called when it was made, and is the
 * fallback for a Bot whose identity read has not landed.
 */
const pendingName = computed(() => {
  const botId = flock.value.lifecyclePending;
  if (!botId) return "this Bot";
  return (
    flock.value.profiles[botId]?.name ??
    flock.value.directory.bots.find((bot) => bot.botId === botId)
      ?.initialName ??
    "this Bot"
  );
});

/**
 * The wardrobe dialog — the only overlay that still uses the two-column frame.
 * Archiving and deleting are questions, and a question is a compact
 * confirmation the shell owns, not a form frame with its art panel removed.
 */
const editorOpen = computed(
  () => flock.value.overlay === "create" || flock.value.overlay === "edit",
);

const dialog = ref<HTMLElement>();
let restoreFocus: HTMLElement | undefined;
const focusable =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

watch(
  editorOpen,
  async (overlay, previous) => {
    if (overlay && !previous) {
      restoreFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : undefined;
      await nextTick();
      dialog.value
        ?.querySelector<HTMLElement>("[autofocus], " + focusable)
        ?.focus();
    } else if (!overlay && previous) {
      restoreFocus?.focus();
      restoreFocus = undefined;
    }
  },
  { flush: "post" },
);

function onDialogKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    flock.value.closeOverlay();
    return;
  }
  if (event.key !== "Tab" || !dialog.value) return;
  const controls = [...dialog.value.querySelectorAll<HTMLElement>(focusable)];
  if (controls.length === 0) return;
  const target = dialogFocusWrapTarget(
    controls,
    document.activeElement as HTMLElement | null,
    event.shiftKey,
  );
  if (!target) return;
  event.preventDefault();
  target.focus();
}

onBeforeUnmount(() => restoreFocus?.focus());
</script>
<template>
  <UiConfirmDialog
    :open="flock.overlay === 'archive'"
    eyebrow="Archive Bot"
    :title="`Archive ${pendingName}?`"
    confirm-label="Archive Bot"
    :error="flock.error"
    @cancel="flock.closeOverlay"
    @confirm="flock.archive"
  >
    <p>
      Archiving stops new work and takes the Bot out of your flock. You can
      restore it later.
    </p>
  </UiConfirmDialog>
  <UiConfirmDialog
    :open="flock.overlay === 'delete'"
    eyebrow="Delete Bot"
    :title="`Delete ${pendingName}?`"
    confirm-label="Delete"
    tone="danger"
    :error="flock.error"
    @cancel="flock.closeOverlay"
    @confirm="flock.deleteBot"
  >
    <p>
      This removes its conversation and Applets, and cannot be undone. To stop
      the Bot working while keeping its history, archive it instead.
    </p>
  </UiConfirmDialog>
  <div
    v-if="editorOpen"
    class="flock-backdrop"
    @click.self="flock.closeOverlay"
  >
    <section
      ref="dialog"
      class="flock-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="flock-title"
      @keydown="onDialogKeydown"
    >
      <div class="flock-preview">
        <SheepAvatar
          :sheep="flock.draftSheep"
          :label="
            flock.draftName
              ? `${flock.draftName} sheep preview`
              : 'Sheep preview'
          "
          size="large"
        />
        <h2>Meet your sheep</h2>
        <p>Randomly tailored. Entirely yours.</p>
        <button type="button" class="flock-reroll" @click="flock.reroll">
          ↻ Surprise me
        </button>
      </div>
      <form
        class="flock-form"
        @submit.prevent="
          flock.overlay === 'create' ? flock.create() : flock.saveSheep()
        "
      >
        <span class="flock-eyebrow">{{
          flock.overlay === "create" ? "Create a Bot" : "Tailor your Bot"
        }}</span>
        <h1 id="flock-title">
          {{
            flock.overlay === "create" ? "Add to your flock" : "Change the look"
          }}
        </h1>
        <p>Keep this look, or change any layer.</p>
        <label v-if="flock.overlay === 'create'" class="flock-name"
          >Bot name<input
            v-model.trim="flock.draftName"
            autofocus
            maxlength="100"
            required
            autocomplete="off"
        /></label>
        <fieldset>
          <legend>Sheep wardrobe</legend>
          <div class="flock-select-grid">
            <label
              >Background<select v-model="flock.draftSheep.background">
                <option
                  v-for="item in sheepCatalog.backgrounds"
                  :key="item.id"
                  :value="item.id"
                >
                  {{ item.label }}
                </option>
              </select></label
            >
            <label
              >Headwear<select v-model="flock.draftSheep.upper">
                <option
                  v-for="item in sheepCatalog.trees.upper"
                  :key="item.id"
                  :value="item.id"
                >
                  {{ item.label }}
                </option>
              </select></label
            >
            <label
              >Face<select v-model="flock.draftSheep.middle">
                <option
                  v-for="item in sheepCatalog.trees.middle"
                  :key="item.id"
                  :value="item.id"
                >
                  {{ item.label }}
                </option>
              </select></label
            >
            <label
              >Neckwear<select v-model="flock.draftSheep.lower">
                <option
                  v-for="item in sheepCatalog.trees.lower"
                  :key="item.id"
                  :value="item.id"
                >
                  {{ item.label }}
                </option>
              </select></label
            >
          </div>
        </fieldset>
        <p
          v-if="flock.error"
          class="flock-error"
          role="alert"
          aria-live="assertive"
        >
          {{ flock.error }}
        </p>
        <div class="flock-actions">
          <button type="button" @click="flock.closeOverlay">Cancel</button
          ><button class="primary" type="submit">
            {{ flock.overlay === "create" ? "Create Bot" : "Save look" }}
          </button>
        </div>
      </form>
    </section>
  </div>
</template>
