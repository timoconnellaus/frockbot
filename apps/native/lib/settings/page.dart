import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../connections/page.dart';
import '../plugins/page.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../shell/lifecycle.dart';
import '../shell/semantics.dart';
import '../theme/states.dart';
import '../view/action.dart';
import '../view/document.dart';
import 'controller.dart';
import 'document.dart';
import 'model_picker.dart';

/// Settings, rendered by the host's one renderer.
///
/// The server projects the settings frame it already produces as a
/// `ViewDocument`, so this page is a host over `ViewDocumentView` rather than
/// a second renderer of typed fields: the widgets, the budgets and the
/// retained command envelope are the ones every plugin-described view gets.
/// What is left here is the surface's own chrome and the route an action
/// lands on.
class SettingsPage extends StatefulWidget {
  final NativeApi api;
  final LocalStore store;
  final String userId;
  final String home;
  final String? section;
  final String? title;
  const SettingsPage({
    super.key,
    required this.api,
    required this.store,
    required this.userId,
    this.home = 'application',
    this.section,
    this.title,
  });
  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage>
    with WidgetsBindingObserver {
  late final SettingsController state = SettingsController(
    widget.api,
    widget.userId,
    widget.home,
    section: widget.section,
  );
  ViewController? view;
  int? shown;
  bool handingOff = false;
  bool reloadWanted = false;
  String? saved;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    state.addListener(_adopt);
    unawaited(state.load());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    state.removeListener(_adopt);
    view?.removeListener(_afterAction);
    view?.dispose();
    state.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState phase) {
    if (!appIsAwayV1(phase)) unawaited(state.load());
  }

  /// One controller per revision: a save moves the revision on, and the values
  /// a person had typed against the previous one are no longer answers to it.
  void _adopt() {
    final document = state.document;
    if (!mounted) return;
    if (document == null || document.revision == shown) {
      setState(() {});
      return;
    }
    view?.removeListener(_afterAction);
    view?.dispose();
    final next = ViewController(
      store: widget.store,
      userId: widget.userId,
      surfaceId: state.surfaceId,
      revision: document.revision,
      dispatch: _dispatch,
    );
    next.addListener(_afterAction);
    setState(() {
      shown = document.revision;
      view = next;
    });
    unawaited(next.restore());
  }

  /// A change the owner accepted moves the revision, so the document is read
  /// again — but only once the command that moved it has finished being
  /// confirmed, so the controller is never replaced under its own dispatch.
  void _afterAction() {
    if (!mounted) return;
    setState(() {});
    if (!reloadWanted || view!.busy || view!.pending != null) return;
    reloadWanted = false;
    unawaited(state.load());
  }

  Future<Map<String, Object?>> _dispatch(Map<String, Object?> command) async {
    if (viewActionKindV1(command) == manageProviderKindV1) {
      await _manageProvider(
        (command['input'] as Map?)?['sectionId'] as String?,
      );
      return {'commandId': command['commandId'], 'status': 'applied'};
    }
    final receipt = await state.dispatch(command);
    if (receipt['status'] == 'applied') {
      reloadWanted = true;
      saved = 'Saved.';
      final chosen = chosenProviderPackageIdV1(command);
      if (viewActionKindV1(command) == 'choose-provider') {
        await _manageProvider(
          (command['input'] as Map?)?['sectionId'] as String?,
        );
      } else if (chosen != null) {
        await _manageProvider('provider.$chosen');
      }
    }
    return receipt;
  }

  Future<void> _manageProvider(String? sectionId) async {
    if (handingOff) return;
    setState(() => handingOff = true);
    try {
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => ConnectionsPage(
            api: widget.api,
            store: widget.store,
            userId: widget.userId,
            models: true,
            packageId: sectionId?.replaceFirst('provider.', ''),
          ),
        ),
      );
      reloadWanted = true;
    } finally {
      if (mounted) setState(() => handingOff = false);
    }
  }

  Widget _modelField(
    BuildContext context,
    wire.SettingField field,
    String id,
    Object? value,
    void Function(Object? value)? onChanged,
  ) {
    // A projected select carries JSON-encoded values, so the current value is
    // matched as it stands and decoded only for the picker's own comparison.
    final decoded = value is String ? jsonDecode(value) : null;
    final matched = (field.choices ?? const <wire.SettingChoice>[]).where(
      (choice) => choice.value.value == value,
    );
    return identified(
      SettingsIds.modelField,
      Card(
        child: ListTile(
          leading: const Icon(Icons.auto_awesome_rounded),
          title: Text(matched.isEmpty ? 'Choose a model' : matched.first.label),
          subtitle: Text(field.hint ?? 'Used by all your Bots'),
          trailing: const Icon(Icons.expand_more_rounded),
          onTap: onChanged == null
              ? null
              : () async {
                  final choice = await Navigator.of(context)
                      .push<wire.SettingChoice>(
                        MaterialPageRoute(
                          builder: (_) => ModelPicker(
                            load: state.options,
                            selected: decoded,
                          ),
                        ),
                      );
                  if (choice != null) onChanged(jsonEncode(choice.value.value));
                },
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final document = state.document;
    final controller = view;
    return Scaffold(
      appBar: AppBar(
        title: Text(
          widget.title ??
              (widget.home == 'models' ? 'Models' : 'Personal details'),
        ),
        actions: [
          identified(
            SettingsIds.refresh,
            IconButton(
              tooltip: 'Refresh settings',
              onPressed: state.busy ? null : state.load,
              icon: const Icon(Icons.refresh_rounded),
            ),
          ),
        ],
      ),
      body: SafeArea(
        top: false,
        child: document == null || controller == null
            ? state.busy
                  ? const FrockLoading(label: 'Loading settings')
                  : FrockEmptyState(
                      icon: Icons.cloud_off_rounded,
                      title: 'Settings couldn’t load',
                      detail:
                          state.message ??
                          'Check your connection and try again.',
                      action: 'Try again',
                      onAction: state.load,
                    )
            : RefreshIndicator(
                onRefresh: state.load,
                child: ListView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: const EdgeInsets.fromLTRB(20, 12, 20, 32),
                  children: [
                    Center(
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 680),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            if (saved != null)
                              Padding(
                                padding: const EdgeInsets.only(bottom: 8),
                                child: Semantics(
                                  liveRegion: true,
                                  child: Text(saved!),
                                ),
                              ),
                            identified(
                              SettingsIds.document,
                              ViewDocumentView(
                                key: ValueKey(
                                  '${state.surfaceId}.${document.revision}',
                                ),
                                document: document,
                                controller: controller,
                                fields: {'account-models': _modelField},
                              ),
                            ),
                            if (widget.home == 'models') ..._homeLinks(),
                            if (widget.section != null)
                              TextButton(
                                onPressed: () => Navigator.of(context)
                                    .push(
                                      MaterialPageRoute<void>(
                                        builder: (_) => PluginsPage(
                                          api: widget.api,
                                          store: widget.store,
                                          userId: widget.userId,
                                          capabilities: true,
                                        ),
                                      ),
                                    )
                                    .then((_) => state.load()),
                                child: const Text(
                                  'Manage this feature in Account features',
                                ),
                              ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              ),
      ),
    );
  }

  List<Widget> _homeLinks() => [
    ListTile(
      leading: const Icon(Icons.image_outlined),
      title: const Text('Image generation'),
      subtitle: const Text('Choose the model used to create images'),
      trailing: const Icon(Icons.chevron_right),
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => SettingsPage(
            api: widget.api,
            store: widget.store,
            userId: widget.userId,
            section: 'package.image',
            title: 'Image generation',
          ),
        ),
      ),
    ),
  ];
}
