/// The small readings every Frock component makes of its own data.
///
/// A component is handed the decoded JSON the model wrote, so every property
/// is `Object?` until someone asks what it is. Asking is done here rather than
/// in each widget, so that a property the model got wrong reads as absent
/// everywhere — a card is refused whole by `admitCardV1` for a name or a
/// budget, never redrawn half-way through because one string arrived as a
/// number.
library;

import 'package:flutter/material.dart';
import 'package:genui/genui.dart';
import 'package:json_schema_builder/json_schema_builder.dart';

import 'schemas.dart';

/// One Frock component's schema, as `CatalogItem` wants it. The schema is
/// never written twice: it comes from the family file that declares it, which
/// is also what the catalog JSON is generated from.
Schema frockSchemaOf(String name) {
  final schema = frockCatalogSchemasV1[name];
  if (schema == null) throw StateError('no schema for Frock $name');
  return Schema.fromMap(schema);
}

/// A property that must be a literal string, or null.
String? frockString(Object? value) => value is String ? value : null;

/// A property that must be a whole number in `[min, max]`, or [fallback].
int frockInt(
  Object? value, {
  required int min,
  required int max,
  int? fallback,
}) {
  final number = value is int
      ? value
      : value is num
      ? value.round()
      : null;
  if (number == null || number < min || number > max) return fallback ?? min;
  return number;
}

/// A property that must be a boolean, or [fallback].
bool frockBool(Object? value, {bool fallback = false}) =>
    value is bool ? value : fallback;

/// The maps in a list property, with anything else in it dropped.
List<Map<String, Object?>> frockRows(Object? value, {required int max}) => [
  for (final row in (value is List ? value : const []).take(max))
    if (row is Map) row.cast<String, Object?>(),
];

/// A `DynamicString` drawn as text: a literal, or whatever the data model
/// holds at the pointer it named, redrawn when that moves.
///
/// Every Frock component that shows a value goes through this, so a card can
/// settle by writing one pointer rather than by resending its layout.
class FrockBoundText extends StatelessWidget {
  final DataContext dataContext;
  final Object? value;
  final TextStyle? style;
  final int? maxLines;
  final TextAlign? align;

  /// Drawn instead when the value resolves to nothing. A bound value that is
  /// not there yet is a card mid-settle, not an empty line.
  final Widget? whenEmpty;
  const FrockBoundText({
    super.key,
    required this.dataContext,
    required this.value,
    this.style,
    this.maxLines,
    this.align,
    this.whenEmpty,
  });

  @override
  Widget build(BuildContext context) => BoundString(
    dataContext: dataContext,
    value: value,
    builder: (context, text) {
      if ((text ?? '').isEmpty && whenEmpty != null) return whenEmpty!;
      return Text(
        text ?? '',
        style: style,
        maxLines: maxLines,
        textAlign: align,
        overflow: maxLines == null ? null : TextOverflow.ellipsis,
      );
    },
  );
}
