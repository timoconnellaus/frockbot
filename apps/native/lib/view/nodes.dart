import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import '../protocol/client_wire.generated.dart' as wire;
import '../shell/semantics.dart';
import '../theme/caret.dart';
import 'action.dart';
import '../theme/rows.dart';
import 'document.dart';
import 'embed.dart';

/// One widget per node type. The union is closed by the schema, so there is no
/// unknown-node branch to write: a document that named a seventh type never
/// decoded.
class ViewNodeView extends StatelessWidget {
  final Map<String, Object?> node;
  const ViewNodeView({super.key, required this.node});

  @override
  Widget build(BuildContext context) => switch (node['type']) {
    'text' => ViewTextNode(node: node),
    'group' => ViewGroupNode(node: node),
    'field' => ViewFieldNode(node: node),
    'action' => ViewActionNode(node: node),
    'list' => ViewListNode(node: node),
    _ => ViewEmbedNode(node: node),
  };
}

/// The host can present top-level groups as cards without changing the
/// document, its action targets, or the shared renderer inside each card.
class ViewCardGroups extends StatelessWidget {
  final Map<String, Object?> node;
  const ViewCardGroups({super.key, required this.node});

  @override
  Widget build(BuildContext context) {
    if (node['type'] != 'group') return ViewNodeView(node: node);
    final sections = <Widget>[];
    var cards = <Map<String, Object?>>[];
    void flush() {
      if (cards.isEmpty) return;
      final batch = cards;
      cards = [];
      sections.add(
        LayoutBuilder(
          builder: (context, constraints) {
            final columns =
                constraints.maxWidth >= 600 &&
                    MediaQuery.textScalerOf(context).scale(14) <= 21
                ? 2
                : 1;
            return _EqualHeightCards(
              columns: columns,
              children: [
                for (final card in batch)
                  Card(
                    key: ValueKey(card['title']),
                    margin: EdgeInsets.zero,
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(16, 12, 16, 14),
                      child: _CapabilityCard(node: card),
                    ),
                  ),
              ],
            );
          },
        ),
      );
    }

    for (final raw in (node['children'] as List)) {
      final child = (raw as Map).cast<String, Object?>();
      if (child['type'] == 'group' && child['title'] != null) {
        cards.add(child);
      } else {
        flush();
        sections.add(
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: ViewNodeView(node: child),
          ),
        );
      }
    }
    flush();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: sections,
    );
  }
}

/// The host can present top-level titled groups as a grid of cards: each card
/// is the group drawn by the shared renderer, title and all, so the document,
/// its identifiers and its action targets are the ones the list draws.
///
/// This is the Marketplace on a desktop. The columns follow the width, and
/// each card keeps its natural height so opening one card cannot clip its
/// controls or stretch every other card around it.
class ViewGridGroups extends StatelessWidget {
  final Map<String, Object?> node;
  const ViewGridGroups({super.key, required this.node});

  @override
  Widget build(BuildContext context) {
    if (node['type'] != 'group') return ViewNodeView(node: node);
    final sections = <Widget>[];
    var cards = <Map<String, Object?>>[];
    void flush() {
      if (cards.isEmpty) return;
      final batch = cards;
      cards = [];
      sections.add(
        LayoutBuilder(
          builder: (context, constraints) {
            final large = MediaQuery.textScalerOf(context).scale(14) > 21;
            final columns = large || constraints.maxWidth < 560
                ? 1
                : constraints.maxWidth < 860
                ? 2
                : 3;
            const gap = 12.0;
            final width =
                (constraints.maxWidth - gap * (columns - 1)) / columns;
            return Wrap(
              spacing: gap,
              runSpacing: gap,
              children: [
                for (final card in batch)
                  SizedBox(
                    width: width,
                    child: Card(
                      key: ValueKey(card['title']),
                      margin: EdgeInsets.zero,
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(16, 6, 16, 12),
                        child: ViewNodeView(node: card),
                      ),
                    ),
                  ),
              ],
            );
          },
        ),
      );
    }

