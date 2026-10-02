/// This Mac as a machine that runs the account's device modules (ADR 0037).
///
/// The module host runs beside the app on macOS (`DeviceHostBridge.swift`).
/// Signing in starts it; if this Mac is not paired, the controller enrolls it
/// with the signed-in session and hands the machine token to the host locally,
/// so the host holds a revocable token of its own and never the session. Forget unpairs
/// it and keeps it unpaired until the person asks again. Elsewhere this is a
/// no-op.
library;

import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../brand.dart';
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
  String _label = '';
  String _version = '';

  String? _userId;
  NativeApi? _api;

  /// The server the account this Mac serves is on. The host is one per app,
  /// so it serves the account on screen.
  String? _origin;
  int _generation = 0;

  /// Pairing is tried once per sign-in; a failure is shown, not retried.
  bool _attempted = false;

  /// Whether this Mac runs device modules for an account on [origin]: only
  /// the deployment the build names. A module's code and the paths and Apple
  /// Events its sandbox allows come from the server, so a server the person
  /// merely signed in to must not be able to pair this Mac by itself.
  static bool hostsFor(String origin) => origin == hostedOrigin;

  /// The enrollment's idempotency key: kept until it is answered, so a retry
  /// whose first answer was lost names the same machine instead of a second.
  String? _machineId;

  Future<void> configure(String userId, NativeApi api) async {
    if (!supported || !hostsFor(api.origin)) return;
    _generation++;
    _userId = userId;
    _api = api;
    _origin = api.origin;
    _attempted = false;
    _machineId = null;
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
        value['origin'] != _origin) {
      return;
    }
    available = value['available'] == true;
    ready = value['ready'] == true;
    enrolled = value['enrolled'] == true;
    connected = value['connected'] == true;
    declined = value['declined'] == true;
    error = value['error'] as String? ?? '';
    _label = value['label'] as String? ?? '';
    _version = value['version'] as String? ?? '';
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
        'origin': _origin,
      });
      if (generation == _generation) _adopt(result);
    } catch (_) {
      if (generation != _generation) return;
      error =
          'Device modules couldn’t reach the Mac app. Reopen ${clientBrand.productName}.';
      enrolling = false;
      notifyListeners();
    }
  }

  /// Enroll this Mac with the signed-in session and hand its token to the
  /// host. No pairing code: the session is the proof of whose Mac it is.
  Future<void> enrol() async {
    final api = _api;
    if (!supported || api == null || enrolling) return;
    final generation = _generation;
    enrolling = true;
    error = '';
    notifyListeners();
    try {
      final machineId = _machineId ??= _newMachineId();
      final receipt = await api.request(
        '/api/machines/enroll',
        body: <String, Object?>{
          'schemaVersion': 1,
          'machineId': machineId,
          'label': _label.isEmpty ? 'Mac' : _label,
          'platform': 'macos',
          'agentVersion': _version.isEmpty ? '0.0.0' : _version,
          // The host runs device modules and offers no command capability.
          'capabilities': const <String>[],
        },
      );
      if (generation != _generation) return;
      if (receipt is! Map ||
          receipt['machineId'] != machineId ||
          receipt['token'] is! String) {
        throw const FormatException('Malformed enrollment receipt');
      }
      _machineId = null;
      await _command('adopt', {'receipt': receipt});
    } catch (failure) {
      if (generation != _generation) return;
      // Refused is answered: a revoked machine is never enrolled again.
      if (failure is RequestFailure && failure.refused) _machineId = null;
      error = 'Couldn’t pair this Mac. Check your connection and try again.';
      enrolling = false;
      notifyListeners();
    }
  }

  static String _newMachineId() {
    final random = Random.secure();
    return [
      for (var i = 0; i < 16; i++)
        random.nextInt(256).toRadixString(16).padLeft(2, '0'),
    ].join();
  }

  Future<void> forget() => _command('forget');

  /// Stops serving [userId] on [origin]; a Mac already serving the account
  /// switched to is left alone.
  Future<void> stop(String userId, String origin) async {
    if (!supported || _userId != userId || _origin != origin) return;
    _generation++;
    _userId = null;
    _api = null;
    _origin = null;
    _reset();
    notifyListeners();
    try {
      await channel.invokeMethod<Object?>('stop', {
        'userId': userId,
        'origin': origin,
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
                'This Mac runs your Plugins’ device modules while ${clientBrand.productName} is open.',
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
