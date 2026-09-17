import type {
  CardMessage,
  PluginCard,
  PluginExecute,
  PluginTool,
} from "@frockbot/applet-sdk/plugin";

/**
 * Attachment cards: the `attachment` payload, drawn from the catalog (ADR
 * 0030 step 7).
 *
 * The file itself is not the Plugin's. An attachment's URL comes from the
 * kernel's own attachment store, the card only names it, and opening it goes
 * through the host's link handling — which admits `https` and nothing else,
 * at admission and again at the moment of opening.
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

/**
 * What kind of thing this is, from its media type. The catalog draws an icon
 * per kind, so a guess that lands on `other` costs nothing.
 */
function kindOf(mediaType: string | undefined): string {
  const type = (mediaType ?? "").toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (type.includes("spreadsheet") || type === "text/csv") return "spreadsheet";
  if (type.includes("zip") || type.includes("tar") || type.includes("gzip")) {
    return "archive";
  }
  if (type.includes("json") || type.includes("javascript")) return "code";
  if (type.startsWith("text/") || type === "application/pdf") return "document";
  return "other";
}

/** The last path segment, which is what a person calls a file. */
function nameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const last = path.split("/").filter(Boolean).at(-1);
    return last && last.length > 0 ? decodeURIComponent(last) : url;
  } catch {
    return url;
  }
}

const fileCard: PluginCard = {
  render({ surfaceId, data }) {
    const url = String(data.url ?? "");
    if (url.length === 0) {
      return { drop: true, reason: "an attachment needs a URL" };
    }
    const name = (
      typeof data.name === "string" && data.name.length > 0
        ? data.name
        : nameFromUrl(url)
    ).slice(0, 160);
    const mediaType =
      typeof data.mediaType === "string" && data.mediaType.length > 0
        ? data.mediaType
        : undefined;
    // `http` is still an attachment the send seam accepts, and the catalog
    // opens `https` only. Rather than have the whole card refused for the
    // scheme, the link is named in the detail line and no open control is
    // drawn: an attachment nobody can open must not look like one they can.
    const openable = url.startsWith("https://");
    const detail = [mediaType, openable ? undefined : url]
      .filter((part) => part !== undefined)
      .join(" · ");
    return surface(surfaceId, [
      { id: "root", component: "Column", children: ["file"] },
      {
        id: "file",
        component: "FileAttachment",
        name,
        kind: kindOf(mediaType),
        ...(detail.length > 0 ? { detail } : {}),
        ...(openable ? { url } : {}),
      },
    ]);
  },
};

export const cards = { file: fileCard };

export const execute: PluginExecute = (tool) => {
  throw new Error(`unknown tool ${tool}`);
};
