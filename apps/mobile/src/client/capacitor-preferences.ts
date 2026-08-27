import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import {
  createLocalStoragePreferenceStore,
  createMemoryPreferenceStore,
  type PreferenceStore,
} from "./preferences.ts";

function createNativePreferenceStore(): PreferenceStore {
  return {
    get: async (key) => (await Preferences.get({ key })).value,
    set: async (key, value) => {
      await Preferences.set({ key, value });
    },
    remove: async (key) => {
      await Preferences.remove({ key });
    },
  };
}

export function createDevicePreferenceStore(): PreferenceStore {
  if (Capacitor.isNativePlatform()) return createNativePreferenceStore();
  try {
    if (typeof localStorage !== "undefined") {
      return createLocalStoragePreferenceStore(localStorage);
    }
  } catch {
    return createMemoryPreferenceStore();
  }
  return createMemoryPreferenceStore();
}
