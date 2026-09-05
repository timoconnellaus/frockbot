/**
 * Cloudflare Insights, the zone's own analytics.
 *
 * The beacon is injected into every HTML response by the zone, above this
 * Worker, so a page loads it whether or not that page's policy allows it. A
 * policy that does not name these origins does not remove the beacon; it turns
 * every page load into a refused request and a red console error. Both
 * policies this deployment serves — the application's and the anonymous
 * Package-UI artifact's — therefore name them, and neither pretends the
 * feature is off.
 */

/** Where the zone's injected beacon script is served from. */
export const INSIGHTS_SCRIPT_ORIGIN = "https://static.cloudflareinsights.com";
/** Where that beacon posts its measurements — a different host from the script. */
export const INSIGHTS_REPORT_ORIGIN = "https://cloudflareinsights.com";