    for (final raw in (node['children'] as List)) {
      final child = (raw as Map).cast<String, Object?>();
      if (child['type'] == 'group' && child['title'] != null) {
        cards.add(child);
      } else {
        flush();
        sections.add(
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: ViewNodeView(node: child),
          ),
        );
      }
    }
    flush();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: sections,
    );
  }
}

/// Titled groups as rows on one card, in the grammar the rest of the app uses.
///
/// The card-per-thing layout gave every Plugin a 118-point card to say a name,
/// one line and a switch; five of them filled a panel with three sentences,
/// and the Routines beside them were bare text. This draws the same documents
/// — the same titles, the same action targets, the same identifiers — as rows,
/// and decides what each top-level group is from what it holds:
///
/// * children that are all titled groups → a section: its title as the label,
///   its children under it. Each of those is a row where it is one — words and
///   the controls a row draws — and a card of its own where it is not, so a
///   Plugin that draws a settings form still gets the room for it.
/// * anything else → a card of its own, drawn by the shared renderer. That is
///   a form: a form is not a row and is not pretending to be.
class ViewSwitchRows extends StatelessWidget {
  final Map<String, Object?> node;
  const ViewSwitchRows({super.key, required this.node});

  static List<Map<String, Object?>> _children(Map<String, Object?> node) =>
      node['type'] == 'group'
      ? (node['children'] as List)
            .map((each) => (each as Map).cast<String, Object?>())
            .toList()
      : const <Map<String, Object?>>[];

  static Widget _card(Map<String, Object?> child) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: child['type'] == 'group' && child['title'] != null
        ? Card(
            margin: EdgeInsets.zero,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 6, 16, 12),
              child: ViewNodeView(node: child),
            ),
          )
        : ViewNodeView(node: child),
  );

  /// What a section holds: runs of rows on one card, and anything too big to
  /// be a row on a card of its own, in the order the document wrote them.
  static List<Widget> _section(List<Map<String, Object?>> children) {
    final drawn = <Widget>[];
    var rows = <Map<String, Object?>>[];
    void flush() {
      if (rows.isEmpty) return;
      final batch = rows;
      rows = [];
      drawn.add(
        Padding(
          padding: const EdgeInsets.only(bottom: 4),
          child: FrockRowGroup(
            indent: 14,
            rows: [for (final row in batch) _ViewSwitchRow(node: row)],
          ),
        ),
      );
    }

    for (final child in children) {
      if (viewIsRowV1(_children(child))) {
        rows.add(child);
        continue;
      }
      flush();
      drawn.add(_card(child));
    }
    flush();
    return drawn;
  }

  @override
  Widget build(BuildContext context) {
    if (node['type'] != 'group') return ViewNodeView(node: node);
    final sections = <Widget>[];
    for (final raw in (node['children'] as List)) {
      final child = (raw as Map).cast<String, Object?>();
      final children = _children(child);
      if (child['type'] == 'group' &&
          child['title'] != null &&
          children.isNotEmpty &&
          children.every(
            (each) => each['type'] == 'group' && each['title'] != null,
          )) {
        final title = child['title']! as String;
        sections.add(FrockSectionLabel(title));
        sections.add(
          identified(
            viewGroupIdentifierV1(title),
            Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: _section(children),
            ),
          ),
        );
        continue;
      }
      sections.add(_card(child));
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: sections,
    );
  }
}

/// The actions a row draws itself: the switch at its end, and the press its
/// whole width is. Every other action a group declares is body content.
const _rowToggleIds = {
  'set-package-enabled',
  'install-package',
  'set-routine-enabled',
};
const _rowOpenIds = {'edit-routine', 'open-home', 'open-run'};

