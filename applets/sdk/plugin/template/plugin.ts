import type { PluginExecute, PluginTool } from "@frockbot/applet-sdk/plugin";

/**
 * __PLUGIN_NAME__: a starting point that already builds.
 *
 * Every tool here is also named in `plugin.json`, and the `storage` grant the
 * descriptor declares is what makes `ctx.storage` exist. Change both files
 * together: a tool the module exports but the descriptor omits, or the other
 * way round, is refused at publish.
 */
export const tools: PluginTool[] = [
  {
    name: "note_count",
    description: "How many notes this Plugin has kept for this Bot.",
    inputSchema: { type: "object", properties: {} },
    idempotent: true,
  },
  {
    name: "note_add",
    description: "Keep one short note for this Bot.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
];

interface Notes {
  entries: string[];
}

async function readNotes(
  storage: NonNullable<Parameters<PluginExecute>[2]["storage"]>,
): Promise<Notes> {
  const outcome = await storage.get({ key: "notes" });
  if (outcome.status !== "available" || !outcome.value) return { entries: [] };
  return outcome.value as Notes;
}

/**
 * A string answer goes to the Bot as it is. Throwing answers with an error
 * the Bot can read, so a refusal is a thrown `Error`, never a quiet string.
 */
export const execute: PluginExecute = async (tool, input, ctx) => {
  const storage = ctx.storage;
  if (!storage) throw new Error("the storage grant is not open");
  switch (tool) {
    case "note_count": {
      const notes = await readNotes(storage);
      return `${notes.entries.length} note(s).`;
    }
    case "note_add": {
      const text = String((input as { text?: unknown } | null)?.text ?? "");
      if (text.length === 0) throw new Error("text is required");
      const notes = await readNotes(storage);
      notes.entries.push(text);
      await storage.put({ key: "notes", value: notes });
      return `Kept it. ${notes.entries.length} note(s) now.`;
    }
    default:
      throw new Error(`unknown tool ${tool}`);
  }
};
