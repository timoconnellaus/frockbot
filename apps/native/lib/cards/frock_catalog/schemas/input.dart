/// The input family: the answers a card can take (ADR 0030 step 8).
///
/// The standard catalog has `TextField`, `CheckBox`, `Slider`,
/// `DateTimeInput` and `ChoicePicker`, which is a drop-down. What a chat card
/// actually asks for is smaller and more direct: pick one of these five, tick
/// several of these eight, choose between two views, say how good it was. Each
/// of those built out of `CheckBox`es costs a component per option and reads
/// like a form.
///
/// Every control here writes into the data model at the pointer its `value`
/// names, which is why that property must be a binding: a press carries the
/// renderer's data model back to the kernel, and a selection the component
/// kept to itself would never leave the card.
///
/// The schemas are JSON in a raw string for the reason `../schemas.dart`
/// gives: `scripts/generate-frock-catalog.ts` lifts the string and parses it
/// without a Dart toolchain, and a string cannot be read two ways.
library;

/// The input family, by component name.
const frockInputSchemasJsonV1 = r'''
{
  "ChoiceChips": {
    "type": "object",
    "description": "Pick one of a handful of options, laid out as chips that wrap. For a short, visible set — a tone, a recipient, a date the Bot suggested. Use ChoicePicker for a long list.",
    "properties": {
      "options": {
        "type": "array",
        "minItems": 2,
        "maxItems": 12,
        "description": "What can be picked, in the order shown.",
        "items": {
          "type": "object",
          "properties": {
            "label": {
              "type": "string",
              "maxLength": 60,
              "description": "The words on the chip."
            },
            "value": {
              "type": "string",
              "maxLength": 200,
              "description": "What is written to the data model when it is picked. This is what you will read back, so make it something you can act on."
            }
          },
          "required": ["label", "value"]
        }
      },
      "value": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
        "description": "Where the pick is kept: write a binding, `{\"path\": \"/tone\"}`. It must be a binding — a press carries the data model back, and a selection the component kept to itself would never reach you."
      },
      "action": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/Action",
        "description": "Raised as soon as a chip is picked, when picking is the whole answer. Leave it out when a Button below submits the card."
      }
    },
    "required": ["options", "value"]
  },
  "MultiSelect": {
    "type": "object",
    "description": "Tick any number of a handful of options. The ticked values are kept as a list in the data model, in the order the options are declared.",
    "properties": {
      "options": {
        "type": "array",
        "minItems": 2,
        "maxItems": 12,
        "description": "What can be ticked, in the order shown.",
        "items": {
          "type": "object",
          "properties": {
            "label": {
              "type": "string",
              "maxLength": 60,
              "description": "The words beside the box."
            },
            "value": {
              "type": "string",
              "maxLength": 200,
              "description": "What appears in the list when it is ticked."
            },
            "detail": {
              "type": "string",
              "maxLength": 120,
              "description": "One quieter line under the label."
            }
          },
          "required": ["label", "value"]
        }
      },
      "values": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicStringList",
        "description": "Where the ticked values are kept: write a binding, `{\"path\": \"/include\"}`. Seed the data model with the ones that start ticked."
      },
      "maxSelected": {
        "type": "integer",
        "minimum": 1,
        "maximum": 12,
        "description": "How many may be ticked at once. Past it the unticked options stop responding and the host says why. Unbounded by default."
      }
    },
    "required": ["options", "values"]
  },
  "SegmentedControl": {
    "type": "object",
    "description": "Choose between two, three or four things that are always visible — a view, a mode, a period. Not for an answer with many options: that is ChoiceChips.",
    "properties": {
      "options": {
        "type": "array",
        "minItems": 2,
        "maxItems": 4,
        "description": "The segments, left to right.",
        "items": {
          "type": "object",
          "properties": {
            "label": {
              "type": "string",
              "maxLength": 32,
              "description": "The words in the segment. Keep them to one or two."
            },
            "value": {
              "type": "string",
              "maxLength": 200,
              "description": "What is written to the data model when it is chosen."
            }
          },
          "required": ["label", "value"]
        }
      },
      "value": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
        "description": "Where the choice is kept: write a binding. The first segment is drawn as chosen when the data model holds nothing."
      },
      "action": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/Action",
        "description": "Raised when a segment is chosen. Leave it out when the choice only changes what the card shows."
      }
    },
    "required": ["options", "value"]
  },
  "Rating": {
    "type": "object",
    "description": "How good was it, in stars. For asking, and — with readOnly — for showing a rating that is already recorded.",
    "properties": {
      "value": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicNumber",
        "description": "How many stars, from 0. Write a binding when you are asking; a literal is fine when readOnly is true."
      },
      "max": {
        "type": "integer",
        "minimum": 3,
        "maximum": 10,
        "description": "How many stars there are. Defaults to 5."
      },
      "label": {
        "type": "string",
        "maxLength": 80,
        "description": "What is being rated, drawn above the stars."
      },
      "readOnly": {
        "type": "boolean",
        "description": "True shows a rating rather than asking for one. Defaults to false."
      }
    },
    "required": ["value"]
  }
}
''';