/// Presses the host answers itself. They are not retained: a command
/// envelope written for one of them would be restored onto the document
/// the press just opened, and every control on it would refuse to work.
const _hostAnsweredIds = {
  'edit-routine',
  'cancel-edit',
  'open-run',
  'open-runs',
  'open-home',
};

/// The declared actions of [children] that a row draws as its own controls.
List<Map<String, Object?>> _rowActions(List<Map<String, Object?>> children) => [
  for (final child in children)
    if (child['type'] == 'group')
      for (final raw in (child['children'] as List))
        if ((raw as Map)['type'] == 'action' &&
            (_rowToggleIds.contains(raw['actionId']) ||
                _rowOpenIds.contains(raw['actionId'])))
          raw.cast<String, Object?>(),
];

/// Whether a titled group is a row: words about it, and the controls a row
/// draws for itself. A group holding a field, an embed or a list is a form or
/// a log, and a row is not the shape for either — it becomes a card instead.
bool viewIsRowV1(List<Map<String, Object?>> children) =>
    children.isNotEmpty &&
    children.every(
      (child) => child['type'] == 'text' || _viewIsRowControlsV1(child),
    );

bool _viewIsRowControlsV1(Map<String, Object?> child) {
  if (child['type'] != 'group' || child['title'] != null) return false;
  final children = child['children'] as List;
  return children.isNotEmpty &&
      children.every(
        (raw) =>
            (raw as Map)['type'] == 'action' &&
            (_rowToggleIds.contains(raw['actionId']) ||
                _rowOpenIds.contains(raw['actionId'])),
      );
}

class _ViewSwitchRow extends StatelessWidget {
  final Map<String, Object?> node;
  const _ViewSwitchRow({required this.node});

  @override
  Widget build(BuildContext context) {
    final title = node['title']! as String;
    final children = (node['children'] as List)
        .map((child) => (child as Map).cast<String, Object?>())
        .toList();
    final controls = _rowActions(children);
    final toggle = controls
        .where((action) => _rowToggleIds.contains(action['actionId']))
        .firstOrNull;
    final open = controls
        .where((action) => _rowOpenIds.contains(action['actionId']))
        .firstOrNull;
    // Everything the projection wrote about this row that is plain words: its
    // description first, then whatever it had to add about reach or state.
    final said = [
      for (final child in children)
        if (child['type'] == 'text' && (child['text'] as String?) != null)
          child['text']! as String,
    ];
    final scope = ViewScope.of(context);
    final schema = scope.actions[toggle?['actionId']];
    final on =
        toggle != null &&
        toggle['actionId'] != 'install-package' &&
        (toggle['input'] as Map?)?['enabled'] == false;
    final key = toggle != null && toggle['actionId'] != 'install-package'
        ? viewPredictionKeyV1(toggle, without: 'enabled')
        : null;
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
    final row = identified(
      viewGroupIdentifierV1(title),
      FrockRow(
        title: title,
        subtitle: said.isEmpty ? null : said.join(' · '),
        chevron: open != null || toggle == null,
        onTap: open != null && openSchema != null
            ? () => scope.controller.submit(open, openSchema, persist: false)
            : toggle == null || locked
            ? null
            : flip,
        trailing: toggle == null
            ? null
            : identified(
                viewActionIdentifierV1(toggle['actionId'] as String),
                Semantics(
                  label: title,
                  child: Switch(
                    value: drawn ?? on,
                    // A standing prediction means the node's own input is a
                    // revision behind: pressing again would send the command
                    // that has already been sent.
                    onChanged: locked ? null : (_) => flip(),
                  ),
                ),
              ),
      ),
    );
    return row;
  }
}

/// The actions a capability card draws itself — a switch beside the title and
/// a settings press at the foot — rather than as body content.
const _cardControlIds = {
  'set-package-enabled',
  'install-package',
  'uninstall-package',
  'open-home',
};

