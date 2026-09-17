/// The Frock catalog's component schemas — the one place they are written.
///
/// A2UI's security model is that a catalog is JSON Schema only and its
/// implementation is host code (ADR 0030). So two things have to agree about
/// every Frock component: the Dart that draws it, and the JSON the model is
/// taught to write. They agree here and nowhere else: this file is the source
/// of truth, `frock_catalog.dart` builds each `CatalogItem` from it, and
/// `scripts/generate-frock-catalog.ts` wraps these schemas in the A2UI catalog
/// definition and writes `core/protocol-schemas/schema/frock-catalog.json`,
/// which the `typecheck` gate refuses to let go stale.
///
/// The schemas are JSON in a raw string rather than Dart map literals, for one
/// reason: the generator has to read them without a Dart toolchain — the
/// `typecheck` gate runs under bun, where Flutter is not installed — and a
/// string it lifts and hands to `JSON.parse` cannot be read two ways. A Dart
/// literal would need a Dart parser in the script, and a parser is a second
/// opinion about what the source says. The Dart pays one `jsonDecode`.
///
/// Each entry is the component's own properties, as `CatalogItem.dataSchema`
/// wants them: no `component` discriminator and no `id`, which A2UI's common
/// types already carry. A value a settled card changes is declared a
/// `DynamicString`, so the Bot may bind it to the data model by pointer
/// rather than resend the layout.
library;

import 'dart:convert';

/// The catalog the Frock components are named under. Reverse-domain and
/// versioned, as A2UI asks; it is also the id a Card's record carries, and the
/// alias list in `frock_catalog.dart` is what lets a surface created under the
/// standard catalog's id still find these components.
const frockCatalogIdV1 = 'https://frockbot.com/a2ui/catalogs/frock/v1.json';

/// The A2UI common types every catalog's components are defined against.
const a2uiCommonTypesIdV1 =
    'https://a2ui.org/specification/v0_9/common_types.json';

/// The component schemas, by component name. The library comment says why this
/// is a string.
const frockCatalogSchemasJsonV1 = r'''
{
  "StatusPill": {
    "type": "object",
    "description": "A small pill stating what state the card is in. One per card, beside its title.",
    "properties": {
      "label": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
        "description": "The words on the pill, e.g. 'Ready to send' or 'Sent'. Bind this to the data model when the card settles."
      },
      "tone": {
        "type": "string",
        "enum": ["neutral", "ready", "success", "warning", "danger"],
        "description": "What the state means, which is what the host colours the pill by. 'ready' is waiting on the person, 'success' is done, 'warning' needs attention, 'danger' failed. Defaults to 'neutral'."
      }
    },
    "required": ["label"]
  },
  "KeyValueRows": {
    "type": "object",
    "description": "Labelled values in a column, one per row: From, To, Cc, Subject. For facts about the thing the card shows, never as a form.",
    "properties": {
      "rows": {
        "type": "array",
        "description": "The rows, in the order they are read.",
        "items": {
          "type": "object",
          "properties": {
            "label": {
              "type": "string",
              "description": "The short label on the left, e.g. 'To'."
            },
            "value": {
              "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
              "description": "The value on the right. Bind it to the data model when it changes."
            }
          },
          "required": ["label", "value"]
        }
      }
    },
    "required": ["rows"]
  },
  "CollapsibleText": {
    "type": "object",
    "description": "A body of text that starts collapsed, with a control that shows the rest. For a draft, a quote, or anything longer than the card.",
    "properties": {
      "text": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
        "description": "The body. Plain text; a card is not a document."
      },
      "collapsedLines": {
        "type": "integer",
        "minimum": 1,
        "maximum": 40,
        "description": "How many lines are shown before the control appears. Defaults to 6."
      }
    },
    "required": ["text"]
  },
  "ApprovalActions": {
    "type": "object",
    "description": "The approve and decline controls for one Approval the kernel issued. Compose it into a card; the host draws the buttons and names the actions, and the decision is recorded once and durably.",
    "properties": {
      "approvalId": {
        "type": "string",
        "description": "The id the kernel issued when the Bot proposed the action. A card cannot invent one: an id the kernel never recorded is refused when the button is pressed."
      },
      "approveLabel": {
        "type": "string",
        "description": "The word on the approving control. Defaults to 'Approve'."
      },
      "declineLabel": {
        "type": "string",
        "description": "The word on the declining control. Defaults to 'Decline'."
      }
    },
    "required": ["approvalId"]
  },
  "Receipt": {
    "type": "object",
    "description": "What a card settles into: its title, the pill saying what happened, and one line summarising it. Use it in place of the controls once the thing is done.",
    "properties": {
      "title": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
        "description": "The same title the card carried before it settled."
      },
      "status": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
        "description": "The words on the pill, e.g. 'Sent'."
      },
      "tone": {
        "type": "string",
        "enum": ["neutral", "ready", "success", "warning", "danger"],
        "description": "What the state means. Defaults to 'success', because a receipt usually says a thing worked."
      },
      "summary": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
        "description": "One line saying what was done, e.g. 'Sent to nick@example.com — Re: Following up'."
      }
    },
    "required": ["title", "status"]
  }
}
''';

/// The schemas, decoded once, by component name and in declaration order.
final Map<String, Map<String, Object?>> frockCatalogSchemasV1 =
    Map.unmodifiable(
      (jsonDecode(frockCatalogSchemasJsonV1) as Map<String, Object?>).map(
        (name, schema) =>
            MapEntry(name, (schema! as Map).cast<String, Object?>()),
      ),
    );
