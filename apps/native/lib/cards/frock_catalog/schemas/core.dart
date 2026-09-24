/// The first family: the card's own state, its facts, its body, its decision,
/// the app it offers to connect and what it settles into (ADR 0030 step 4).
///
/// The schemas are JSON in a raw string for the reason
/// `../schemas.dart` gives: `scripts/generate-frock-catalog.ts` lifts the
/// string and parses it without a Dart toolchain, and a string cannot be read
/// two ways.
library;

/// The core family, by component name.
const frockCoreSchemasJsonV1 = r'''
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
  "ConnectApp": {
    "type": "object",
    "description": "An app from the Marketplace the person can connect: its logo, its name and a Connect button that opens the app's own sign-in. Name the app and nothing else; the host fills in the rest from its own catalog and draws the button, so a card can never say one app and connect another. A press never reaches you: the person signs in on the app's page, and the app's tools reach you on a later Turn.",
    "properties": {
      "app": {
        "type": "string",
        "minLength": 1,
        "maxLength": 100,
        "description": "The app: its Marketplace id, e.g. 'gmail' or 'googlecalendar', or its name, e.g. 'Google Calendar'. An app the Marketplace does not carry is refused when the card is sent, and the refusal names the closest ones it does."
      },
      "name": {
        "type": "string",
        "description": "Written by the host from its own catalog. Whatever a card puts here is replaced."
      },
      "description": {
        "type": "string",
        "description": "Written by the host from its own catalog. Whatever a card puts here is replaced."
      },
      "packageId": {
        "type": "string",
        "description": "Written by the host from its own catalog. Whatever a card puts here is replaced."
      },
      "connectionTypeId": {
        "type": "string",
        "description": "Written by the host from its own catalog. Whatever a card puts here is replaced."
      }
    },
    "required": ["app"]
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
