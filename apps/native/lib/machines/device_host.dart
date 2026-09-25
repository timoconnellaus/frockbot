/// This Mac as a machine that runs the account's device modules (ADR 0037).
///
/// The module host runs beside the app on macOS (`DeviceHostBridge.swift`).
/// Signing in starts it; if this Mac is not paired, the controller pairs it
/// through the signed-in session, so there is no code to copy. Forget unpairs
/// it and keeps it unpaired until the person asks again. Elsewhere this is a
/// no-op.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../client/transport.dart';

class DeviceModuleState {
  final String pluginId;
  final String moduleId;
  final String state;
  const DeviceModuleState(this.pluginId, this.moduleId, this.state);
}

class DeviceHostController extends ChangeNotifier {
  static const channel = MethodChannel('com.frockbot/device-host');
  bool get supported =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.macOS;

  bool available = false;
  bool ready = false;
  bool enrolled = false;
  bool connected = false;
  bool declined = false;
  bool enrolling = false;
  List<DeviceModuleState> modules = const [];
  String error = '';

  String? _userId;
  NativeApi? _api;
  int _generation = 0;

  /// Pairing is tried once per sign-in; a failure is shown, not retried.
  bool _attempted = false;

  Future<void> configure(String userId, NativeApi api) async {
    if (!supported) return;
    _generation++;
    _userId = userId;
    _api = api;
    _attempted = false;
    _reset();
    channel.setMethodCallHandler((call) async {
      if (call.method == 'status') _adopt(call.arguments);
    });
    await _command('configure');
  }

  void _reset() {
    available = false;
    ready = false;
    enrolled = false;
    connected = false;
    declined = false;
    enrolling = false;
    modules = const [];
    error = '';
  }

  void _adopt(Object? value) {
    if (value is! Map ||
        value['userId'] != _userId ||
        value['origin'] != hostedOrigin) {
      return;
    }
    available = value['available'] == true;
    ready = value['ready'] == true;
    enrolled = value['enrolled'] == true;
    connected = value['connected'] == true;
    declined = value['declined'] == true;
    error = value['error'] as String? ?? '';
    modules = [
      for (final entry in (value['modules'] as List?) ?? const [])
        if (entry is Map)
          DeviceModuleState(
            '${entry['pluginId']}',
            '${entry['moduleId']}',
            '${entry['state']}',
          ),
    ];
    if (enrolled || error.isNotEmpty) enrolling = false;
    notifyListeners();
    if (ready && !enrolled && !declined && !enrolling && !_attempted) {
      _attempted = true;
      unawaited(enrol());
    }
  }

  Future<void> _command(String method, [Map<String, Object?>? input]) async {
    if (!supported || _userId == null) return;
    final generation = _generation;
    try {
      final result = await channel.invokeMethod<Object?>(method, {
        ...?input,
        'userId': _userId,
        'origin': hostedOrigin,
      });
      if (generation == _generation) _adopt(result);
    } catch (_) {
      if (generation != _generation) return;
      error = 'Device modules couldn’t reach the Mac app. Reopen FrockBot.';
      enrolling = false;
      notifyListeners();
    }
  }

  /// Pair this Mac through the signed-in session.
  Future<void> enrol() async {
    final api = _api;
    if (!supported || api == null || enrolling) return;
    final generation = _generation;
    enrolling = true;
    error = '';
    notifyListeners();
    try {
      final offer = await api.request(
        '/api/machines/pair',
        body: <String, Object?>{},
      );
      if (generation != _generation) return;
      final code = (offer as Map)['code'];
      if (code is! String || code.isEmpty) {
        throw const FormatException('Missing pairing code');
      }
      await _command('pair', {'code': code});
    } catch (_) {
      if (generation != _generation) return;
      error = 'Couldn’t pair this Mac. Check your connection and try again.';
      enrolling = false;
      notifyListeners();
    }
  }

  Future<void> forget() => _command('forget');

  Future<void> stop(String userId) async {
    if (!supported || _userId != userId) return;
    _generation++;
    _userId = null;
    _api = null;
    _reset();
    notifyListeners();
    try {
      await channel.invokeMethod<Object?>('stop', {
        'userId': userId,
        'origin': hostedOrigin,
      });
    } catch (_) {
      /* Quitting the app stops the host too. */
    }
  }
}

final deviceHost = DeviceHostController();

class DeviceHostCard extends StatelessWidget {
  final DeviceHostController controller;
  const DeviceHostCard({super.key, required this.controller});

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: controller,
    builder: (context, _) {
      if (!controller.supported || !controller.available) {
        return const SizedBox.shrink();
      }
      final theme = Theme.of(context);
      final status = controller.enrolled
          ? (controller.connected ? 'Connected' : 'Reconnecting…')
          : controller.enrolling
          ? 'Pairing…'
          : 'Not paired';
      return Card(
        margin: const EdgeInsets.only(bottom: 12),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Semantics(
                header: true,
                child: Text('This Mac', style: theme.textTheme.titleSmall),
              ),
              const SizedBox(height: 4),
              Text(
                'This Mac runs your Plugins’ device modules while FrockBot is open.',
                style: theme.textTheme.bodySmall,
              ),
              const SizedBox(height: 8),
              Text(status, style: theme.textTheme.bodySmall),
              for (final module in controller.modules)
                Text(
                  '${module.pluginId} · ${module.moduleId} — ${module.state}',
                  style: theme.textTheme.bodySmall,
                ),
              const SizedBox(height: 8),
              if (controller.enrolled)
                OutlinedButton(
                  onPressed: () => unawaited(controller.forget()),
                  child: const Text('Forget'),
                )
              else
                FilledButton.tonal(
                  onPressed: controller.enrolling || !controller.ready
                      ? null
                      : () => unawaited(controller.enrol()),
                  child: const Text('Run modules on this Mac'),
                ),
              if (controller.error.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    controller.error,
                    style: TextStyle(color: theme.colorScheme.error),
                  ),
                ),
            ],
          ),
        ),
      );
    },
  );
}
