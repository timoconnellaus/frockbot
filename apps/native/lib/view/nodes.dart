import 'dart:convert';

import 'package:flutter/material.dart';

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
