import 'dart:convert';

import 'package:flutter/material.dart';

import '../protocol/client_wire.generated.dart' as wire;
import 'action.dart';
import 'budgets.dart';
import 'embed.dart';
import 'nodes.dart';

/// What every node reaches: the field values, the declared actions and the
/// host's own frames. Nothing a plugin wrote is in here.
class ViewScope extends InheritedWidget {
  final ViewController controller;
  final Map<String, Map<String, Object?>> actions;
  final Map<String, ViewFrameBuilder> frames;

  /// The host's own editors, keyed by the `choiceSource` a field names. A
  /// field whose choices are a paged catalog rather than a fixed list is drawn
  /// by the surface that owns the catalog, never by the plugin.
  final Map<String, ViewFieldBuilder> fields;
  const ViewScope({
    super.key,
    required this.controller,
    required this.actions,
    required this.frames,
    this.fields = const {},
    required super.child,
  });

  static ViewScope of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<ViewScope>()!;

  @override
  bool updateShouldNotify(ViewScope old) =>
      controller != old.controller ||
      actions != old.actions ||
      frames != old.frames ||
      fields != old.fields;
}

/// A plugin-described view, rendered by the host.
///
/// The budgets are checked before the first widget is built, so an oversized
/// or too-deep document costs a walk rather than a frame, and the person sees
/// the host's own unavailable region rather than half a view.
class ViewDocumentView extends StatefulWidget {
  final wire.ViewDocument document;
  final ViewController controller;
  final Map<String, ViewFrameBuilder> frames;
  final Map<String, ViewFieldBuilder> fields;
  final bool cardGroups;

  /// Whether the root's titled groups are drawn as a grid of cards.
  final bool gridGroups;
  ViewDocumentView({
    super.key,
    required this.document,
    required this.controller,
    this.fields = const {},
    this.cardGroups = false,
    this.gridGroups = false,
    Map<String, ViewFrameBuilder>? frames,
  }) : frames = frames ?? hostViewFramesV1;

  @override
  State<ViewDocumentView> createState() => _ViewDocumentViewState();
}

class _ViewDocumentViewState extends State<ViewDocumentView> {
  late Map<String, Object?> json;
  late Map<String, Map<String, Object?>> actions;
  String? refusal;

  @override
  void initState() {
    super.initState();
    admit();
  }

  @override
  void didUpdateWidget(ViewDocumentView old) {
    super.didUpdateWidget(old);
    if (jsonEncode(old.document.toJson()) !=
        jsonEncode(widget.document.toJson())) {
      admit();
    }
  }

  void admit() {
    json = (widget.document.toJson()! as Map).cast<String, Object?>();
    actions = {};
    refusal = null;
    try {
      checkViewBudgetsV1(json);
      for (final action
          in (json['actions']! as List).cast<Map<String, Object?>>()) {
        if (actions.containsKey(action['id'])) {
          throw const ViewBudgetFailure(
            'This view declares the same action twice.',
          );
        }
        actions[action['id']! as String] = (action['schema']! as Map)
            .cast<String, Object?>();
      }
    } on ViewBudgetFailure catch (failure) {
      refusal = failure.message;
    }
  }

  @override
  Widget build(BuildContext context) {
    if (refusal != null) {
      return ViewRegion(
        label: 'This view can’t be shown',
        detail: refusal!,
        icon: Icons.block_outlined,
        aspectRatio: 2,
      );
    }
    return AnimatedBuilder(
      animation: widget.controller,
      builder: (context, _) => ViewScope(
        controller: widget.controller,
        actions: actions,
        frames: widget.frames,
        fields: widget.fields,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            if (widget.cardGroups)
              ViewCardGroups(
                node: (json['root']! as Map).cast<String, Object?>(),
              )
            else if (widget.gridGroups)
              ViewGridGroups(
                node: (json['root']! as Map).cast<String, Object?>(),
              )
            else
              ViewNodeView(
                node: (json['root']! as Map).cast<String, Object?>(),
              ),
            if (widget.controller.message case final String message)
              Padding(
                padding: const EdgeInsets.only(top: 16),
                child: Semantics(liveRegion: true, child: Text(message)),
              ),
            if (widget.controller.pending != null)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: FilledButton.tonal(
                  onPressed: widget.controller.busy
                      ? null
                      : widget.controller.check,
                  child: Text(
                    widget.controller.busy ? 'Checking…' : 'Check that action',
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
