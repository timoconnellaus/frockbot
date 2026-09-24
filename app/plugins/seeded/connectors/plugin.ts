import type {
  CardMessage,
  PluginCard,
  PluginExecute,
  PluginTool,
} from "@frockbot/applet-sdk/plugin";

/**
 * Connector cards: a Bot offering an app it cannot reach yet.
 *
 * "There's a Gmail connector — want to connect it?" is a proposal, and the
 * card is its face: the Bot's reason, and the app with a button that connects
 * it. The button is `ConnectApp`, which only the host draws. The kernel looks
 * the app up in its own catalog when the card is sent and writes its name onto
 * the component, and the press opens that app's sign-in under the person's own
 * session — so this card can name an app, and nothing it writes can make the
 * button connect a different one. The Bot proposes; only the User grants.
 */

export const tools: PluginTool[] = [];

const FROCK_CATALOG_ID = "https://frockbot.com/a2ui/catalogs/frock/v1.json";

function surface(surfaceId: string, components: unknown[]): CardMessage[] {
  return [
    {
      version: "v1.0",
      createSurface: { surfaceId, catalogId: FROCK_CATALOG_ID, components },
    },
  ];
}

const offerCard: PluginCard = {
  render({ surfaceId, data }) {
    const app = String(data.app ?? "").trim();
    if (app.length === 0) {
      return { drop: true, reason: "a connector offer needs an app" };
    }
    const reason =
      typeof data.reason === "string" && data.reason.trim().length > 0
        ? data.reason.trim()
        : undefined;
    return surface(surfaceId, [
      {
        id: "root",
        component: "Column",
        children: [...(reason ? ["reason"] : []), "connect"],
      },
      ...(reason
        ? [{ id: "reason", component: "Markdown", text: reason }]
        : []),
      { id: "connect", component: "ConnectApp", app },
    ]);
  },
};

export const cards = { offer: offerCard };

export const execute: PluginExecute = (tool) => {
  throw new Error(`unknown tool ${tool}`);
};
