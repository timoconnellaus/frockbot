import type { ClientPlugin } from "@frockbot/client-core";
import { foundationClientContributions } from "./client-contributions.js";

/**
 * The client Plugins this application mounts, resolved from the Contribution
 * table rather than named here.
 *
 * Nothing in this module knows which Package supplies which surface: it reads
 * the descriptors the Packages themselves export, in the order the table
 * records, and takes each descriptor's Plugin. `client.test.ts` holds it to
 * the compiled plan's client Contribution count, and the architecture check
 * holds every specifier in `frockbot.application.json` to a table entry.
 */
export const foundationClientPlugins: readonly ClientPlugin[] =
  foundationClientContributions.map((contribution) => contribution.plugin);
