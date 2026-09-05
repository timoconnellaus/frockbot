import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../theme/states.dart';
import 'controller.dart';

class SettingsPage extends StatefulWidget {
  final NativeApi api;
  final LocalStore store;
  final String userId;
  final String home;
  const SettingsPage({
    super.key,
    required this.api,
    required this.store,
    required this.userId,
    this.home = 'application',
  });
  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage>
    with WidgetsBindingObserver {
  late final state = SettingsController(
    widget.api,
    widget.store,
    widget.userId,
    widget.home,
  );
  bool handingOff = false;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(state.load());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    state.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState phase) {
    if (phase == AppLifecycleState.resumed) unawaited(state.load());
  }

  Future<void> manageProvider() async {
    if (handingOff) return;
    setState(() => handingOff = true);
    try {
      final result = wire.AuthStartView.fromJson(
        await widget.api.request(
          '/api/auth/native/settings',
          body: {'schemaVersion': 1, 'home': 'models'},
        ),
      );
      final uri = Uri.parse(result.authorizationUrl.value);
      if (uri.origin != hostedOrigin ||
          uri.path != '/native/settings' ||
          uri.userInfo.isNotEmpty ||
          uri.fragment.isNotEmpty) {
        throw const FormatException('Invalid authorization destination');
      }
      if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
        throw const FormatException('Browser unavailable');
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Couldn’t open account setup. Check your connection and try again.',
            ),
          ),
        );
      }
    } finally {
      if (mounted) setState(() => handingOff = false);
    }
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: state,
    builder: (context, _) => Scaffold(
      appBar: AppBar(
        title: Text(widget.home == 'models' ? 'Models' : 'Settings'),
        actions: [
          IconButton(
            tooltip: 'Refresh settings',
            onPressed: state.busy ? null : state.load,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: SafeArea(
        top: false,
        child: state.frame == null
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
                            if (widget.home == 'application')
                              Card(
                                child: ListTile(
                                  leading: const Icon(
                                    Icons.auto_awesome_rounded,
                                  ),
                                  title: const Text('Models'),
                                  subtitle: const Text(
                                    'Your default model and provider accounts',
                                  ),
                                  trailing: const Icon(
                                    Icons.chevron_right_rounded,
                                  ),
                                  onTap: () => Navigator.of(context).push(
                                    MaterialPageRoute<void>(
                                      builder: (_) => SettingsPage(
                                        api: widget.api,
                                        store: widget.store,
                                        userId: widget.userId,
                                        home: 'models',
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                            if (state.message != null)
                              Padding(
                                padding: const EdgeInsets.symmetric(
                                  vertical: 12,
                                ),
                                child: Semantics(
                                  liveRegion: true,
                                  child: Text(state.message!),
                                ),
                              ),
                            if (state.pending != null)
                              FilledButton.tonal(
                                onPressed: state.busy ? null : state.checkSave,
                                child: Text(
                                  state.busy ? 'Checking save…' : 'Check save',
                                ),
                              ),
                            for (final section in state.frame!.sections)
                              _SettingsSection(
                                key: ValueKey(
                                  '${section['id']}.${state.frame!.revision}',
                                ),
                                section: section,
                                disabled:
                                    state.busy ||
                                    state.pending != null ||
                                    handingOff,
                                onSave: state.save,
                                onManage: manageProvider,
                              ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              ),
      ),
    ),
  );
}

class _SettingsSection extends StatefulWidget {
  final Map<String, Object?> section;
  final bool disabled;
  final Future<void> Function(
    String,
    Map<String, Object?>, {
    List<String> unset,
  })
  onSave;
  final Future<void> Function() onManage;
  const _SettingsSection({
    super.key,
    required this.section,
    required this.disabled,
    required this.onSave,
    required this.onManage,
  });
  @override
  State<_SettingsSection> createState() => _SettingsSectionState();
}

class _SettingsSectionState extends State<_SettingsSection> {
  final form = GlobalKey<FormState>();
  final values = <String, Object?>{};
  final dirty = <String>{};
  late final fields = (widget.section['fields'] as List)
      .map(wire.SettingField.fromJson)
      .toList();
  @override
  void initState() {
    super.initState();
    for (final field in fields) {
      values[field.id.value] = field.value.value;
    }
  }

  void change(String id, Object? value) => setState(() {
    values[id] = value;
    dirty.add(id);
  });
  Future<void> save() async {
    if (!form.currentState!.validate()) return;
    final id = widget.section['id'] as String;
    final selected = id == 'profile' ? values.keys : dirty;
    final patch = <String, Object?>{};
    final unset = <String>[];
    for (final key in selected) {
      if (id.startsWith('package.') && values[key] == null) {
        unset.add(key);
      } else {
        patch[key] = values[key];
      }
    }
    await widget.onSave(id, patch, unset: unset);
  }

  Widget field(wire.SettingField field) {
    final id = field.id.value;
    final enabled = !widget.disabled && field.editable;
    final decoration = InputDecoration(
      labelText: field.label,
      helperText: field.hint,
      helperMaxLines: 4,
    );
    if (field.kind == 'boolean') {
      return SwitchListTile.adaptive(
        contentPadding: EdgeInsets.zero,
        title: Text(field.label),
        subtitle: field.hint == null ? null : Text(field.hint!),
        value: values[id] == true,
        onChanged: enabled ? (v) => change(id, v) : null,
      );
    }
    if (field.kind == 'select') {
      return DropdownButtonFormField<String>(
        initialValue: jsonEncode(values[id]),
        decoration: decoration,
        isExpanded: true,
        items: [
          for (final choice in field.choices ?? [])
            DropdownMenuItem(
              value: jsonEncode(choice['value']),
              child: Text(
                choice['label'] as String,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
              ),
            ),
        ],
        onChanged: enabled
            ? (v) {
                if (v != null) change(id, jsonDecode(v));
              }
            : null,
      );
    }
    return TextFormField(
      initialValue: values[id]?.toString() ?? '',
      enabled: enabled,
      decoration: decoration,
      maxLength: field.maxLength,
      keyboardType: field.kind == 'number'
          ? const TextInputType.numberWithOptions(decimal: true, signed: true)
          : id == 'email'
          ? TextInputType.emailAddress
          : TextInputType.text,
      onChanged: (v) => change(
        id,
        field.kind == 'number' ? (v.isEmpty ? null : num.tryParse(v)) : v,
      ),
      validator: (v) {
        if (field.required == true && (v == null || v.trim().isEmpty)) {
          return 'Enter ${field.label.toLowerCase()}.';
        }
        if (field.kind == 'number' && v != null && v.isNotEmpty) {
          final number = num.tryParse(v);
          if (number == null || !number.isFinite) return 'Enter a number.';
          if (field.minimum != null && number < field.minimum!) {
            return 'Use ${field.minimum} or more.';
          }
          if (field.maximum != null && number > field.maximum!) {
            return 'Use ${field.maximum} or less.';
          }
        }
        return null;
      },
    );
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 24),
    child: Form(
      key: form,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Semantics(
            header: true,
            child: Text(
              widget.section['label'] as String,
              style: Theme.of(context).textTheme.titleMedium,
            ),
          ),
          const SizedBox(height: 16),
          if (widget.section['failure'] case final String failure)
            Text(failure),
          for (final item in fields)
            Padding(
              padding: const EdgeInsets.only(bottom: 16),
              child: field(item),
            ),
          if (fields.any((f) => f.editable))
            Align(
              alignment: Alignment.centerRight,
              child: FilledButton(
                onPressed: widget.disabled || dirty.isEmpty ? null : save,
                child: const Text('Save changes'),
              ),
            ),
          for (final action in (widget.section['actions'] as List?) ?? [])
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: OutlinedButton.icon(
                onPressed: widget.disabled
                    ? null
                    : action['kind'] == 'manage-provider'
                    ? widget.onManage
                    : () => widget.onSave(widget.section['id'] as String, {}),
                icon: Icon(
                  action['kind'] == 'manage-provider'
                      ? Icons.open_in_browser_rounded
                      : Icons.add_rounded,
                ),
                label: Text(action['label'] as String),
              ),
            ),
          const SizedBox(height: 20),
          const Divider(height: 1),
        ],
      ),
    ),
  );
}
