import type {
  MachineListViewV1,
  MachinePairingOfferV1,
} from "@frockbot/machine-protocol";
import type { InjectionKey, Ref } from "vue";
import type { MachineDeviceAgentStatusV1 } from "../device.js";

/**
 * The Electron preload bridge, as the renderer sees it.
 *
 * Present only inside the desktop shell. In a browser it is absent, which is
 * exactly the difference the section renders: a browser can register *other*
 * machines by handing them a code, but it cannot register itself.
 */
export interface MachineAgentBridgeV1 {
  status(): Promise<unknown>;
  pair(code: string): Promise<unknown>;
  unpair(): Promise<unknown>;
}

export interface MachinesClientState {
  /** The registry, as the browser reads it. `connected` is the server's word. */
  view?: MachineListViewV1;
  /** The outstanding pairing code, once asked for. One-time, five minutes. */
  offer?: MachinePairingOfferV1;
  /** This laptop's own agent, when the app is the desktop shell. */
  agent?: MachineDeviceAgentStatusV1;
  /** True while a request is in flight; every button reads it. */
  busy: boolean;
  /** The last refusal, verbatim from the backend. Never swallowed. */
  error?: string;
  /** Whether this client can pair itself — i.e. it is the desktop shell. */
  readonly desktop: boolean;
  load(): Promise<void>;
  /** Mint a pairing code for a machine that is not this one. */
  requestCode(label?: string): Promise<void>;
  /** Mint a code and hand it straight to this laptop's agent. */
  pairThisComputer(): Promise<void>;
  /** Hand a code typed by hand to this laptop's agent. */
  enterCode(code: string): Promise<void>;
  /** Kill every token a machine holds. The row stays as evidence. */
  revoke(machineId: string): Promise<void>;
  /** Forget the token on this laptop without touching the registry. */
  forgetThisComputer(): Promise<void>;
}

export const machinesStateKey: InjectionKey<Ref<MachinesClientState>> = Symbol(
  "user-machines-state",
);
