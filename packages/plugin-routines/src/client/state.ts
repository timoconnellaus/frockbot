import type { InjectionKey, Ref } from "vue";
import type {
  RoutineHookMintV1,
  RoutineRunEntryViewV1,
  RoutineTriggerV1,
  RoutineViewV1,
} from "../shared.js";

/** What the create/edit form submits. One of `schedule` or `trigger`, never both. */
export interface RoutineFormSubmissionV1 {
  routineId?: string;
  name: string;
  prompt: string;
  schedule?: string;
  trigger?: RoutineTriggerV1;
  timezone: string;
}

export interface RoutinesClientState {
  /** The Bot the loaded Routines belong to; nothing is shown for another. */
  botId?: string;
  routines: RoutineViewV1[];
  /** Run logs by Routine, loaded on demand when a log is opened. */
  runs: Record<string, RoutineRunEntryViewV1[]>;
  loaded: boolean;
  busy: boolean;
  error?: string;
  load(botId: string): Promise<void>;
  loadRuns(botId: string, routineId: string): Promise<void>;
  save(botId: string, submission: RoutineFormSubmissionV1): Promise<void>;
  setEnabled(botId: string, routineId: string, enabled: boolean): Promise<void>;
  remove(botId: string, routineId: string): Promise<void>;
  /** Ask for one firing now. It is queued; the alarm runs it. */
  runNow(botId: string, routineId: string): Promise<void>;
  /**
   * The webhook key most recently minted in this session, and the only place it
   * is ever readable. It is not persisted anywhere on the client and cannot be
   * fetched again: rotating is the only way to see a key twice.
   */
  mintedHook?: RoutineHookMintV1;
  /** Mint a fresh key, retiring the one before it. */
  rotateKey(botId: string, routineId: string): Promise<void>;
  /** Retire the key without minting another. Deliveries then answer 401. */
  revokeKey(botId: string, routineId: string): Promise<void>;
  /** Forget the key on screen. */
  dismissHook(): void;
}

export const routinesStateKey: InjectionKey<Ref<RoutinesClientState>> =
  Symbol("routines-state");
