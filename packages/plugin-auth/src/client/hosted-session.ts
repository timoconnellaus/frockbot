import { developmentUserFromUrl } from "./development-login.js";

interface AuthUserLike {
  id?: unknown;
  name?: unknown;
  email?: unknown;
}

interface BetterAuthResult {
  data?: { user?: AuthUserLike } | null | unknown;
  error?: { message?: string } | null;
}

export interface HostedBetterAuthAdapter {
  getSession(): Promise<BetterAuthResult>;
  signOut(): Promise<BetterAuthResult>;
}

export interface HostedDesktopAuthAdapter {
  getUser(): Promise<AuthUserLike | null>;
  signOut(): Promise<void>;
}

export interface HostedAuthAdapterInput {
  location: URL;
  embeddedUserId?: string;
  embeddedMode?: "anonymous" | "better-auth" | "development";
  embeddedIsAdmin?: boolean;
  betterAuth: HostedBetterAuthAdapter;
  desktop?: HostedDesktopAuthAdapter;
}

function userProjection(
  user: AuthUserLike,
  isAdmin: boolean,
  fallbackName = "FrockBot user",
) {
  if (typeof user.id !== "string" || user.id.length === 0) {
    throw new Error("Authenticated user id is invalid");
  }
  return {
    id: user.id,
    name:
      typeof user.name === "string" && user.name.length > 0
        ? user.name
        : fallbackName,
    email: typeof user.email === "string" ? user.email : "",
    isAdmin,
  };
}

function embeddedDevelopmentUser(
  input: HostedAuthAdapterInput,
): string | undefined {
  if (
    input.embeddedMode !== "development" ||
    !input.embeddedUserId ||
    input.embeddedUserId === "anonymous"
  ) {
    return undefined;
  }
  return input.embeddedUserId;
}

function developmentProjection(userId: string, isAdmin: boolean) {
  return {
    schemaVersion: 1 as const,
    status: "authenticated" as const,
    mode: "development" as const,
    user: {
      id: userId,
      name: "Local developer",
      email: "dev@localhost",
      isAdmin,
    },
  };
}

function betterAuthUser(result: BetterAuthResult): AuthUserLike | undefined {
  if (result.error) {
    throw new Error(result.error.message || "Could not check your session");
  }
  if (
    typeof result.data !== "object" ||
    result.data === null ||
    !("user" in result.data)
  ) {
    return undefined;
  }
  const user = result.data.user;
  return typeof user === "object" && user !== null
    ? (user as AuthUserLike)
    : undefined;
}

export function createHostedAuthAdapter(input: HostedAuthAdapterInput) {
  return {
    async read(): Promise<unknown> {
      const developmentUser = developmentUserFromUrl(input.location);
      if (developmentUser) {
        return developmentProjection(
          developmentUser,
          input.embeddedIsAdmin === true,
        );
      }

      const embeddedDevelopment = embeddedDevelopmentUser(input);
      if (embeddedDevelopment) {
        return developmentProjection(
          embeddedDevelopment,
          input.embeddedIsAdmin === true,
        );
      }

      if (input.desktop) {
        const user = await input.desktop.getUser();
        return user
          ? {
              schemaVersion: 1,
              status: "authenticated",
              mode: "desktop",
              user: userProjection(user, input.embeddedIsAdmin === true),
            }
          : { schemaVersion: 1, status: "anonymous" };
      }

      const user = betterAuthUser(await input.betterAuth.getSession());
      if (user) {
        return {
          schemaVersion: 1,
          status: "authenticated",
          mode: "better-auth",
          user: userProjection(user, input.embeddedIsAdmin === true),
        };
      }
      return { schemaVersion: 1, status: "anonymous" };
    },

    async signOut(): Promise<unknown> {
      if (
        developmentUserFromUrl(input.location) ||
        embeddedDevelopmentUser(input)
      ) {
        throw new Error("Development identity cannot be signed out");
      }
      if (input.desktop) {
        await input.desktop.signOut();
      } else {
        const result = await input.betterAuth.signOut();
        if (result.error) {
          throw new Error(result.error.message || "Sign-out failed");
        }
      }
      return { schemaVersion: 1, status: "anonymous" };
    },
  };
}
