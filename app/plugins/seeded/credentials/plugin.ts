import type {
  CardMessage,
  PluginCard,
  PluginExecute,
  PluginTool,
} from "@frockbot/applet-sdk/plugin";

/**
 * Credential cards: the `secret-request` payload, drawn from the catalog (ADR
 * 0030 step 7).
 *
 * A secret never crosses this card, and there is nothing on it that could
 * take one. The card says what is wanted, what it will be stored as, and
 * where it is added; the value itself goes from the client to a Connection
 * write over an expiring lease, and is never in a data model the agent can
 * read back.
 *
 * The old bubble carried an "Open Settings" button. The Frock catalog has no
 * component that opens an in-app route — a card's only link handling is the
 * host's external opener, which admits `https` and nothing else — so the card
 * names the door in words rather than pretending to be it. A host-drawn
 * settings component is the follow-up; a button that did nothing would be
 * worse than this line.
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

const requestCard: PluginCard = {
  render({ surfaceId, data }) {
    const prompt = String(data.prompt ?? "");
    const secretName = String(data.secretName ?? "");
    if (prompt.length === 0 || secretName.length === 0) {
      return {
        drop: true,
        reason: "a credential request needs a prompt and a name",
      };
    }
    return surface(surfaceId, [
      {
        id: "root",
        component: "Column",
        children: ["header", "where", "warning"],
      },
      {
        id: "header",
        component: "CardHeader",
        title: prompt,
        subtitle: "Needs a credential",
        status: "Not set",
        tone: "warning",
      },
      {
        id: "where",
        component: "KeyValueRows",
        rows: [
          { label: "Stored as", value: secretName },
          { label: "Where", value: "Settings · Connections" },
        ],
      },
      {
        id: "warning",
        component: "Callout",
        tone: "warning",
        title: "Never in the conversation",
        text: "Add it in Settings, where the value crosses as an expiring lease and no Bot ever reads it back. Anything typed in the thread is on the thread.",
      },
    ]);
  },
};

export const cards = { request: requestCard };

export const execute: PluginExecute = (tool) => {
  throw new Error(`unknown tool ${tool}`);
};
