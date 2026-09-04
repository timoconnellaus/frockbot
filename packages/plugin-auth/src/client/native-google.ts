import { Capacitor, registerPlugin } from "@capacitor/core";

const MAX_ID_TOKEN_LENGTH = 16_384;
const MAX_NONCE_LENGTH = 512;

interface NativePlatform {
  isNativePlatform(): boolean;
  getPlatform(): string;
}

export interface NativeGoogleCredential {
  idToken: string;
  nonce: string;
}

export interface NativeGoogleAuthPlugin {
  signIn(): Promise<unknown>;
}

const nativeGoogleAuth =
  registerPlugin<NativeGoogleAuthPlugin>("FrockBotGoogleAuth");

export function isAndroidNativeShell(
  platform: NativePlatform = Capacitor,
): boolean {
  return platform.isNativePlatform() && platform.getPlatform() === "android";
}

export async function requestNativeGoogleCredential(
  plugin: NativeGoogleAuthPlugin = nativeGoogleAuth,
): Promise<NativeGoogleCredential> {
  const result = await plugin.signIn();
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("Google returned an invalid sign-in response.");
  }
  const keys = Object.keys(result);
  const value = result as Record<string, unknown>;
  if (
    keys.length !== 2 ||
    !keys.includes("idToken") ||
    !keys.includes("nonce") ||
    typeof value.idToken !== "string" ||
    !value.idToken ||
    value.idToken.length > MAX_ID_TOKEN_LENGTH ||
    typeof value.nonce !== "string" ||
    !value.nonce ||
    value.nonce.length > MAX_NONCE_LENGTH
  ) {
    throw new Error("Google returned an invalid sign-in response.");
  }
  return { idToken: value.idToken, nonce: value.nonce };
}
