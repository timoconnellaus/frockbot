<script setup lang="ts">
import { UiButton } from "@frockbot/client-ui";
import { inject, onMounted, ref } from "vue";
import {
  decodeDeploymentPolicyV1,
  type DeploymentPolicyV1,
} from "../shared.js";
import { adminRequestKey } from "./state.js";

const providedRequest = inject(adminRequestKey);
if (!providedRequest)
  throw new Error("admin client transport was not provided");
const request: NonNullable<typeof providedRequest> = providedRequest;

const policy = ref<DeploymentPolicyV1>();
const loading = ref(true);
const saving = ref(false);
const error = ref<string>();

function changedLine(value: DeploymentPolicyV1): string {
  const changed = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value.updatedAt));
  return `Last changed ${changed} by ${value.updatedBy}.`;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    policy.value = decodeDeploymentPolicyV1(await request("/api/admin/policy"));
    error.value = undefined;
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "Could not load signup policy";
  } finally {
    loading.value = false;
  }
}

async function setOpen(open: boolean): Promise<void> {
  const current = policy.value;
  if (!current || saving.value || current.signups.open === open) return;
  saving.value = true;
  error.value = undefined;
  try {
    policy.value = decodeDeploymentPolicyV1(
      await request(
        "/api/admin/policy",
        "POST",
        JSON.stringify({
          schemaVersion: 1,
          type: "deployment/set-signups",
          open,
          revision: current.revision,
        }),
      ),
    );
  } catch (cause) {
    const message =
      cause instanceof Error ? cause.message : "Could not change signup policy";
    await load();
    error.value = message;
  } finally {
    saving.value = false;
  }
}

function changeSignups(event: Event): void {
  const target = event.currentTarget;
  if (!(target instanceof HTMLInputElement)) return;
  void setOpen(target.checked);
}

onMounted(load);
</script>

<template>
  <section class="admin-surface" aria-label="Deployment policy">
    <p class="admin-surface__explanation">
      Control who can sign in. People who already have accounts, and admins,
      always can.
    </p>

    <p v-if="loading" class="admin-surface__status" aria-live="polite">
      Loading signup policy…
    </p>

    <div v-else-if="policy" class="admin-surface__policy">
      <label class="admin-surface__toggle">
        <span>
          <strong>Accept new signups</strong>
          <small>Let new people sign up.</small>
        </span>
        <input
          type="checkbox"
          :checked="policy.signups.open"
          :disabled="saving"
          @change="changeSignups"
        />
      </label>
      <p class="admin-surface__changed">{{ changedLine(policy) }}</p>
    </div>

    <p v-if="error" class="admin-surface__error" role="alert">{{ error }}</p>
    <UiButton v-if="error && !policy" type="button" @click="load">
      Try again
    </UiButton>
  </section>
</template>

<style scoped>
.admin-surface {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
}

.admin-surface__explanation,
.admin-surface__status,
.admin-surface__changed,
.admin-surface__error {
  margin: 0;
  font-size: var(--frock-text-sm);
  line-height: var(--frock-leading-normal);
}

.admin-surface__explanation,
.admin-surface__status,
.admin-surface__changed {
  color: var(--frock-text-muted);
}

.admin-surface__policy {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-subtle);
}

.admin-surface__toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  cursor: pointer;
}

.admin-surface__toggle span {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.admin-surface__toggle strong {
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.admin-surface__toggle small {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.admin-surface__toggle input {
  width: var(--frock-control-sm);
  height: var(--frock-control-sm);
  accent-color: var(--frock-action-primary);
}

.admin-surface__error {
  color: var(--frock-danger-text);
}
</style>
