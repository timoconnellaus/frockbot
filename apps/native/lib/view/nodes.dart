import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import '../protocol/client_wire.generated.dart' as wire;
import '../shell/semantics.dart';
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
                      padding: const EdgeInsets.all(16),
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

class _CapabilityCard extends StatelessWidget {
  final Map<String, Object?> node;
  const _CapabilityCard({required this.node});

  @override
  Widget build(BuildContext context) {
    final children = (node['children'] as List)
        .map((child) => (child as Map).cast<String, Object?>())
        .toList();
    final actions = children
        .where((child) => child['type'] == 'group')
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
    final scope = ViewScope.of(context);
    final schema = scope.actions[toggle?['actionId']];
    final enabled =
        toggle?['actionId'] == 'set-package-enabled' &&
        (toggle?['input'] as Map?)?['enabled'] == false;
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
                      padding: const EdgeInsets.only(top: 10),
                      child: Text(
                        node['title'] as String,
                        style: Theme.of(context).textTheme.titleMedium,
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
                          value: enabled,
                          onChanged:
                              schema == null ||
                                  scope.controller.busy ||
                                  scope.controller.pending != null
                              ? null
                              : (_) => scope.controller.submit(toggle, schema),
                        ),
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 12),
              for (final child in children.where(
                (child) => child['type'] != 'group',
              ))
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: ViewNodeView(node: child),
                ),
            ],
          ),
          if (settings != null) ...[
            const SizedBox(height: 8),
            ViewActionNode(node: settings),
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
    var height = 0.0;
    var child = firstChild;
    while (child != null) {
      child.layout(BoxConstraints.tightFor(width: width), parentUsesSize: true);
      if (child.size.height > height) height = child.size.height;
      child = childAfter(child);
    }
    var index = 0;
    child = firstChild;
    while (child != null) {
      child.layout(BoxConstraints.tightFor(width: width, height: height));
      (child.parentData as ContainerBoxParentData<RenderBox>).offset = Offset(
        (index % columns) * (width + 12),
        (index ~/ columns) * (height + 12),
      );
      index++;
      child = childAfter(child);
    }
    final rows = (childCount / columns).ceil();
    size = constraints.constrain(
      Size(constraints.maxWidth, rows == 0 ? 0 : rows * (height + 12) - 12),
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
    return switch (node['style']) {
      'heading' => Semantics(
        header: true,
        child: Text(text, style: type.titleMedium),
      ),
      'label' => Text(text, style: type.labelLarge),
      'status' => Semantics(
        liveRegion: true,
        child: Text(text, style: type.bodySmall),
      ),
      _ => Text(text, style: type.bodyLarge),
    };
  }
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
    final children = [
      for (final child in (widget.node['children']! as List))
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: ViewNodeView(node: (child as Map).cast<String, Object?>()),
        ),
    ];
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
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Row(
                children: [
                  Expanded(
                    child: Semantics(
                      header: true,
                      child: Text(
                        title,
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                    ),
                  ),
                  if (widget.node.containsKey('collapsed'))
                    Icon(open ? Icons.expand_less : Icons.expand_more),
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
      return TextFormField(
        enabled: enabled,
        obscureText: true,
        autocorrect: false,
        enableSuggestions: false,
        decoration: decoration,
        onChanged: (next) =>
            scope.controller.change(id, next.isEmpty ? null : next),
      );
    }
    final number = field.kind == 'number';
    return TextFormField(
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
        : () => scope.controller.submit(node, schema);
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
          'primary' => FilledButton(onPressed: press, child: Text(label)),
          'danger' => OutlinedButton(
            onPressed: press,
            style: OutlinedButton.styleFrom(
              foregroundColor: Theme.of(context).colorScheme.error,
            ),
            child: Text(label),
          ),
          _ => OutlinedButton(onPressed: press, child: Text(label)),
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
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final row in rows)
          Builder(
            builder: (context) {
              final schema = scope.actions[row['actionId']];
              return ListTile(
                key: ValueKey('view-row-${row['id']}'),
                selected: row['selected'] == true,
                contentPadding: const EdgeInsets.symmetric(horizontal: 12),
                title: ViewNodeView(
                  node: (row['node']! as Map).cast<String, Object?>(),
                ),
                trailing: row['selected'] == true
                    ? const Icon(Icons.check_rounded)
                    : null,
                onTap:
                    schema == null ||
                        scope.controller.busy ||
                        scope.controller.pending != null
                    ? null
                    : () => scope.controller.submit({
                        'actionId': row['actionId'],
                      }, schema),
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