/// Whether a card child is the group holding the card's own controls. Any
/// other group child (a Plugin's settings section, say) is body content and is
/// drawn in place.
bool _isCardControls(Map<String, Object?> child) {
  if (child['type'] != 'group') return false;
  return (child['children'] as List).every(
    (raw) =>
        (raw as Map)['type'] == 'action' &&
        _cardControlIds.contains(raw['actionId']),
  );
}

class _CapabilityCard extends StatelessWidget {
  final Map<String, Object?> node;
  const _CapabilityCard({required this.node});

  @override
  Widget build(BuildContext context) {
    final children = (node['children'] as List)
        .map((child) => (child as Map).cast<String, Object?>())
        .toList();
    final actions = children
        .where(_isCardControls)
        .expand(
          (group) => (group['children'] as List).map(
            (action) => (action as Map).cast<String, Object?>(),
          ),
        );
    final toggle = actions
        .where(
          (action) =>
              action['actionId'] == 'set-package-enabled' ||
              action['actionId'] == 'install-package',
        )
        .firstOrNull;
    final settings = actions
        .where((action) => action['actionId'] == 'open-home')
        .firstOrNull;
    final remove = actions
        .where((action) => action['actionId'] == 'uninstall-package')
        .firstOrNull;
    final scope = ViewScope.of(context);
    final schema = scope.actions[toggle?['actionId']];
    final enabled =
        toggle?['actionId'] == 'set-package-enabled' &&
        (toggle?['input'] as Map?)?['enabled'] == false;
    // Enabling is the client's own answer — the switch it just flipped — so it
    // is drawn at once. Installing is not: the authority resolves a version
    // and mounts a Composition generation, and only it knows whether that
    // worked, so that switch waits for the document.
    final key = toggle != null && toggle['actionId'] == 'set-package-enabled'
        ? viewPredictionKeyV1(toggle, without: 'enabled')
        : null;
    final drawn = key == null ? null : scope.controller.predicted[key] as bool?;
    return identified(
      viewGroupIdentifierV1(node['title'] as String),
      Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text(
                        node['title'] as String,
                        style: Theme.of(context).textTheme.titleSmall?.copyWith(
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  if (toggle != null)
                    identified(
                      viewActionIdentifierV1(toggle['actionId'] as String),
                      Semantics(
                        label: node['title'] as String,
                        child: Switch(
                          value: drawn ?? enabled,
                          // A standing prediction means the node's own input
                          // is a revision behind: pressing again would send
                          // the command that has already been sent.
                          onChanged:
                              schema == null ||
                                  drawn != null ||
                                  scope.controller.busy ||
                                  scope.controller.pending != null
                              ? null
                              : (_) => scope.controller.submit(
                                  toggle,
                                  schema,
                                  predictKey: key,
                                  predictValue:
                                      (toggle['input'] as Map?)?['enabled'] ==
                                      true,
                                ),
                        ),
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 6),
              for (final child in children.where(
                (child) => !_isCardControls(child),
              ))
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: ViewNodeView(node: child),
                ),
            ],
          ),
          if (settings != null) ...[
            const SizedBox(height: 8),
            ViewActionNode(node: settings),
          ],
          if (remove != null) ...[
            const SizedBox(height: 8),
            ViewActionNode(node: remove),
          ],
        ],
      ),
    );
  }
}

/// Measure the tallest card at its actual width, including scaled text, so
/// every row shares a height without clipping longer descriptions.
class _EqualHeightCards extends MultiChildRenderObjectWidget {
  final int columns;

  const _EqualHeightCards({required this.columns, required super.children});

  @override
  RenderObject createRenderObject(BuildContext context) => _CardGrid(columns);

  @override
  void updateRenderObject(
    BuildContext context,
    covariant _CardGrid renderObject,
  ) {
    if (renderObject.columns != columns) {
      renderObject.columns = columns;
      renderObject.markNeedsLayout();
    }
  }
}

class _CardParentData extends ContainerBoxParentData<RenderBox> {}

