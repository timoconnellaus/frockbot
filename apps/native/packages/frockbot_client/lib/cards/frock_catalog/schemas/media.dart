/// The media family: pictures, files and links (ADR 0030 step 8).
///
/// The standard catalog has one `Image`, which is one picture and nothing
/// else. A card that shows what a Bot found needs three things it does not
/// have: several pictures without spending a component on each, a file the
/// person can open, and a link that says where it goes before they follow it.
///
/// Every link in this family is `https://` or the card is refused whole, and
/// following one goes through the host's own link handling (`../links.dart`),
/// never through the component.
///
/// The schemas are JSON in a raw string for the reason `../schemas.dart`
/// gives: `scripts/generate-frock-catalog.ts` lifts the string and parses it
/// without a Dart toolchain, and a string cannot be read two ways.
library;

/// The media family, by component name.
const frockMediaSchemasJsonV1 = r'''
{
  "ImageGallery": {
    "type": "object",
    "description": "Several pictures in one component: what was found, what was generated, the pages of a document. One image draws full width; more than one draws as a strip that scrolls. Tapping one opens it.",
    "properties": {
      "images": {
        "type": "array",
        "minItems": 1,
        "maxItems": 8,
        "description": "The pictures, in the order they are shown.",
        "items": {
          "type": "object",
          "properties": {
            "url": {
              "type": "string",
              "maxLength": 2048,
              "description": "An https:// image. A card carrying any other scheme is refused whole and nothing is drawn."
            },
            "caption": {
              "type": "string",
              "maxLength": 120,
              "description": "One line under the picture."
            },
            "alt": {
              "type": "string",
              "maxLength": 200,
              "description": "What the picture shows, for a person who cannot see it. Write one."
            }
          },
          "required": ["url"]
        }
      }
    },
    "required": ["images"]
  },
  "FileAttachment": {
    "type": "object",
    "description": "A file the card is about: a document, an export, a generated artifact. One row with what it is and a control that opens it.",
    "properties": {
      "name": {
        "type": "string",
        "maxLength": 160,
        "description": "The file's name, as the person would recognise it."
      },
      "detail": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
        "description": "What is worth knowing about it, already in words: 'PDF · 1.2 MB', 'Generated just now'. There is no formatting function; write the size the way a person reads it."
      },
      "kind": {
        "type": "string",
        "enum": [
          "document",
          "spreadsheet",
          "image",
          "audio",
          "video",
          "archive",
          "code",
          "other"
        ],
        "description": "What sort of file it is, which is the icon the host draws. Defaults to 'other'."
      },
      "url": {
        "type": "string",
        "maxLength": 2048,
        "description": "An https:// link to the file. With one the row offers to open it, through the app's own link handling; without one it is a row that says the file exists."
      }
    },
    "required": ["name"]
  },
  "LinkPreview": {
    "type": "object",
    "description": "One link, with enough of what is behind it that the person can decide before they follow it. Use it for a page a Bot found or made; a bare link inside prose belongs in Markdown.",
    "properties": {
      "url": {
        "type": "string",
        "maxLength": 2048,
        "description": "Where it goes. https:// only, and the whole card is refused otherwise."
      },
      "title": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
        "description": "What the page is called."
      },
      "description": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
        "description": "A line or two about it. Two lines at most are drawn."
      },
      "site": {
        "type": "string",
        "maxLength": 80,
        "description": "Whose page it is, e.g. 'example.com'. Defaults to the link's own host."
      },
      "imageUrl": {
        "type": "string",
        "maxLength": 2048,
        "description": "An https:// thumbnail beside the title."
      }
    },
    "required": ["url", "title"]
  }
}
''';
