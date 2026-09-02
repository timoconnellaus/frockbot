<script setup lang="ts">
import { inject, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { sheepCatalog } from "../shared.js";
import { flockWebDataKey } from "./state.js";
import { dialogFocusWrapTarget } from "./dialog-focus.js";
import SheepAvatar from "./SheepAvatar.vue";
const providedFlock = inject(flockWebDataKey);
if (!providedFlock) throw new Error("Flock client data was not provided");
const flock = providedFlock;

const dialog = ref<HTMLElement>();
let restoreFocus: HTMLElement | undefined;
const focusable =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

watch(
  () => flock.value.overlay,
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
  <div
    v-if="flock.overlay"
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
      <div v-if="flock.overlay === 'archive'" class="flock-form">
        <span class="flock-eyebrow">Archive Bot</span>
        <h1 id="flock-title">Archive this Bot?</h1>
        <p>
          Archiving stops new work and hides the Bot from your active flock.
          History and settings are preserved for restoration.
        </p>
        <p
          v-if="flock.error"
          class="flock-error"
          role="alert"
          aria-live="assertive"
        >
          {{ flock.error }}
        </p>
        <div class="flock-actions">
          <button type="button" @click="flock.closeOverlay">Cancel</button>
          <button class="primary" type="button" @click="flock.archive">
            Archive Bot
          </button>
        </div>
      </div>
      <template v-else>
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
              flock.overlay === "create"
                ? "Add to your flock"
                : "Change the look"
            }}
          </h1>
          <p>
            Keep this look or tailor each layer. Your choice is saved with the
            Bot.
          </p>
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
          <div class="flock-note">
            This identity stays with your Bot. Refreshing or switching devices
            won’t re-roll it.
          </div>
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
      </template>
    </section>
  </div>
</template>