class _CardGrid extends RenderBox
    with
        ContainerRenderObjectMixin<
          RenderBox,
          ContainerBoxParentData<RenderBox>
        >,
        RenderBoxContainerDefaultsMixin<
          RenderBox,
          ContainerBoxParentData<RenderBox>
        > {
  int columns;
  _CardGrid(this.columns);

  @override
  void setupParentData(RenderBox child) {
    child.parentData = _CardParentData();
  }

  @override
  void performLayout() {
    final width = (constraints.maxWidth - 12 * (columns - 1)) / columns;
    final rows = (childCount / columns).ceil();
    // Measure first so every card shares the height of the tallest card.
    final heights = List<double>.filled(rows, 0);
    var tallest = 0.0;
    var index = 0;
    var child = firstChild;
    while (child != null) {
      child.layout(BoxConstraints.tightFor(width: width), parentUsesSize: true);
      final row = index ~/ columns;
      if (child.size.height > heights[row]) heights[row] = child.size.height;
      if (child.size.height > tallest) tallest = child.size.height;
      index++;
      child = childAfter(child);
    }
    heights.fillRange(0, rows, tallest);
    var top = 0.0;
    index = 0;
    child = firstChild;
    while (child != null) {
      final row = index ~/ columns;
      if (index > 0 && index % columns == 0) top += heights[row - 1] + 12;
      child.layout(BoxConstraints.tightFor(width: width, height: heights[row]));
      (child.parentData as ContainerBoxParentData<RenderBox>).offset = Offset(
        (index % columns) * (width + 12),
        top,
      );
      index++;
      child = childAfter(child);
    }
    final total = heights.fold(0.0, (sum, height) => sum + height);
    size = constraints.constrain(
      Size(constraints.maxWidth, rows == 0 ? 0 : total + 12 * (rows - 1)),
    );
  }

  @override
  void paint(PaintingContext context, Offset offset) =>
      defaultPaint(context, offset);

  @override
  bool hitTestChildren(BoxHitTestResult result, {required Offset position}) =>
      defaultHitTestChildren(result, position: position);
}

class ViewTextNode extends StatelessWidget {
  final Map<String, Object?> node;
  const ViewTextNode({super.key, required this.node});

  @override
  Widget build(BuildContext context) {
    final text = node['text']! as String;
    final type = Theme.of(context).textTheme;
    final scheme = Theme.of(context).colorScheme;
    return switch (node['style']) {
      'heading' => Semantics(
        header: true,
        child: Text(text, style: type.titleMedium),
      ),
      'label' => Text(
        text,
        style: type.labelMedium?.copyWith(color: scheme.onSurfaceVariant),
      ),
      'status' => Semantics(
        liveRegion: true,
        child: Text(
          text,
          style: type.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
        ),
      ),
      _ => Text(
        text,
        style: type.bodyMedium?.copyWith(color: scheme.onSurfaceVariant),
      ),
    };
  }
}

/// The actions that take the group they sit in with them.
///
/// A delete is the only shape a client can honestly draw: the record is gone,
/// so the card that drew it is gone. A revoke is not one — the authority keeps
/// the record and replaces its contents with a notice saying so, and inventing
/// that notice here would be inventing what the authority said.
///
/// Uninstalling a provider Plugin is the same optimistic shape: its current
/// card disappears while the authoritative reread decides whether the surface
/// omits it or redraws it as an installable Marketplace offer.
const _removesGroupIds = {'delete-routine', 'uninstall-package'};

/// Whether pressing this action removes the group around it.
bool viewRemovesGroupV1(Map<String, Object?> node) =>
    _removesGroupIds.contains(node['actionId']);

