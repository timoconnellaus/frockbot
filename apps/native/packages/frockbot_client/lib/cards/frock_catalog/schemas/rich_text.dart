/// The rich text family: prose, code and quotation (ADR 0030 step 8).
///
/// The standard catalog's `Text` is one run of characters in one style. A card
/// that is showing a summary with a list in it, a command to run, or something
/// somebody else wrote needs three different things, and composing any of them
/// out of `Text`s loses the thing that made them readable.
///
/// The schemas are JSON in a raw string for the reason `../schemas.dart`
/// gives: `scripts/generate-frock-catalog.ts` lifts the string and parses it
/// without a Dart toolchain, and a string cannot be read two ways.
library;

/// The rich text family, by component name.
const frockRichTextSchemasJsonV1 = r'''
{
  "Markdown": {
    "type": "object",
    "description": "A body of Markdown, drawn the way the Bot's own messages are: headings, bullet and ordered lists, emphasis, inline code, block quotes, rules and links. Use it for anything with structure in it; use Text for one plain run.",
    "properties": {
      "text": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
        "description": "The Markdown source. The subset the app draws is the one it draws chat messages with; anything else is shown as the characters you wrote. No HTML is rendered, ever."
      }
    },
    "required": ["text"]
  },
  "CodeBlock": {
    "type": "object",
    "description": "Code, a command, or a payload, in a monospaced box with a control that copies it. Use it whenever the person might need the text exactly — never a Text, which will wrap and lose the indentation.",
    "properties": {
      "code": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
        "description": "The text, exactly as it should be copied. Do not wrap it in backticks."
      },
      "language": {
        "type": "string",
        "maxLength": 24,
        "description": "What it is, drawn as a label above the box: 'bash', 'json', 'dart'. There is no syntax colouring; this only says what the person is looking at."
      },
      "caption": {
        "type": "string",
        "maxLength": 120,
        "description": "One line under the box: where it came from, what it does."
      }
    },
    "required": ["code"]
  },
  "Quote": {
    "type": "object",
    "description": "Something somebody else wrote, set apart from the card's own words: the message being replied to, the line of a document under discussion. Never for the Bot's own text.",
    "properties": {
      "text": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
        "description": "The quoted words. Keep it to the part that matters; a long quotation belongs in CollapsibleText."
      },
      "attribution": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
        "description": "Who said it, and when: 'Nick, Tuesday 9:14am'."
      }
    },
    "required": ["text"]
  }
}
''';
