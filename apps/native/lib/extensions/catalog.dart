import 'dart:convert';
import 'dart:collection';

import 'package:flutter/material.dart';
import 'package:genui/genui.dart' as genui;
import 'package:a2ui_core/a2ui_core.dart' as core;
import 'package:json_schema_builder/json_schema_builder.dart';

const candidateCatalogId = 'com.frockbot.qualification.v1';
const a2uiSpecificationVersion = '0.9.1';
const deterministicForm = <Map<String, dynamic>>[
  {
    'id': 'root',
    'component': 'Column',
    'children': ['intro', 'name', 'save'],
  },
  {'id': 'intro', 'component': 'Text', 'text': 'Give this sample a name.'},
  {'id': 'name', 'component': 'TextInput', 'label': 'Name', 'field': 'name'},
  {'id': 'save', 'component': 'Submit', 'label': 'Save', 'action': 'save'},
];

// This catalog is deliberately smaller than GenUI's built-in catalog: no
// remote media, markup, expressions, network functions or native operations.
List<Map<String, dynamic>> validateDocument(Object? input) {
  final active = HashSet<Object>.identity();
  var values = 0;
  void bounded(Object? value, int depth) {
    if (++values > 20000 || depth > 16) {
      throw const FormatException('Document limit');
    }
    if (value is Map || value is List) {
      if (!active.add(value!)) throw const FormatException('Cyclic document');
      for (final child in value is Map ? value.values : value as List) {
        bounded(child, depth + 1);
      }
      active.remove(value);
    } else if (value != null &&
        value is! String &&
        value is! bool &&
        value is! num) {
      throw const FormatException('Invalid document');
    }
  }

  bounded(input, 0);
  if (utf8.encode(jsonEncode(input)).length > 262144 ||
      input is! List ||
      input.isEmpty ||
      input.length > 500) {
    throw const FormatException('Document limit');
  }
  final nodes = <String, Map<String, dynamic>>{};
  final fields = <String>{};
  final actions = <String>{};
  for (final item in input) {
    if (item is! Map<String, dynamic>) {
      throw const FormatException('Invalid component');
    }
    final id = item['id'];
    final type = item['component'];
    if (id is! String ||
        !RegExp(r'^[a-zA-Z][a-zA-Z0-9_-]{0,63}$').hasMatch(id) ||
        nodes.containsKey(id)) {
      throw const FormatException('Invalid component id');
    }
    final extra = switch (type) {
      'Column' || 'Row' || 'List' => {'children'},
      'Text' || 'ValidationMessage' => {'text'},
      'TextInput' || 'NumberInput' => {'label', 'field'},
      'ChoiceInput' => {'label', 'field', 'options'},
      'Submit' => {'label', 'action'},
      _ => throw const FormatException('Unsupported component'),
    };
    if (item.keys.toSet().difference({
          'id',
          'component',
          ...extra,
        }).isNotEmpty ||
        !extra.every(item.containsKey)) {
      throw const FormatException('Unsupported component fields');
    }
    for (final key in ['label', 'text']) {
      if (item.containsKey(key) &&
          (item[key] is! String ||
              (item[key] as String).length > 2000 ||
              RegExp(r'<[^>]+>').hasMatch(item[key] as String))) {
        throw const FormatException('Invalid text');
      }
    }
    if (item.containsKey('field')) {
      final field = item['field'];
      if (field is! String ||
          !RegExp(r'^[a-z][a-zA-Z0-9]{0,31}$').hasMatch(field) ||
          !fields.add(field) ||
          [
            'password',
            'token',
            'secret',
            'credential',
          ].any((x) => field.toLowerCase().contains(x))) {
        throw const FormatException('Invalid input field');
      }
    }
    if (item.containsKey('action') &&
        (item['action'] != 'save' || !actions.add(item['action'] as String))) {
      throw const FormatException('Unsupported action');
    }
    if (item.containsKey('children') &&
        (item['children'] is! List ||
            (item['children'] as List).length > 500 ||
            !(item['children'] as List).every((x) => x is String))) {
      throw const FormatException('Invalid children');
    }
    if (item.containsKey('options') &&
        (item['options'] is! List ||
            (item['options'] as List).isEmpty ||
            (item['options'] as List).length > 32 ||
            !(item['options'] as List).every(
              (x) => x is String && x.length <= 200,
            ))) {
      throw const FormatException('Invalid choices');
    }
    nodes[id] = item;
  }
  final visited = <String>{};
  final ancestors = <String>{};
  void walk(String id, int depth) {
    if (depth > 16 || !ancestors.add(id) || !visited.add(id)) {
      throw const FormatException('Cyclic or repeated component');
    }
    final node = nodes[id];
    if (node == null) throw const FormatException('Missing component');
    for (final child in node['children'] as List? ?? []) {
      walk(child as String, depth + 1);
    }
    ancestors.remove(id);
  }

  walk('root', 1);
  if (visited.length != nodes.length) {
    throw const FormatException('Detached component');
  }
  return (jsonDecode(jsonEncode(input)) as List).cast<Map<String, dynamic>>();
}