/// Whether a prediction has already taken this node off the document: a group
/// holding a delete this client has sent is a record on its way out, so it
/// goes now rather than when the read lands.
bool viewNodeGoneV1(Map<String, Object?> node, Map<String, Object?> predicted) {
  if (predicted.isEmpty || node['type'] != 'group') return false;
  bool holdsDelete(Map<String, Object?> node) {
    if (viewRemovesGroupV1(node) &&
        predicted[viewPredictionKeyV1(node)] == true) {
      return true;
    }
    return (node['children'] as List? ?? const []).any(
      (child) => holdsDelete((child as Map).cast<String, Object?>()),
    );
  }

  return holdsDelete(node);
}

/// A seed field the host draws as nothing: its value still loads into the
/// controller, but it has no surface of its own.
bool _viewFieldIsHiddenSeedV1(Map<String, Object?> node) {
  if (node['type'] != 'field') return false;
  final field = node['field'];
  return field is Map && field['choiceSource'] == 'routine-editor-hidden';
}

class ViewGroupNode extends StatefulWidget {
  final Map<String, Object?> node;
  const ViewGroupNode({super.key, required this.node});

  @override
  State<ViewGroupNode> createState() => _ViewGroupNodeState();
}

class _ViewGroupNodeState extends State<ViewGroupNode> {
  late bool open = widget.node['collapsed'] != true;

  @override
  Widget build(BuildContext context) {
    final title = widget.node['title'] as String?;
    final predicted = ViewScope.of(context).controller.predicted;
    final children = <Widget>[];
    var firstVisible = true;
    for (final raw in (widget.node['children']! as List).cast<Map>()) {
      final child = raw.cast<String, Object?>();
      if (viewNodeGoneV1(child, predicted)) continue;
      // Hidden seeds stay in the tree so their values load, but they must
      // not push the form they seed away from the top.
      final hidden = _viewFieldIsHiddenSeedV1(child);
      children.add(
        Padding(
          padding: hidden
              ? EdgeInsets.zero
              : EdgeInsets.only(top: firstVisible ? 0 : 5, bottom: 5),
          child: ViewNodeView(node: child),
        ),
      );
      if (!hidden) firstVisible = false;
    }
    final body = widget.node['orientation'] == 'row'
        ? Wrap(spacing: 12, runSpacing: 8, children: children)
        : Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: children,
          );
    if (title == null) return body;
    return identified(
      viewGroupIdentifierV1(title),
      Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          InkWell(
            onTap: widget.node.containsKey('collapsed')
                ? () => setState(() => open = !open)
                : null,
            borderRadius: BorderRadius.circular(8),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Row(
                children: [
                  Expanded(
                    child: Semantics(
                      header: true,
                      child: Text(
                        title,
                        style: Theme.of(context).textTheme.titleSmall?.copyWith(
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ),
                  if (widget.node.containsKey('collapsed'))
                    Icon(
                      open
                          ? Icons.expand_less_rounded
                          : Icons.expand_more_rounded,
                      size: 20,
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
                ],
              ),
            ),
          ),
          if (open) body,
        ],
      ),
    );
  }
}

class ViewFieldNode extends StatelessWidget {
  final Map<String, Object?> node;
  const ViewFieldNode({super.key, required this.node});

  @override
  Widget build(BuildContext context) {
    final field = wire.SettingField.fromJson(node['field']);
    final scope = ViewScope.of(context);
    final id = field.id.value;
    if (field.kind == 'secret') scope.controller.secrets.add(id);
    // The plugin's value is the seed; after that the person owns it.
    final value = scope.controller.values.putIfAbsent(
      id,
      () => field.value.value,
    );
    final enabled = field.editable && !scope.controller.busy;
    final host = field.choiceSource == null
        ? null
        : scope.fields[field.choiceSource];
    if (host != null) {
      return host(
        context,
        field,
        id,
        value,
        enabled ? (next) => scope.controller.change(id, next) : null,
      );
    }
    return identified(
      viewFieldIdentifierV1(id),
      _input(context, field, id, value, enabled, scope),
    );
  }

