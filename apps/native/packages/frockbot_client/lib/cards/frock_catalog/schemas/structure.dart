/// The structure family: the parts that give a card its frame (ADR 0030 step
/// 8).
///
/// A card is read top to bottom in two seconds, so the frame is worth its own
/// components: one header that can never overflow whatever the model writes,
/// one way to break a long card into sections, one way to say something that
/// is not part of the thing itself, and one way to name a person or an
/// account. Composing any of these out of `Row`s and `Text`s costs four
/// components and drifts from the app the first time the model guesses a
/// padding.
///
/// The schemas are JSON in a raw string for the reason `../schemas.dart`
/// gives: `scripts/generate-frock-catalog.ts` lifts the string and parses it
/// without a Dart toolchain, and a string cannot be read two ways.
library;

/// The structure family, by component name.
const frockStructureSchemasJsonV1 = r'''
{
  "CardHeader": {
    "type": "object",
    "description": "The top of a card: its title, an optional line under it, and the pill saying what state it is in. Prefer this to a Row of Text and StatusPill — the host lays it out so the pill can never be pushed off the edge on a phone.",
    "properties": {
      "title": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
        "description": "What the card is about, in a few words. Two lines at most; the host truncates past that."
      },
      "subtitle": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
        "description": "One quieter line under the title: who it is for, when it was made."
      },
      "status": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
        "description": "The words on the pill at the right, e.g. 'Ready to send'. Bind it to the data model and the card settles with one updateDataModel. Omit it for a card with no state."
      },
      "tone": {
        "type": "string",
        "enum": ["neutral", "ready", "success", "warning", "danger"],
        "description": "What the state means, which is what the host colours the pill by. Defaults to 'neutral'."
      }
    },
    "required": ["title"]
  },
  "SectionHeader": {
    "type": "object",
    "description": "A small heading that divides a long card into parts, with a hairline under it. Use it between blocks, never as the card's own title — that is CardHeader.",
    "properties": {
      "title": {
        "type": "string",
        "maxLength": 80,
        "description": "The section's name, e.g. 'Attachments'."
      },
      "caption": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
        "description": "A short note at the right of the heading, e.g. a count."
      }
    },
    "required": ["title"]
  },
  "Callout": {
    "type": "object",
    "description": "A tinted note beside the thing the card is about: a warning, a consequence, a piece of context. One per card at most — a card that needs two is telling the person too much at once.",
    "properties": {
      "text": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
        "description": "What the person needs to know, in a sentence or two."
      },
      "title": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
        "description": "An optional bold first line."
      },
      "tone": {
        "type": "string",
        "enum": ["neutral", "ready", "success", "warning", "danger"],
        "description": "What kind of note it is, which is what the host colours and which icon it draws. Defaults to 'neutral'."
      }
    },
    "required": ["text"]
  },
  "IdentityRow": {
    "type": "object",
    "description": "A person or an account on one line: an avatar, a name, and a quieter second line. For the sender of an email, the owner of a file, the account a connection belongs to.",
    "properties": {
      "name": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
        "description": "Who it is."
      },
      "detail": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
        "description": "The second line: an address, a handle, a role."
      },
      "imageUrl": {
        "type": "string",
        "maxLength": 2048,
        "description": "An https:// avatar. A card carrying any other scheme is refused whole."
      },
      "initials": {
        "type": "string",
        "maxLength": 3,
        "description": "What the avatar says when there is no image. Defaults to the first letter of the name."
      }
    },
    "required": ["name"]
  }
}
''';
