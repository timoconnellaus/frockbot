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
 * The card says what is wanted, what it will be saved as and where it may be
 * used, and carries the one `SecretField` the person types it into. The field
 * is the host's: the kernel binds it to the request it recorded for this send
 * and overwrites whatever is written on it here, the client draws it masked,
 * and what is typed goes from the client to the User's credential store. It
 * is never in this card's data model, never in anything this Plugin is handed
 * back, and never in anything the Bot reads — the Bot learns a reference.
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
    const origin =
      typeof data.origin === "string" && data.origin.length > 0
        ? data.origin
        : undefined;
    const payment = data.payment === true;
    const rows = [
      { label: "Saved as", value: secretName },
      {
        label: "Used on",
        value: origin ?? "Any site, with your approval each time",
      },
    ];
    return surface(surfaceId, [
      {
        id: "root",
        component: "Column",
        children: ["header", "facts", "field", "note"],
      },
      {
        id: "header",
        component: "CardHeader",
        title: prompt,
        subtitle: payment ? "Payment detail" : "Secret",
      },
      { id: "facts", component: "KeyValueRows", rows },
      // Bound by the kernel to the request it recorded for this send; the
      // values here are placeholders it overwrites.
      { id: "field", component: "SecretField", requestId: "pending" },
      {
        id: "note",
        component: "Callout",
        tone: "neutral",
        title: "Kept out of the chat",
        text: payment
          ? "It is saved to your account, not the conversation, and your Bot is given a reference instead of the value. You approve each page before it is filled in. Delete it any time in Settings."
          : "It is saved to your account, not the conversation, and your Bot is given a reference instead of the value. It fills it into the site above, and asks you before any other. Delete it any time in Settings.",
      },
    ]);
  },
};

export const cards = { request: requestCard };

export const execute: PluginExecute = (tool) => {
  throw new Error(`unknown tool ${tool}`);
};