  Widget _input(
    BuildContext context,
    wire.SettingField field,
    String id,
    Object? value,
    bool enabled,
    ViewScope scope,
  ) {
    final decoration = InputDecoration(
      labelText: field.label,
      helperText: field.hint,
      helperMaxLines: 4,
      counterText: '',
    );
    if (field.kind == 'boolean') {
      return SwitchListTile(
        contentPadding: EdgeInsets.zero,
        visualDensity: VisualDensity.compact,
        title: Text(field.label),
        subtitle: field.hint == null ? null : Text(field.hint!),
        value: value == true,
        onChanged: enabled ? (next) => scope.controller.change(id, next) : null,
      );
    }
    if (field.kind == 'select') {
      // Choices are keyed by their encoded value, which both de-duplicates two
      // choices that mean the same thing and answers the only question the
      // dropdown asks: is the current value one of them? A setting that has
      // never been set is not, and the field shows it as unset rather than
      // refusing to build.
      final choices = <String, String>{
        for (final choice in field.choices ?? const <wire.SettingChoice>[])
          jsonEncode(choice.value.value): choice.label,
      };
      final current = jsonEncode(value);
      return DropdownButtonFormField<String>(
        initialValue: choices.containsKey(current) ? current : null,
        decoration: decoration,
        isExpanded: true,
        hint: const Text('Not set'),
        items: [
          for (final choice in choices.entries)
            DropdownMenuItem(
              value: choice.key,
              child: Text(
                choice.value,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
            ),
        ],
        onChanged: enabled
            ? (next) {
                if (next != null) {
                  scope.controller.change(id, jsonDecode(next));
                }
              }
            : null,
      );
    }
    // A secret is never seeded and never read back: the document carries no
    // value for it, the widget starts empty however often it rebuilds, and the
    // only place the typed characters go is the action input that carries them
    // to the credential route.
    if (field.kind == 'secret') {
      return SteadyCaret(
        child: TextFormField(
          enabled: enabled,
          obscureText: true,
          autocorrect: false,
          enableSuggestions: false,
          decoration: decoration,
          onChanged: (next) =>
              scope.controller.change(id, next.isEmpty ? null : next),
        ),
      );
    }
    final number = field.kind == 'number';
    return SteadyCaret(
      child: TextFormField(
        initialValue: value?.toString() ?? '',
        enabled: enabled,
        decoration: decoration,
        maxLength: field.maxLength,
        keyboardType: number
            ? const TextInputType.numberWithOptions(decimal: true, signed: true)
            : TextInputType.text,
        onChanged: (next) => scope.controller.change(
          id,
          number ? (next.isEmpty ? null : num.tryParse(next)) : next,
        ),
      ),
    );
  }
}

class ViewActionNode extends StatelessWidget {
  final Map<String, Object?> node;
  const ViewActionNode({super.key, required this.node});

  @override
  Widget build(BuildContext context) {
    final scope = ViewScope.of(context);
    final schema = scope.actions[node['actionId']];
    final label = node['label']! as String;
    // An action naming no declared schema is not dispatchable, and the host
    // says so rather than sending something the plugin never described.
    final press =
        schema == null ||
            scope.controller.busy ||
            scope.controller.pending != null
        ? null
        : () => scope.controller.submit(
            node,
            schema,
            persist: !_hostAnsweredIds.contains(node['actionId']),
            predictKey: viewRemovesGroupV1(node)
                ? viewPredictionKeyV1(node)
                : null,
            predictValue: true,
          );
    return identified(
      viewActionIdentifierV1(node['actionId']! as String),
      Align(
        alignment: Alignment.centerLeft,
        // Sized to the button under loose constraints, which is what a `row`
        // group gives it: without this the `Wrap` hands each control the full
        // width and four side-by-side controls become four stacked ones. A
        // `column` group constrains its children tightly, so there the factor
        // changes nothing and the button still sits left.
        widthFactor: 1,
        child: switch (node['style']) {
          'primary' => FilledButton(
            onPressed: press,
            style: FilledButton.styleFrom(
              minimumSize: const Size(0, 34),
              padding: const EdgeInsets.symmetric(horizontal: 14),
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              textStyle: Theme.of(context).textTheme.labelMedium
                  ?.copyWith(fontWeight: FontWeight.w600),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(9),
              ),
            ),
            child: Text(label),
          ),
          'danger' => OutlinedButton(
            onPressed: press,
            style: frockCompactButton(context).copyWith(
              foregroundColor: WidgetStatePropertyAll(
                Theme.of(context).colorScheme.error,
              ),
            ),
            child: Text(label),
          ),
          _ => OutlinedButton(
            onPressed: press,
            style: frockCompactButton(context),
            child: Text(label),
          ),
        },
      ),
    );
  }
}

