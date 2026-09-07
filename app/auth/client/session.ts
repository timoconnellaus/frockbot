import { readonly, ref } from "vue";
import {
  decodeAuthSessionProjectionV1,
  type AuthSessionClient,
  type AuthSessionProjectionV1,
} from "../shared.js";

export interface AuthSessionAdapter {
  read(): Promise<unknown>;
  /** Returns the authoritative post-command auth projection. */
  signOut(): Promise<unknown>;
}

export function createAuthSessionClient(
  adapter: AuthSessionAdapter,
): AuthSessionClient {
  const projection = ref<AuthSessionProjectionV1>({
    schemaVersion: 1,
    status: "loading",
  });
  const signingOut = ref(false);
  let pendingSignOut: Promise<void> | undefined;

  const refresh = async (): Promise<void> => {
    projection.value = decodeAuthSessionProjectionV1(await adapter.read());
  };

  const signOut = (): Promise<void> => {
    if (pendingSignOut) return pendingSignOut;
    const current = projection.value;
    if (current.status === "anonymous") return Promise.resolve();
    if (current.status === "loading") {
      return Promise.reject(new Error("Authentication is still loading"));
    }
    if (current.mode === "development") {
      return Promise.reject(
        new Error(
          "Development identity is selected by the local development login and cannot be signed out",
        ),
      );
    }

    signingOut.value = true;
    pendingSignOut = (async () => {
      try {
        const authoritative = decodeAuthSessionProjectionV1(
          await adapter.signOut(),
        );
        if (authoritative.status !== "anonymous") {
          throw new Error("Sign-out did not clear the authenticated session");
        }
        projection.value = authoritative;
      } finally {
        signingOut.value = false;
        pendingSignOut = undefined;
      }
    })();
    return pendingSignOut;
  };

  return {
    projection: readonly(projection),
    signingOut: readonly(signingOut),
    refresh,
    signOut,
  };
}