class CatalogRegion extends StatefulWidget {
  final Object? document;
  final Future<void> Function(Map<String, Object> input) submit;
  const CatalogRegion({
    super.key,
    required this.document,
    required this.submit,
  });
  @override
  State<CatalogRegion> createState() => _CatalogRegionState();
}

class _CatalogRegionState extends State<CatalogRegion> {
  genui.SurfaceController? controller;
  String? failure;
  String? result;
  bool busy = false;
  final input = <String, Object>{};
  @override
  void initState() {
    super.initState();
    mount();
  }

  @override
  void didUpdateWidget(CatalogRegion oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.document != widget.document) {
      controller?.dispose();
      controller = null;
      mount();
    }
  }

  void mount() {
    failure = null;
    input.clear();
    try {
      final nodes = validateDocument(widget.document);
      final catalog = genui.Catalog([
        for (final type in [
          'Column',
          'Row',
          'List',
          'Text',
          'ValidationMessage',
          'TextInput',
          'NumberInput',
          'ChoiceInput',
          'Submit',
        ])
          genui.CatalogItem(
            name: type,
            dataSchema: Schema.fromMap({
              'type': 'object',
              'properties': <String, Object>{},
              'additionalProperties': true,
            }),
            widgetBuilder: (context) {
              final data = context.data as Map<String, dynamic>;
              final children = (data['children'] as List? ?? [])
                  .map(
                    (id) => Padding(
                      padding: const EdgeInsets.symmetric(vertical: 6),
                      child: context.buildChild(id as String),
                    ),
                  )
                  .toList();
              switch (type) {
                case 'Column':
                case 'List':
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    mainAxisSize: MainAxisSize.min,
                    children: children,
                  );
                case 'Row':
                  return Wrap(spacing: 12, runSpacing: 8, children: children);
                case 'Text':
                case 'ValidationMessage':
                  return Text(data['text'] as String);
                case 'TextInput':
                case 'NumberInput':
                  return TextField(
                    key: ValueKey('form-${data['field']}'),
                    decoration: InputDecoration(
                      labelText: data['label'] as String,
                    ),
                    maxLength: 120,
                    keyboardType: type == 'NumberInput'
                        ? TextInputType.number
                        : TextInputType.text,
                    onChanged: (value) {
                      input[data['field'] as String] = type == 'NumberInput'
                          ? num.tryParse(value) ?? 0
                          : value;
                    },
                  );
                case 'ChoiceInput':
                  return DropdownButtonFormField<String>(
                    decoration: InputDecoration(
                      labelText: data['label'] as String,
                    ),
                    items: (data['options'] as List)
                        .map(
                          (x) => DropdownMenuItem(
                            value: x as String,
                            child: Text(x),
                          ),
                        )
                        .toList(),
                    onChanged: (value) {
                      if (value != null) input[data['field'] as String] = value;
                    },
                  );
                default:
                  return FilledButton(
                    onPressed: save,
                    child: Text(data['label'] as String),
                  );
              }
            },
          ),
      ], catalogId: candidateCatalogId);
      controller = genui.SurfaceController(catalogs: [catalog]);
      controller!.handleMessage(
        core.CreateSurfaceMessage(
          version: 'v0.9.1',
          surfaceId: 'qualification',
          catalogId: candidateCatalogId,
        ),
      );
      controller!.handleMessage(
        core.UpdateComponentsMessage(
          version: 'v0.9.1',
          surfaceId: 'qualification',
          components: nodes,
        ),
      );
    } catch (_) {
      failure =
          'This form couldn’t be opened. Your conversation is still available.';
    }
  }

  Future<void> save() async {
    if (busy) return;
    if (input.keys.toSet().difference({'name'}).isNotEmpty ||
        input['name'] is! String ||
        (input['name'] as String).trim().isEmpty) {
      setState(() {
        result = 'Please enter a name.';
      });
      return;
    }
    setState(() {
      busy = true;
      result = null;
    });
    try {
      await widget.submit(Map.unmodifiable(input));
      if (mounted) {
        setState(() {
          result = 'Saved.';
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          result = 'Couldn’t save. Please try again.';
        });
      }
    } finally {
      if (mounted) {
        setState(() {
          busy = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(20),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text(
            'Form preview',
            style: TextStyle(fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 12),
          if (failure != null)
            Text(failure!)
          else if (controller != null)
            AbsorbPointer(
              absorbing: busy,
              child: genui.Surface(
                surfaceContext: controller!.contextFor('qualification'),
              ),
            ),
          if (busy) const LinearProgressIndicator(),
          if (result != null)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Text(result!),
            ),
        ],
      ),
    ),
  );
  @override
  void dispose() {
    controller?.dispose();
    super.dispose();
  }
}
