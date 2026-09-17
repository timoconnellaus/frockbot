import type {
  CardMessage,
  PluginCard,
  PluginExecute,
  PluginTool,
} from "@frockbot/applet-sdk/plugin";

/**
 * Question cards: the `widget` payload, drawn from the catalog (ADR 0030 step
 * 7).
 *
 * One thing changes in the move, and it is the thing ADR 0030 said would:
 * the card answers. "Anything else is conversation input: the event name and
 * context are the Bot's next user-lane Turn's pending input" — which the ADR
 * spells out as "what a `widget` answer is today". The old bubble drew the
 * options as dead pills and left the person to type one back; picking a chip
 * is that answer, delivered as input and never as something the User said.
 *
 * Nothing here decides anything. The Turn ended when the question was sent,
 * as it always did, and the answer reaches the Bot as durable input.
 */

export const tools: PluginTool[] = [];

const FROCK_CATALOG_ID = "https://frockbot.com/a2ui/catalogs/frock/v1.json";

/**
 * The action every answer raises. Not `plugin/…` and not `approval/…`, so the
 * kernel routes it as conversation input: the Bot reads the name and the
 * chosen value on its next Turn.
 */
const ANSWER_ACTION = "question-answer";

/** Where the chosen value lives while the person is choosing it. */
const ANSWER_POINTER = "/answer";

function surface(
  surfaceId: string,
  components: unknown[],
  dataModel: Record<string, unknown>,
): CardMessage[] {
  return [
    {
      version: "v1.0",
      createSurface: {
        surfaceId,
        catalogId: FROCK_CATALOG_ID,
        components,
        dataModel,
        // The chips bind the answer into the data model, so the press has to
        // carry it for the Bot to read what was picked.
        sendDataModel: true,
      },
    },
  ];
}

const askCard: PluginCard = {
  render({ surfaceId, data }) {
    const prompt = String(data.prompt ?? "");
    const options = Array.isArray(data.options)
      ? data.options.map((option) => String(option)).filter((o) => o.length > 0)
      : [];
    if (prompt.length === 0 || options.length === 0) {
      return { drop: true, reason: "a question needs a prompt and an answer" };
    }
    const helpText =
      typeof data.helpText === "string" && data.helpText.length > 0
        ? data.helpText
        : undefined;
    const note =
      data.allowCustom === true
        ? "Any other answer is accepted too — just say it."
        : undefined;
    // `ChoiceChips` holds two options or more. A question with one answer is
    // a single button, which is the same press under the same action name.
    const answer =
      options.length > 1
        ? {
            id: "answer",
            component: "ChoiceChips",
            options: options.map((option) => ({
              label: option,
              value: option,
            })),
            value: { path: ANSWER_POINTER },
            action: {
              event: {
                name: ANSWER_ACTION,
                context: { answer: { path: ANSWER_POINTER } },
              },
            },
          }
        : {
            id: "answer",
            component: "Button",
            child: "answerLabel",
            variant: "primary",
            action: {
              event: { name: ANSWER_ACTION, context: { answer: options[0] } },
            },
          };
    const children = [
      "header",
      ...(helpText ? ["help"] : []),
      "answer",
      ...(note ? ["note"] : []),
    ];
    return surface(
      surfaceId,
      [
        { id: "root", component: "Column", children },
        { id: "header", component: "CardHeader", title: prompt },
        ...(helpText
          ? [{ id: "help", component: "Markdown", text: helpText }]
          : []),
        answer,
        ...(options.length > 1
          ? []
          : [{ id: "answerLabel", component: "Text", text: options[0] }]),
        ...(note
          ? [{ id: "note", component: "Text", text: note, variant: "caption" }]
          : []),
      ],
      // The pointer the chips bind to exists from the first draw, so the
      // renderer has somewhere to put the answer before one is picked.
      { answer: "" },
    );
  },
};

export const cards = { ask: askCard };

export const execute: PluginExecute = (tool) => {
  throw new Error(`unknown tool ${tool}`);
};