class ViewListNode extends StatelessWidget {
  final Map<String, Object?> node;
  const ViewListNode({super.key, required this.node});

  @override
  Widget build(BuildContext context) {
    final scope = ViewScope.of(context);
    final rows = (node['rows']! as List).cast<Map<String, Object?>>();
    if (rows.isEmpty) {
      return Text(
        node['empty'] as String? ?? 'Nothing here yet.',
        style: Theme.of(context).textTheme.bodySmall,
      );
    }
    // A choice is one row's: the tapped row is drawn chosen and its siblings
    // are drawn cleared, which is the whole of what a tap on a list means and
    // what the read that follows will say.
    final chosen = rows
        .map((row) => viewPredictionKeyV1({'actionId': row['actionId']}))
        .where((key) => scope.controller.predicted[key] == true)
        .firstOrNull;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final row in rows)
          Builder(
            builder: (context) {
              final schema = scope.actions[row['actionId']];
              final key = viewPredictionKeyV1({'actionId': row['actionId']});
              final selected = chosen == null
                  ? row['selected'] == true
                  : chosen == key;
              return ListTile(
                key: ValueKey('view-row-${row['id']}'),
                selected: selected,
                dense: true,
                contentPadding: const EdgeInsets.symmetric(horizontal: 12),
                title: ViewNodeView(
                  node: (row['node']! as Map).cast<String, Object?>(),
                ),
                trailing: selected
                    ? Icon(
                        Icons.check_rounded,
                        size: 18,
                        color: Theme.of(context).colorScheme.primary,
                      )
                    : null,
                onTap:
                    schema == null ||
                        chosen != null ||
                        scope.controller.busy ||
                        scope.controller.pending != null
                    ? null
                    : () => scope.controller.submit(
                        {'actionId': row['actionId']},
                        schema,
                        predictKey: key,
                        predictValue: true,
                      ),
              );
            },
          ),
      ],
    );
  }
}

class ViewEmbedNode extends StatelessWidget {
  final Map<String, Object?> node;
  const ViewEmbedNode({super.key, required this.node});

  @override
  Widget build(BuildContext context) {
    final label = node['label']! as String;
    final source = node['source']! as String;
    final ratio = (node['aspectRatio'] as num?)?.toDouble() ?? 16 / 9;
    if (node['kind'] == 'frame') {
      final frame = ViewScope.of(context).frames[source];
      // A name this host does not offer is drawn by the host, neutrally: it
      // says nothing about whether the plugin is trustworthy.
      return frame == null
          ? ViewRegion(
              label: label,
              detail: 'This part of the view isn’t available here.',
              icon: Icons.crop_square_outlined,
              aspectRatio: ratio,
            )
          : frame(context, label);
    }
    return AspectRatio(
      aspectRatio: ratio,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(14),
        child: Image.network(
          source,
          fit: BoxFit.cover,
          semanticLabel: label,
          errorBuilder: (context, error, stack) => ViewRegion(
            label: label,
            detail: 'This image couldn’t be loaded.',
            icon: Icons.image_not_supported_outlined,
            aspectRatio: ratio,
          ),
        ),
      ),
    );
  }
}
