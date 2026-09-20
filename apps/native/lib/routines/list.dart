/// The All Routines list: each Routine is a door, and its completions sit
/// under it as the same loose rows the Bot page draws.
///
/// A Settings-style switch row looks like tapping it would flip the switch.
/// That is the wrong promise here: the row opens the editor, and the switch
/// is only the switch. The chevron sits with the name; the switch is last.
library;

import 'package:flutter/material.dart';

import '../shell/semantics.dart';
import '../theme/rows.dart';
import '../view/action.dart';
import '../view/document.dart';
import '../view/nodes.dart';
import 'runs_row.dart';

/// Whether a titled group is a Routine the list draws: words about it, the
/// two controls a row owns, and the completions nested under it.
bool viewIsRoutineBlockV1(Map<String, Object?> node) {
  if (node['type'] != 'group' || node['title'] == null) return false;
  return _routineControls(node).isNotEmpty;
}

class ViewRoutineList extends StatelessWidget {
  final Map<String, Object?> node;
  const ViewRoutineList({super.key, required this.node});

  static List<Map<String, Object?>> _children(Map<String, Object?> node) =>
      node['type'] == 'group'
      ? (node['children'] as List)
            .map((each) => (each as Map).cast<String, Object?>())
            .toList()
      : const <Map<String, Object?>>[];

  @override
  Widget build(BuildContext context) {
    if (node['type'] != 'group') return ViewNodeView(node: node);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final child in _children(node)) ..._draw(context, child),
      ],
    );
  }

  List<Widget> _draw(BuildContext context, Map<String, Object?> child) {
    final nested = _children(child);
    if (child['type'] == 'group' &&
        child['title'] != null &&
        nested.isNotEmpty &&
        nested.every(viewIsRoutineBlockV1)) {
      return [
        FrockSectionLabel(child['title']! as String),
        for (final routine in nested) _RoutineBlock(node: routine),
      ];
    }
    if (child['type'] == 'group' &&
        child['title'] != null &&
        nested.isNotEmpty &&
        nested.every(_isCompletion)) {
      final now = DateTime.now();
      final title = child['title']! as String;
      return [
        FrockSectionLabel(title),
        for (final run in nested)
          identified(
            RoutineIds.completion(_runOf(run, title).entryId),
            RoutineRunRow(
              run: _runOf(run, title),
              now: now,
              onTap: () {
                final action = _openRun(run);
                final scope = ViewScope.of(context);
                final actionSchema = scope.actions[action?['actionId']];
                if (action == null || actionSchema == null) return;
                scope.controller.submit(
                  action,
                  actionSchema,
                  persist: false,
                );
              },
            ),
          ),
      ];
    }
    if (viewIsRoutineBlockV1(child)) return [_RoutineBlock(node: child)];
    return [
      Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: ViewNodeView(node: child),
      ),
    ];
  }
}

class _RoutineBlock extends StatelessWidget {
  final Map<String, Object?> node;
  const _RoutineBlock({required this.node});

