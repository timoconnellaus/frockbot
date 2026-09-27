/// The data family: the numbers and the rows a card is about (ADR 0030 step
/// 8).
///
/// `KeyValueRows` in the core family answers "what are the facts about this
/// one thing". These four answer the other shapes a card's content comes in:
/// one number that matters, a proportion, a grid of rows, and a sequence of
/// events. A table composed by hand out of `Row`s costs a component per cell
/// and cannot be made to line up its columns; a timeline drawn out of `Text`s
/// loses the one thing a timeline is for.
///
/// The schemas are JSON in a raw string for the reason `../schemas.dart`
/// gives: `scripts/generate-frock-catalog.ts` lifts the string and parses it
/// without a Dart toolchain, and a string cannot be read two ways.
library;

/// The data family, by component name.
const frockDataSchemasJsonV1 = r'''
{
  "MetricTile": {
    "type": "object",
    "description": "One number that matters, with its name under it and an optional movement beside it. Put two or three in a Row for a summary; a Row of six is a table, so use DataTable instead.",
    "properties": {
      "label": {
        "type": "string",
        "maxLength": 60,
        "description": "What the number is, e.g. 'Open invoices'."
      },
      "value": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
        "description": "The number itself, already formatted the way a person reads it: '$4,120', '18%', '3 of 7'."
      },
      "delta": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
        "description": "How it moved, e.g. '+12%' or '-3 since Friday'. The host draws an arrow from the sign it starts with."
      },
      "caption": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
        "description": "One quiet line under the tile: the period, the source."
      },
      "tone": {
        "type": "string",
        "enum": ["neutral", "ready", "success", "warning", "danger"],
        "description": "What the number means — not which way it moved. Defaults to 'neutral'."
      }
    },
    "required": ["label", "value"]
  },
  "ProgressBar": {
    "type": "object",
    "description": "A proportion: how far through something is, how much of a budget is used. For work that is running, not for a rating.",
    "properties": {
      "value": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicNumber",
        "description": "Between 0 and 1. Anything outside that is clamped. Bind it and the bar moves with one updateDataModel."
      },
      "label": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
        "description": "What is progressing, above the bar."
      },
      "caption": {
        "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
        "description": "The count in words, at the right of the label: '3 of 7', '62%'."
      },
      "tone": {
        "type": "string",
        "enum": ["neutral", "ready", "success", "warning", "danger"],
        "description": "What the host colours the filled part. Defaults to 'ready' while something is running."
      },
      "indeterminate": {
        "type": "boolean",
        "description": "True when the proportion is not known yet: the bar animates instead of filling. Defaults to false."
      }
    },
    "required": ["value"]
  },
  "DataTable": {
    "type": "object",
    "description": "Rows in aligned columns: line items, search results, a comparison. The host lays the columns out so they fit the card at phone width — never compose a table out of Rows.",
    "properties": {
      "columns": {
        "type": "array",
        "minItems": 1,
        "maxItems": 5,
        "description": "The columns, left to right. Five at most: a card is not a spreadsheet.",
        "items": {
          "type": "object",
          "properties": {
            "label": {
              "type": "string",
              "maxLength": 40,
              "description": "The heading."
            },
            "align": {
              "type": "string",
              "enum": ["start", "end"],
              "description": "Which edge the cells sit against. Use 'end' for numbers. Defaults to 'start'."
            },
            "weight": {
              "type": "integer",
              "minimum": 1,
              "maximum": 6,
              "description": "This column's share of the width, against the other columns'. Defaults to 1."
            }
          },
          "required": ["label"]
        }
      },
      "rows": {
        "type": "array",
        "maxItems": 24,
        "description": "The rows, in the order they are read. A row has one cell per column; a short row is padded, and extra cells are dropped.",
        "items": {
          "type": "object",
          "properties": {
            "cells": {
              "type": "array",
              "maxItems": 5,
              "description": "This row's cells, in column order.",
              "items": {
                "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString"
              }
            }
          },
          "required": ["cells"]
        }
      },
      "caption": {
        "type": "string",
        "maxLength": 120,
        "description": "One line under the table, e.g. 'Showing the 12 most recent of 340'. Say so here when the rows are a sample."
      }
    },
    "required": ["columns", "rows"]
  },
  "Timeline": {
    "type": "object",
    "description": "What happened, in order, down a rail: the steps of a run, the history of a thread, what a Routine did overnight. For events with a time, not for a list of things.",
    "properties": {
      "entries": {
        "type": "array",
        "minItems": 1,
        "maxItems": 20,
        "description": "The events, oldest first unless the card says otherwise.",
        "items": {
          "type": "object",
          "properties": {
            "title": {
              "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
              "description": "What happened, in a few words."
            },
            "detail": {
              "$ref": "https://a2ui.org/specification/v0_9/common_types.json#/$defs/DynamicString",
              "description": "One quieter line under it."
            },
            "time": {
              "type": "string",
              "maxLength": 40,
              "description": "When, in the words a person reads: '9:14am', 'Tuesday', '3 days ago'."
            },
            "tone": {
              "type": "string",
              "enum": ["neutral", "ready", "success", "warning", "danger"],
              "description": "What this step means, which is what the host colours its dot. Defaults to 'neutral'."
            }
          },
          "required": ["title"]
        }
      }
    },
    "required": ["entries"]
  }
}
''';
