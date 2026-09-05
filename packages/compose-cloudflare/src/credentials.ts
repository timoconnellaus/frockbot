/**
 * Where a credential value comes from in one runtime. This structural type
 * keeps the Cloudflare host independent of any particular agent runtime.
 */
export interface CredentialSource {
  /** The value of the credential with this name, or `undefined`. */
  get: (name: string) => string | undefined;
}

/**
 * A credential source over a Worker's string bindings. Service bindings and
 * other non-string values are deliberately hidden from consumers.
 */
export const bindingCredentials = (env: unknown): CredentialSource => {
  const bindings = (env ?? {}) as Record<string, unknown>;
  return {
    get: (name: string) => {
      const value = bindings[name];
      return typeof value === "string" ? value : undefined;
    },
  };
};
