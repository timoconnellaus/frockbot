import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';

import '../protocol/client_wire.generated.dart' as wire;
import '../theme/states.dart';
import '../ui/frock_page.dart';
import '../ui/frock_tokens.dart';
import '../ui/frock_widgets.dart';

/// A bounded, revision-pinned view of the owner's available model catalog.
class ModelPicker extends StatefulWidget {
  final Future<wire.SettingsOptionsPage> Function(String, int?) load;
  final Object? selected;
  const ModelPicker({super.key, required this.load, required this.selected});
  @override
  State<ModelPicker> createState() => _ModelPickerState();
}

class _ModelPickerState extends State<ModelPicker> {
  Timer? debounce;
  int request = 0;
  String query = '';
  int? cursor;
  final previous = <int?>[];
  wire.SettingsOptionsPage? page;
  bool busy = true;
  bool failed = false;
  @override
  void initState() {
    super.initState();
    unawaited(load());
  }

  @override
  void dispose() {
    debounce?.cancel();
    request++;
    super.dispose();
  }

  Future<void> load() async {
    final ticket = ++request;
    setState(() {
      busy = true;
      failed = false;
    });
    try {
      final next = await widget.load(query, cursor);
      if (!mounted || ticket != request) return;
      setState(() {
        page = next;
        busy = false;
      });
    } catch (_) {
      if (!mounted || ticket != request) return;
      setState(() {
        failed = true;
        busy = false;
      });
    }
  }

  void search(String value) {
    debounce?.cancel();
    request++;
    setState(() {
      query = value;
      cursor = null;
      previous.clear();
      page = null;
      busy = true;
    });
    debounce = Timer(const Duration(milliseconds: 300), load);
  }

  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    return FrockPage(
      title: 'Choose a model',
      padded: false,
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(
              FrockTokens.edge,
              4,
              FrockTokens.edge,
              12,
            ),
            child: TextField(
              decoration: const InputDecoration(
                hintText: 'Search models',
                prefixIcon: Icon(Icons.search_rounded),
                counterText: '',
              ),
              maxLength: 100,
              textInputAction: TextInputAction.search,
              onChanged: search,
              onSubmitted: (_) {
                debounce?.cancel();
                unawaited(load());
              },
            ),
          ),
          Expanded(
            child: busy
                ? const FrockLoading(label: 'Loading models')
                : failed
                ? FrockEmptyState(
                    icon: Icons.cloud_off_rounded,
                    title: 'Models couldn’t load',
                    detail: 'Check your connection and try again. If Settings changed, return to Models and refresh.',
                    action: 'Try again',
                    onAction: load,
                  )
                : page!.items.isEmpty
                ? FrockEmptyState(
                    icon: Icons.search_off_rounded,
                    title: 'No matching models',
                    detail:
                        'Try another name, or connect a provider on Models.',
                    action: 'Back to Models',
                    onAction: () => Navigator.of(context).pop(),
                  )
                : ListView(
                    padding: const EdgeInsets.fromLTRB(
                      FrockTokens.edge,
                      0,
                      FrockTokens.edge,
                      FrockTokens.edge,
                    ),
                    children: [
                      FrockGroup(
                        children: [
                          for (final choice in page!.items)
                            FrockRow(
                              key: ValueKey(
                                'model-${jsonEncode(choice.value.value)}',
                              ),
                              leading: FrockIconTile(
                                choice.value.value == null
                                    ? Icons.auto_awesome_rounded
                                    : Icons.memory_rounded,
                              ),
                              title: choice.label,
                              trailing:
                                  jsonEncode(choice.value.value) ==
                                      jsonEncode(widget.selected)
                                  ? Icon(
                                      Icons.check_rounded,
                                      size: FrockTokens.icon,
                                      color: t.accent,
                                    )
                                  : null,
                              onTap: () => Navigator.of(context).pop(choice),
                            ),
                        ],
                      ),
                    ],
                  ),
          ),
          if (!busy && !failed && page != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(
                FrockTokens.edge,
                0,
                FrockTokens.edge,
                12,
              ),
              child: Row(
                children: [
                  FrockPill(
                    'Previous',
                    kind: PillKind.ghost,
                    size: PillSize.sm,
                    icon: Icons.chevron_left_rounded,
                    color: t.ink2,
                    onTap: previous.isEmpty
                        ? null
                        : () {
                            cursor = previous.removeLast();
                            unawaited(load());
                          },
                  ),
                  const Spacer(),
                  FrockPill(
                    'More models',
                    kind: PillKind.ghost,
                    size: PillSize.sm,
                    icon: Icons.chevron_right_rounded,
                    color: t.accent,
                    onTap: page!.nextCursor == null
                        ? null
                        : () {
                            previous.add(cursor);
                            cursor = page!.nextCursor;
                            unawaited(load());
                          },
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
