import type {
  CardMessage,
  PluginCard,
  PluginExecute,
  PluginTool,
} from "@frockbot/applet-sdk/plugin";

/**
 * Agent cards: the `agent-card` payload, drawn from the catalog (ADR 0030
 * step 7).
 *
 * One Bot saying something about a Bot — a template it staged, a sibling it
 * is handing over to. The card is a title, who it is about, and the body, and
 * it asks for nothing: there was never a control on this member and there is
 * none now.
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

const noteCard: PluginCard = {
  render({ surfaceId, data }) {
    const title = String(data.title ?? "");
    const agentId = String(data.agentId ?? "");
    if (title.length === 0 || agentId.length === 0) {
      return { drop: true, reason: "an agent card needs a title and a Bot" };
    }
    const body =
      typeof data.body === "string" && data.body.length > 0
        ? data.body
        : undefined;
    return surface(surfaceId, [
      {
        id: "root",
        component: "Column",
        children: ["header", ...(body ? ["body"] : [])],
      },
      {
        id: "header",
        component: "CardHeader",
        title,
        subtitle: agentId,
      },
      ...(body ? [{ id: "body", component: "Markdown", text: body }] : []),
    ]);
  },
};

export const cards = { note: noteCard };

export const execute: PluginExecute = (tool) => {
  throw new Error(`unknown tool ${tool}`);
};
