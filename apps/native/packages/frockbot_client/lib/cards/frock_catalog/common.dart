/// The small readings every Frock component makes of its own data.
///
/// A component is handed its properties as the renderer resolved them: a
/// value the schema declares dynamic arrives as a binding holding what it
/// resolved to, and anything else as the decoded JSON the model wrote, so
/// every property is `Object?` until someone asks what it is. Asking is done
/// here rather than in each widget, so that a property the model got wrong
/// reads as absent everywhere — a card is refused whole by `admitCardV1` for
/// a name or a budget, never redrawn half-way through because one string
/// arrived as a number.
library;

import 'dart:async';

import 'package:a2ui_core/a2ui_core.dart';
import 'package:a2ui_flutter/a2ui_flutter.dart';
import 'package:flutter/material.dart';
import 'package:json_schema_builder/json_schema_builder.dart'
    hide ValidationResult;

import 'schemas.dart';

/// One Frock component's schema, as `ComponentImplementation` wants it. The
/// schema is never written twice: it comes from the family file that declares
/// it, which is also what the catalog JSON is generated from.
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

/// Whether the model wrote a property at all.
///
/// A dynamic property the model left out still arrives, as a binding to
/// nothing, so presence is asked of what was written: a binding to the data
/// model counts even while the value it names is not there yet, because that
/// is a card mid-settle rather than a line it does not have.
bool frockWrittenV1(Object? value) =>
    value is WritableBinding || ComponentProps.unwrap(value) != null;

/// A `DynamicString` drawn as text: a literal, or whatever the data model
/// holds at the pointer it named. [value] is the property as the renderer
/// resolved it, and the component is rebuilt when that moves.
///
/// Every Frock component that shows a value goes through this, so a card can
/// settle by writing one pointer rather than by resending its layout.
class FrockBoundText extends StatelessWidget {
  final Object? value;
  final TextStyle? style;
  final int? maxLines;
  final TextAlign? align;

  /// Drawn instead when the value resolves to nothing. A bound value that is
  /// not there yet is a card mid-settle, not an empty line.
  final Widget? whenEmpty;
  const FrockBoundText({
    super.key,
    required this.value,
    this.style,
    this.maxLines,
    this.align,
    this.whenEmpty,
  });

  @override
  Widget build(BuildContext context) {
    final text = ComponentProps.asString(value);
    if ((text ?? '').isEmpty && whenEmpty != null) return whenEmpty!;
    return Text(
      text ?? '',
      style: style,
      maxLines: maxLines,
      textAlign: align,
      overflow: maxLines == null ? null : TextOverflow.ellipsis,
    );
  }
}

/// Where a control keeps what the person chose, read and written.
///
/// A control's [key] should be a binding — the schemas say so — because a
/// press carries the renderer's data model back to the kernel, and a selection
/// held anywhere else never leaves the card. When the model wrote a literal
/// anyway the control still works: it writes under its own id, the way the
/// standard catalog's `CheckBox` did under the renderer this replaced, so
/// nobody is handed a control that does nothing.
Widget frockControlV1(
  ComponentNode<ComponentImplementation> node,
  ComponentProps props,
  String key,
  Widget Function(Object? value, void Function(Object? value) write) builder,
) {
  final binding = props.writable(key);
  if (binding != null) return builder(binding.value, binding.set);
  final dataContext = node.context!.dataContext;
  final path = '${node.componentId}.value';
  return _FrockOwnValue(
    dataContext: dataContext,
    path: path,
    builder: (value) => builder(value, (next) => dataContext.set(path, next)),
  );
}

/// The value a control with no binding keeps under its own id, redrawn when
/// it moves.
class _FrockOwnValue extends StatefulWidget {
  final DataContext dataContext;
  final String path;
  final Widget Function(Object? value) builder;
  const _FrockOwnValue({
    required this.dataContext,
    required this.path,
    required this.builder,
  });

  @override
  State<_FrockOwnValue> createState() => _FrockOwnValueState();
}

class _FrockOwnValueState extends State<_FrockOwnValue> {
  DataSubscription<Object?>? subscription;

  void listen() {
    subscription = widget.dataContext.subscribeDynamicValue<Object?>(
      widget.dataContext.bindingFor(widget.path),
      (_) {
        if (mounted) setState(() {});
      },
    );
  }

  @override
  void initState() {
    super.initState();
    listen();
  }

  @override
  void didUpdateWidget(_FrockOwnValue old) {
    super.didUpdateWidget(old);
    if (old.dataContext != widget.dataContext || old.path != widget.path) {
      subscription?.unsubscribe();
      listen();
    }
  }

  @override
  void dispose() {
    subscription?.unsubscribe();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.builder(subscription?.value);
}

/// Raises a component's own `action`, in either spelling A2UI has had for it.
///
/// v0.9 nests the name under `event`, which is what the renderer this build
/// has speaks; 1.0 puts it at the top. The renderer takes both, because the
/// record is 1.0 and the renderer is v0.9 and neither the card nor the
/// component should have to know which one today is. Called in the gesture
/// handler itself, so the action's context is resolved at the moment of the
/// press.
void frockDispatchV1(ComponentProps props, String key) {
  final action = props.action(key);
  if (action != null) unawaited(action());
}
