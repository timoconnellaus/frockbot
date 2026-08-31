import type { InjectionKey, Ref } from "vue";

export interface AuthenticatedUserV1 {
  id: string;
  name: string;
  email: string;
}

export type AuthSessionProjectionV1 =
  | { schemaVersion: 1; status: "loading" }
  | { schemaVersion: 1; status: "anonymous" }
  | {
      schemaVersion: 1;
      status: "authenticated";
      mode: "better-auth" | "desktop" | "development";
      user: AuthenticatedUserV1;
    };

export interface AuthSessionClient {
  readonly projection: Readonly<Ref<AuthSessionProjectionV1>>;
  readonly signingOut: Readonly<Ref<boolean>>;
  refresh(): Promise<void>;
  signOut(): Promise<void>;
}

export const authSessionClientKey: InjectionKey<AuthSessionClient> = Symbol(
  "frockbot.auth-session-client",
);

function record(value: unknown, label: string): Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<PropertyKey, unknown>;
}

function exactKeys(
  value: Record<PropertyKey, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    !keys.every((key) => typeof key === "string" && expected.includes(key))
  ) {
    throw new Error(`${label} has unknown fields`);
  }
}

function stringField(
  value: Record<PropertyKey, unknown>,
  key: string,
  label: string,
): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`${label}.${key} is invalid`);
  return field;
}

/** Strictly decodes the auth-owned projection exposed to client Plugins. */
export function decodeAuthSessionProjectionV1(
  input: unknown,
): Exclude<AuthSessionProjectionV1, { status: "loading" }> {
  const projection = record(input, "auth session projection");
  if (projection.schemaVersion !== 1) {
    throw new Error("auth session projection.schemaVersion is invalid");
  }
  if (projection.status === "anonymous") {
    exactKeys(
      projection,
      ["schemaVersion", "status"],
      "auth session projection",
    );
    return { schemaVersion: 1, status: "anonymous" };
  }
  if (projection.status !== "authenticated") {
    throw new Error("auth session projection.status is invalid");
  }
  exactKeys(
    projection,
    ["schemaVersion", "status", "mode", "user"],
    "auth session projection",
  );
  if (
    projection.mode !== "better-auth" &&
    projection.mode !== "desktop" &&
    projection.mode !== "development"
  ) {
    throw new Error("auth session projection.mode is invalid");
  }
  const user = record(projection.user, "auth session projection.user");
  exactKeys(user, ["id", "name", "email"], "auth session projection.user");
  return {
    schemaVersion: 1,
    status: "authenticated",
    mode: projection.mode,
    user: {
      id: stringField(user, "id", "auth session projection.user"),
      name: stringField(user, "name", "auth session projection.user"),
      email: stringField(user, "email", "auth session projection.user"),
    },
  };
}
