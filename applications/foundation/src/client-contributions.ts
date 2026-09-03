/**
 * The client half of the foundation application's Contribution table.
 *
 * It is a separate module from `./contributions.ts` for one reason: a client
 * Contribution is React that belongs in the browser bundle and a backend
 * Contribution is server code that belongs in the Worker bundle, and a module
 * that imported both would put each in the other's bundle. Together the two
 * modules are the one table `AGENTS.md` asks for, and
 * `packages/architecture-checks/src/contribution-resolution.test.ts` asserts
 * they cover every Contribution `frockbot.application.json` declares.
 *
 * Mount order is part of this table, not of the code that consumes it: a
 * client Contribution mounts into slots an earlier one declares.
 */
import type { ClientPlugin } from "@frockbot/client-core";
import type { ClientContributionDescriptorV1 } from "@frockbot/kernel-contracts/contributions";

import { clientContribution as uiThemeClient } from "@frockbot/plugin-ui-theme/client";
import { clientContribution as authClient } from "@frockbot/plugin-auth/client";
import { clientContribution as shellClient } from "@frockbot/plugin-shell/client";
import { clientContribution as adminClient } from "@frockbot/plugin-admin/client";
// The immutable application owns the concrete client contribution list.
import { clientContribution as computerClient } from "../../../packages/plugin-computer/src/client/application.js";
import { clientContribution as flockClient } from "@frockbot/plugin-flock/client";
import { clientContribution as searchClient } from "@frockbot/plugin-search/client";
import { clientContribution as settingsClient } from "@frockbot/plugin-settings/client";
import { clientContribution as customModelsClient } from "@frockbot/plugin-custom-models/client";
import { clientContribution as routinesClient } from "@frockbot/plugin-routines/client";
import { clientContribution as botTemplateClient } from "@frockbot/plugin-bot-template/client";
import { clientContribution as auditClient } from "@frockbot/plugin-audit/client";
import { clientContribution as packagePublisherClient } from "@frockbot/plugin-package-publisher/client";
import { clientContribution as userMachineClient } from "@frockbot/plugin-user-machine/client";

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
    packagePublisherClient,
    // After Settings: the Computer section mounts into the User settings slot
    // Settings declares.
    userMachineClient,
  ];
