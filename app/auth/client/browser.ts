import { createAuthClient } from "better-auth/client";
import { createHostedAuthAdapter } from "./hosted-session.js";
import { createAuthSessionClient } from "./session.js";

export const hostedAuthClient = createAuthClient();

function errorProjection(error: { message?: string } | null | undefined) {
  return error ? { message: error.message } : null;
}

function embeddedAuthMode(): "anonymous" | "better-auth" | "development" {
  const mode = document.body.dataset.frockbotAuthMode;
  if (
    mode !== "anonymous" &&
    mode !== "better-auth" &&
    mode !== "development"
  ) {
    throw new Error("Hosted auth mode is invalid");
  }
  return mode;
}

function embeddedIsAdmin(): boolean {
  const value = document.body.dataset.frockbotIsAdmin;
  if (value !== "true" && value !== "false") {
    throw new Error("Couldn't load admin settings.");
  }
  return value === "true";
}

export function createBrowserAuthSessionClient() {
  const adapter = createHostedAuthAdapter({
    location: new URL(window.location.href),
    embeddedUserId: document.body.dataset.frockbotUserId,
    embeddedMode: embeddedAuthMode(),
    embeddedIsAdmin: embeddedIsAdmin(),
    betterAuth: {
      getSession: async () => {
        const result = await hostedAuthClient.getSession();
        return {
          data: result.data ? { user: result.data.user } : null,
          error: errorProjection(result.error),
        };
      },
      signOut: async () => {
        const result = await hostedAuthClient.signOut();
        return {
          data: result.data,
          error: errorProjection(result.error),
        };
      },
    },
  });
  return createAuthSessionClient(adapter);
}
