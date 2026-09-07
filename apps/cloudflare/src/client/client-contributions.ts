/**
 * The client half of the foundation application's Contribution table.
 *
 * It is a separate module from `./contributions.ts` for one reason: a client
 * Contribution is React that belongs in the browser bundle and a backend
 * Contribution is server code that belongs in the Worker bundle, and a module
 * that imported both would put each in the other's bundle. Together the two
 * modules are the one table `AGENTS.md` asks for, and together they cover
 * every client Contribution this application mounts.
 *
 * Mount order is part of this table, not of the code that consumes it: a
 * client Contribution mounts into slots an earlier one declares.
 */
import type { ClientPlugin } from "@frockbot/client-core";
import type { ClientContributionDescriptorV1 } from "@frockbot/core/contracts/contributions";

import { clientContribution as uiThemeClient } from "@frockbot/app/ui-theme/client";
import { clientContribution as authClient } from "@frockbot/app/auth/client";
import { clientContribution as shellClient } from "@frockbot/app/shell/client";
import { clientContribution as adminClient } from "@frockbot/app/admin/client";
import { clientContribution as computerClient } from "@frockbot/computer/client";
import { clientContribution as flockClient } from "@frockbot/app/flock/client";
import { clientContribution as searchClient } from "@frockbot/app/search/client";
import { clientContribution as settingsClient } from "@frockbot/app/settings/client";
import { clientContribution as customModelsClient } from "@frockbot/app/custom-models/client";
import { clientContribution as routinesClient } from "@frockbot/app/routines/client";
import { clientContribution as botTemplateClient } from "@frockbot/app/bot-template/client";
import { clientContribution as auditClient } from "@frockbot/app/audit/client";
import { clientContribution as userMachineClient } from "@frockbot/app/machine/client";

export const foundationClientContributions: readonly ClientContributionDescriptorV1<ClientPlugin>[] =
  [
    uiThemeClient,
    authClient,
    shellClient,
    adminClient,
    computerClient,
    flockClient,
    // After Flock: the Search surface injects the shell registry Flock also uses.
    searchClient,
    settingsClient,
    customModelsClient,
    routinesClient,
    botTemplateClient,
    // After Settings: the Audit log mounts into the Advanced Bot settings slot
    // Settings declares.
    auditClient,
    // After Settings: the Computer section mounts into the User settings slot
    // Settings declares.
    userMachineClient,
  ];
