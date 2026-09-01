/**
 * The container's egress policy.
 *
 * The container talks to exactly one host. Everything else is unreachable:
 * this process runs a provider SDK against a User's Computer and has no
 * business anywhere else on the internet.
 *
 * `interceptHttps` is what makes the allowlist mean anything here. The egress
 * chain — including the `allowedHosts` fallback that lets a listed host out
 * while `enableInternet` is false — only sees traffic the platform intercepts,
 * and interception covers HTTP alone unless HTTPS is asked for. Every Sprites
 * call is HTTPS or WSS to `api.sprites.dev`: the REST client's `baseURL` and
 * the exec WebSocket built from it. Without interception those never reach the
 * chain, so they fall through to `enableInternet: false` and are refused at the
 * connection — which the SDK reports as `Network error: fetch failed`, the
 * failure every Computer tool call returned before this was set.
 *
 * Its own module so it can be read without the Worker runtime the host
 * entrypoint needs.
 */
export const SPRITES_API_HOST = "api.sprites.dev";

export const COMPUTER_HOST_EGRESS_V1 = {
  enableInternet: false,
  allowedHosts: [SPRITES_API_HOST],
  interceptHttps: true,
} as const;
