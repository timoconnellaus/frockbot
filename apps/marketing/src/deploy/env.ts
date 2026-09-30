import type { DeployAccount } from "./account-object";
import type { OAuthClientV1 } from "./oauth";

export interface DeployEnvV1 {
  DEPLOY_ACCOUNTS: DurableObjectNamespace<DeployAccount>;
  CLOUDFLARE_OAUTH_CLIENT_ID?: string;
  CLOUDFLARE_OAUTH_CLIENT_SECRET?: string;
  /** Where `/deploy` is served; `https://frockbot.com` unless a local run says otherwise. */
  DEPLOY_ORIGIN?: string;
}

export const DEPLOY_ORIGIN_V1 = "https://frockbot.com";

export function deployOriginV1(env: DeployEnvV1): string {
  return env.DEPLOY_ORIGIN?.trim() || DEPLOY_ORIGIN_V1;
}

/** The registered client, or nothing when this deployment has none. */
export function oauthClientV1(env: DeployEnvV1): OAuthClientV1 | null {
  const clientId = env.CLOUDFLARE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.CLOUDFLARE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    redirectUri: `${deployOriginV1(env)}/deploy/callback`,
  };
}
