<script setup lang="ts">
// The Computer surface: the user's own machines, and how one is registered.
//
// Three states are rendered rather than reasoned about:
//
//   * **connected** — the backend says this machine polled inside the presence
//     TTL. Nothing here computes it.
//   * **revoked** — the row stays, as evidence. A revoked machine is not
//     deleted, because "failures observable in durable state" applies to a
//     decision the user made as much as to one a program made.
//   * **this computer** — only inside the desktop shell, where an agent exists
//     to hand a code to. In a browser the code is shown instead, because a
//     browser cannot register itself.
import { UiButton, UiField } from "@frockbot/client-ui";
import { computed, inject, onMounted, ref } from "vue";
import { machinesStateKey } from "./state.js";

const providedState = inject(machinesStateKey);
if (!providedState) {
  throw new Error("Registered machine client services were not provided");
}
const machines = providedState;
const typedCode = ref("");

const rows = computed(() => machines.value.view?.machines ?? []);
const agent = computed(() => machines.value.agent);

/** The machine row this app itself is, when it is one. */
const thisMachineId = computed(() => agent.value?.machineId);

function when(value: string): string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString();
}

function state(machine: { connected: boolean; revokedAt?: string }): string {
  if (machine.revokedAt) return "Revoked";
  return machine.connected ? "Connected" : "Offline";
}

async function submitCode(): Promise<void> {
  const code = typedCode.value.trim();
  if (!code) return;
  await machines.value.enterCode(code);
  typedCode.value = "";
}

onMounted(() => machines.value.load());
</script>

<template>
  <div class="machines-surface">
    <header>
      <h2>Registered machines</h2>
      <p>
        A registered machine is a computer running the FrockBot desktop app. A
        Bot can read files and run commands on it only while the app is open,
        and only after you approve each action.
      </p>
    </header>

    <section class="machines-pairing">
      <div v-if="machines.desktop" class="machines-pairing__desktop">
        <div class="machines-pairing__row">
          <span class="machines-pairing__text">
            <strong>This computer</strong>
            <small v-if="agent?.enrolled">
              Paired as {{ agent.label }} ·
              {{ agent.running ? "connected" : "not running" }}
            </small>
            <small v-else>Not paired yet</small>
          </span>
          <UiButton
            v-if="!agent?.enrolled"
            type="button"
            :disabled="machines.busy"
            @click="machines.pairThisComputer()"
          >
            Pair this computer
          </UiButton>
          <UiButton
            v-else
            type="button"
            :disabled="machines.busy"
            @click="machines.forgetThisComputer()"
          >
            Forget on this computer
          </UiButton>
        </div>
        <p v-if="agent?.lastError" class="machines-surface__note" role="status">
          {{ agent.lastError }}
        </p>
        <form class="machines-pairing__code" @submit.prevent="submitCode">
          <UiField label="Pairing code" hint="from another device's settings">
            <input
              v-model="typedCode"
              type="text"
              autocomplete="off"
              spellcheck="false"
              placeholder="Paste a pairing code"
            />
          </UiField>
          <UiButton
            type="submit"
            :disabled="machines.busy || !typedCode.trim()"
          >
            Pair with this code
          </UiButton>
        </form>
      </div>

      <div v-else class="machines-pairing__browser">
        <div class="machines-pairing__row">
          <span class="machines-pairing__text">
            <strong>Register a machine</strong>
            <small>
              Ask for a code here, then paste it into the FrockBot desktop app
              on the machine you want to register.
            </small>
          </span>
          <UiButton
            type="button"
            :disabled="machines.busy"
            @click="machines.requestCode()"
          >
            Get a pairing code
          </UiButton>
        </div>
        <p v-if="machines.offer" class="machines-pairing__offer">
          <code>{{ machines.offer.code }}</code>
          <small>
            One use only, expires {{ when(machines.offer.expiresAt) }}
          </small>
        </p>
      </div>
    </section>

    <p v-if="machines.error" class="machines-surface__error" role="alert">
      {{ machines.error }}
    </p>

    <div v-if="rows.length" class="machines-list">
      <article
        v-for="machine in rows"
        :key="machine.machineId"
        class="machine-card"
      >
        <div class="machine-card__text">
          <strong>
            {{ machine.label }}
            <span v-if="machine.machineId === thisMachineId">(this one)</span>
          </strong>
          <small
            >{{ machine.platform }} ·
            {{ machine.capabilities.join(", ") }}</small
          >
          <small>Last seen {{ when(machine.lastSeenAt) }}</small>
        </div>
        <span
          class="machine-card__state"
          :data-state="state(machine).toLowerCase()"
        >
          {{ state(machine) }}
        </span>
        <UiButton
          v-if="!machine.revokedAt"
          type="button"
          :disabled="machines.busy"
          @click="machines.revoke(machine.machineId)"
        >
          Revoke
        </UiButton>
      </article>
    </div>
    <p v-else-if="!machines.error" class="machines-surface__note">
      No machines are registered yet.
    </p>
  </div>
</template>

<style scoped>
.machines-surface {
  padding: 24px;
}

.machines-surface h2 {
  margin: 0;
  font-family: var(--frock-font-display);
}

.machines-surface header p,
.machines-surface__note {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-base);
  line-height: 1.5;
}

.machines-pairing {
  display: grid;
  gap: 12px;
  margin-top: 20px;
  padding: 14px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-subtle);
}

.machines-pairing__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.machines-pairing__text {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.machines-pairing__text strong {
  color: var(--frock-text);
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.machines-pairing__text small,
.machines-pairing__offer small {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.machines-pairing__code {
  display: flex;
  align-items: flex-end;
  gap: 12px;
}

.machines-pairing__code > :first-child {
  flex: 1 1 auto;
}

.machines-pairing__offer {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
}

.machines-pairing__offer code {
  overflow-wrap: anywhere;
  color: var(--frock-text);
  font-size: var(--frock-text-sm);
}

.machines-list {
  display: grid;
  gap: 12px;
  margin-top: 20px;
}

.machine-card {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-raised);
  box-shadow: var(--frock-shadow-card);
}

.machine-card__text {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.machine-card__text small {
  margin-top: 4px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.machine-card__state {
  font-size: var(--frock-text-sm);
  font-weight: 700;
}

.machine-card__state[data-state="connected"] {
  color: var(--frock-success);
}

.machine-card__state[data-state="offline"] {
  color: var(--frock-text-muted);
}

.machine-card__state[data-state="revoked"] {
  color: var(--frock-danger-text);
}

.machines-surface__error {
  color: var(--frock-danger-text);
  font-size: var(--frock-text-sm);
}
</style>