  @override
  Widget build(BuildContext context) {
    final title = node['title']! as String;
    final children = (node['children'] as List)
        .map((child) => (child as Map).cast<String, Object?>())
        .toList();
    final said = [
      for (final child in children)
        if (child['type'] == 'text' && (child['text'] as String?) != null)
          child['text']! as String,
    ];
    final controls = _routineControls(node);
    final toggle = controls
        .where((action) => action['actionId'] == 'set-routine-enabled')
        .firstOrNull;
    final open = controls
        .where((action) => action['actionId'] == 'edit-routine')
        .firstOrNull;
    final runs = [
      for (final child in children)
        if (_isCompletion(child)) child,
    ];
    final scope = ViewScope.of(context);
    final schema = scope.actions[toggle?['actionId']];
    final on =
        toggle != null && (toggle['input'] as Map?)?['enabled'] == false;
    final key = toggle == null
        ? null
        : viewPredictionKeyV1(toggle, without: 'enabled');
    final drawn = key == null ? null : scope.controller.predicted[key] as bool?;
    final locked =
        schema == null ||
        drawn != null ||
        scope.controller.busy ||
        scope.controller.pending != null;
    void flip() => scope.controller.submit(
      toggle!,
      schema!,
      predictKey: key,
      predictValue: (toggle['input'] as Map?)?['enabled'] == true,
    );
    final openSchema = scope.actions[open?['actionId']];
    final now = DateTime.now();
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          identified(
            viewGroupIdentifierV1(title),
            FrockRow(
              title: title,
              subtitle: said.isEmpty ? null : said.join(' · '),
              // Chevron sits with the name, not after the switch: the row is
              // a door, and the switch is its own control at the end.
              chevron: false,
              onTap: open != null && openSchema != null
                  ? () => scope.controller.submit(
                      open,
                      openSchema,
                      persist: false,
                    )
                  : null,
              trailing: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    Icons.chevron_right_rounded,
                    size: 18,
                    color: Theme.of(
                      context,
                    ).colorScheme.onSurfaceVariant.withValues(alpha: 0.55),
                  ),
                  if (toggle != null) ...[
                    const SizedBox(width: 8),
                    identified(
                      viewActionIdentifierV1(toggle['actionId'] as String),
                      Semantics(
                        label: toggle['label'] as String? ?? title,
                        child: Switch(
                          value: drawn ?? on,
                          onChanged: locked ? null : (_) => flip(),
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
          for (final run in runs)
            identified(
              RoutineIds.completion(_runOf(run, title).entryId),
              RoutineRunRow(
                run: _runOf(run, title),
                now: now,
                onTap: () {
                  final action = _openRun(run);
                  final actionSchema = scope.actions[action?['actionId']];
                  if (action == null || actionSchema == null) return;
                  scope.controller.submit(
                    action,
                    actionSchema,
                    persist: false,
                  );
                },
              ),
            ),
        ],
      ),
    );
  }
}

List<Map<String, Object?>> _routineControls(Map<String, Object?> node) {
  final found = <Map<String, Object?>>[];
  for (final raw in (node['children'] as List? ?? const [])) {
    final child = (raw as Map).cast<String, Object?>();
    if (child['type'] != 'group' || child['title'] != null) continue;
    for (final inner in (child['children'] as List? ?? const [])) {
      final action = (inner as Map).cast<String, Object?>();
      if (action['type'] == 'action' &&
          (action['actionId'] == 'edit-routine' ||
              action['actionId'] == 'set-routine-enabled')) {
        found.add(action);
      }
    }
  }
  return found;
}

bool _isCompletion(Map<String, Object?> node) => _openRun(node) != null;

Map<String, Object?>? _openRun(Map<String, Object?> node) {
  Map<String, Object?>? found;
  void walk(Object? value) {
    if (found != null || value is! Map) return;
    final child = value.cast<String, Object?>();
    if (child['type'] == 'action' && child['actionId'] == 'open-run') {
      found = child;
      return;
    }
    for (final nested in (child['children'] as List? ?? const [])) {
      walk(nested);
    }
  }

  walk(node);
  return found;
}

RoutineRunSummary _runOf(Map<String, Object?> node, String fallbackName) {
  final action = _openRun(node);
  final input = ((action?['input'] as Map?) ?? const {}).cast<String, Object?>();
  final stamp = [
    for (final raw in (node['children'] as List? ?? const []))
      if ((raw as Map)['type'] == 'text' && raw['style'] == 'status')
        raw['text'] as String?,
  ].firstOrNull;
  final markText = [
    for (final raw in (node['children'] as List? ?? const []))
      if ((raw as Map)['type'] == 'text' && raw['style'] != 'status')
        raw['text'] as String?,
  ].firstOrNull;
  return RoutineRunSummary(
    entryId: input['entryId'] as String? ?? '',
    routineId: input['routineId'] as String? ?? '',
    name: (node['title'] as String?) ?? fallbackName,
    at: DateTime.tryParse(stamp ?? '')?.toLocal() ?? DateTime.now(),
    mark: markText == 'failed'
        ? RoutineRunMarkV1.failed
        : markText == 'running'
        ? RoutineRunMarkV1.running
        : RoutineRunMarkV1.finished,
  );
}
