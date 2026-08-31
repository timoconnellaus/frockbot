import type { InjectionKey, Ref } from "vue";
import type {
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
}

export const routinesStateKey: InjectionKey<Ref<RoutinesClientState>> =
  Symbol("routines-state");
