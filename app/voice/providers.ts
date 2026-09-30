// Which provider a call runs on, and whose key opens it.
//
// Today the deployment decides (`VOICE_PROVIDER`, Gemini Live when unset) and
// the key is always the deployment's own secret. The setup web app will let an
// account choose, and bring its own key; both arrive as `account` here and
// win over the deployment, so the call path already asks the question in the
// shape it will be answered in.

import { geminiLiveProviderV1 } from "./gemini-live.js";
import { openAiRealtimeVoiceProviderV1 } from "./openai-realtime-voice.js";
import {
  DEFAULT_VOICE_PROVIDER_V1,
  isVoiceProviderIdV1,
  type VoiceProviderIdV1,
  type VoiceProviderKeyNameV1,
  type VoiceProviderV1,
} from "./provider.js";

export const VOICE_PROVIDERS_V1: Readonly<
  Record<VoiceProviderIdV1, VoiceProviderV1>
> = {
  "gemini-live": geminiLiveProviderV1,
  "openai-realtime": openAiRealtimeVoiceProviderV1,
};

/** What an account will be able to say. Nothing sets it yet. */
export interface VoiceAccountProviderChoiceV1 {
  provider?: VoiceProviderIdV1;
  /** The account's own key for that provider, already unsealed server-side. */
  key?: string;
}

export interface VoiceProviderChoiceV1 {
  provider: VoiceProviderV1;
  /** The key the session opens with, or undefined when there is none. */
  key: string | undefined;
  keySource: "deployment" | "account";
}

/**
 * Resolves the provider and its key. A deployed `VOICE_PROVIDER` comes from
 * the profile's `voice.provider`, whose schema admits only the two names, so
 * an unknown one is a hand-set local var and the default runs.
 */
export function chooseVoiceProviderV1(input: {
  deployment: string | undefined;
  keys: Partial<Record<VoiceProviderKeyNameV1, string>>;
  account?: VoiceAccountProviderChoiceV1;
}): VoiceProviderChoiceV1 {
  const configured = input.deployment?.trim();
  const id =
    input.account?.provider ??
    (isVoiceProviderIdV1(configured) ? configured : DEFAULT_VOICE_PROVIDER_V1);
  const provider = VOICE_PROVIDERS_V1[id];
  const own = input.account?.key?.trim();
  if (own) return { provider, key: own, keySource: "account" };
  return {
    provider,
    key: input.keys[provider.keyName]?.trim() || undefined,
    keySource: "deployment",
  };
}
