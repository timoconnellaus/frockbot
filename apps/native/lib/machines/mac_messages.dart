import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../client/transport.dart';

class MacMessagesController extends ChangeNotifier {
  static const channel = MethodChannel('com.frockbot/messages');
  bool get supported =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.macOS;
  bool consent = false, paired = false, busy = false;
  String status = 'Stopped', error = '';
  String? _userId;
  int _generation = 0;
  Future<void> configure(String userId) async {
    if (!supported) return;
    _generation++;
    _userId = userId;
    consent = false;
    paired = false;
    busy = false;
    status = "Stopped";
    error = "";
    channel.setMethodCallHandler((call) async {
      if (call.method == 'status') _adopt(call.arguments);
    });
    await command('configure', {'origin': hostedOrigin, 'userId': userId});
  }

  void _adopt(Object? value) {
    if (value is! Map ||
        value['userId'] != _userId ||
        value['origin'] != hostedOrigin)
      return;
    consent = value['consent'] == true;
    paired = value['paired'] == true;
    busy = value['busy'] == true;
    status = value['status'] as String? ?? 'Stopped';
    error = value['error'] as String? ?? '';
    notifyListeners();
  }

  Future<void> command(String method, [Map<String, Object?>? input]) async {
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
      error = 'Messages could not connect to the Mac app. Reopen FrockBot and try again.';
      busy = false;
      notifyListeners();
    }
  }

  Future<void> connect(NativeApi api) async {
    if (!consent || busy) return;
    final generation = _generation;
    busy = true;
    error = '';
    notifyListeners();
    try {
      final offer = await api.request(
        '/api/machines/pair',
        body: <String, Object?>{},
      );
      if (generation != _generation || !consent) return;
      final code = (offer as Map)['code'];
      if (code is! String || code.isEmpty) {
        throw const FormatException('Missing pairing code');
      }
      await command('pair', {'code': code});
    } catch (_) {
      if (generation != _generation) return;
      error = 'Couldn’t pair this Mac. Check your connection and try again.';
      busy = false;
      notifyListeners();
    }
  }

  Future<void> stop(String userId) async {
    if (!supported || _userId != userId) return;
    _generation++;
    _userId = null;
    consent = false;
    paired = false;
    busy = false;
    status = 'Stopped';
    error = '';
    notifyListeners();
    try {
      await channel.invokeMethod<Object?>('stop', {
        'userId': userId,
        'origin': hostedOrigin,
      });
    } catch (_) {
      /* Native termination also stops the helper on app exit. */
    }
  }
}

final macMessages = MacMessagesController();

class MacMessagesCard extends StatelessWidget {
  final NativeApi api;
  final MacMessagesController controller;
  const MacMessagesCard({
    super.key,
    required this.api,
    required this.controller,
  });
  @override
  Widget build(BuildContext context) {
    if (!controller.supported) return const SizedBox.shrink();
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) => Card(
        margin: const EdgeInsets.only(bottom: 16),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Messages on this Mac',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              const Text(
                'Requested messages, contacts and attachments are shared with FrockBot’s cloud and the AI providers used by your Bots. Every send requires your approval of the recipient and exact text in FrockBot.',
              ),
              CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text(
                  'Allow Messages sharing with FrockBot and its AI providers',
                ),
                value: controller.consent,
                onChanged: (value) => unawaited(
                  controller.command('consent', {'allowed': value == true}),
                ),
              ),
              const Text(
                'Withdraw consent here to stop future access. This does not delete content already shared. Messages works only while FrockBot is open and you are signed in on this Mac.',
              ),
              const SizedBox(height: 12),
              Text(controller.status),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  if (!controller.paired)
                    FilledButton(
                      onPressed: !controller.consent || controller.busy
                          ? null
                          : () => unawaited(controller.connect(api)),
                      child: const Text('Connect this Mac'),
                    )
                  else
                    OutlinedButton(
                      onPressed: controller.busy
                          ? null
                          : () => unawaited(controller.command('forget')),
                      child: const Text('Forget pairing'),
                    ),
                  TextButton(
                    onPressed: () =>
                        unawaited(controller.command('disk-access')),
                    child: const Text('Open Full Disk Access'),
                  ),
                  TextButton(
                    onPressed: !controller.consent
                        ? null
                        : () => unawaited(controller.command('automation')),
                    child: const Text('Allow Messages sending'),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              const Text(
                'Enable Messages on your Mac in Connectors too. To read history, add FrockBot to Full Disk Access and restart it. Sending needs Automation permission. Revoke the machine below to invalidate its pairing everywhere.',
              ),
              if (controller.error.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    controller.error,
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
