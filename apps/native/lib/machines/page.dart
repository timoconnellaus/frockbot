/// Registered machines: the computers a Bot may reach, and how one is added.
///
/// A host over `ViewDocumentView`, the same as Connectors and Routines. The
/// server projects the registry (`app/machine/machines-document.ts`) and this
/// carries each action to the route that owns it: registering lands on the
/// pairing route, revoking on the machine's own.
///
/// The pairing code is the one thing here that is not in the document. It is
/// signed once and stored only as a digest, so it exists on a receipt and
/// nowhere else; the host holds it in the banner for as long as the person is
/// looking at it, and a second look means a second code.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../shell/semantics.dart';
import '../view/surface.dart';

/// The kinds `MACHINE_ACTION_KINDS_V1` declares.
const machineActionKindsV1 = <String>{'pair-machine', 'revoke-machine'};

/// The field the register form carries.
const machineLabelFieldV1 = 'machine.label';

/// How long a pairing code has left.
///
/// A distance, not an instant: the app has no IANA zone to write one in, and
/// "expires in four minutes" is the whole of what a person about to walk to
/// another computer needs to know.
String pairingWindowV1(String expiresAt, {DateTime? now}) {
  final at = DateTime.tryParse(expiresAt);
  if (at == null) return 'shortly';
  final left = at.difference(now ?? DateTime.now());
  if (left.inSeconds <= 0) return 'now — get another';
  if (left.inSeconds < 60) return 'in under a minute';
  final minutes = (left.inSeconds / 60).round();
  return 'in $minutes minute${minutes == 1 ? '' : 's'}';
}

String? machineActionKindV1(Map<String, Object?> command) {
  final kind = ((command['input'] as Map?)?['kind']) as String?;
  return machineActionKindsV1.contains(kind) ? kind : null;
}

class MachinesController extends ViewSurfaceController {
  final NativeApi api;
  MachinesController(this.api);

  wire.ViewDocument? _document;
  bool _busy = false;
  bool _closed = false;
  String? _message;

  /// The pairing offer the authority just minted: a code, and when it stops
  /// working. Held here and never read again.
  Map<String, Object?>? offer;

  @override
  wire.ViewDocument? get document => _document;
  @override
  bool get busy => _busy;
  @override
  String? get message => _message;
  @override
  String get surfaceId => 'machines';

  void _changed() {
    if (!_closed) notifyListeners();
  }

  @override
  Future<void> load() async {
    if (_busy) return;
    _busy = true;
    _message = null;
    _changed();
    try {
      final next = wire.ViewDocument.fromJson(
        await api.request('/api/machines?as=document'),
      );
      if (next.surfaceId.value != surfaceId) {
        throw const FormatException('Machines surface mismatch');
      }
      _document = next;
    } on RequestFailure catch (failure) {
      // A deployment with no machine secret answers 503 for every one of these
      // routes. That is not a broken connection, and saying so would send a
      // person looking for a problem they do not have.
      _message = failure.status == 503
          ? 'This deployment doesn’t register machines.'
          : failure.message;
    } catch (_) {
      _message =
          'Couldn’t load your machines. Check your connection and try again.';
    } finally {
      _busy = false;
      _changed();
    }
  }

  @override
  Future<Map<String, Object?>> dispatch(Map<String, Object?> command) async {
    final kind = machineActionKindV1(command);
    final input = ((command['input'] as Map?) ?? const {})
        .cast<String, Object?>();
    if (kind == 'pair-machine') {
      final label = (input[machineLabelFieldV1] as String? ?? '').trim();
      offer = ((await api.request(
        '/api/machines/pair',
        body: label.isEmpty ? <String, Object?>{} : {'label': label},
      )) as Map).cast<String, Object?>();
      return {'commandId': command['commandId'], 'status': 'applied'};
    }
    final machineId = input['machineId'] as String?;
    if (kind != 'revoke-machine' || machineId == null) {
      throw const FormatException('That action is not a machine command.');
    }
    await api.request(
      '/api/machines/${Uri.encodeComponent(machineId)}/revoke',
      body: const <String, Object?>{},
    );
    return {'commandId': command['commandId'], 'status': 'applied'};
  }

  void forgetOffer() {
    offer = null;
    _changed();
  }

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }
}

class MachinesPage extends StatefulWidget {
  final NativeApi api;
  final LocalStore store;
  final String userId;
  const MachinesPage({
    super.key,
    required this.api,
    required this.store,
    required this.userId,
  });

  @override
  State<MachinesPage> createState() => _MachinesPageState();
}

class _MachinesPageState extends State<MachinesPage> {
  late final MachinesController controller = MachinesController(widget.api);

  @override
  Widget build(BuildContext context) => ViewSurfacePage(
    title: 'Registered machines',
    store: widget.store,
    userId: widget.userId,
    documentId: MachineIds.document,
    refreshId: MachineIds.refresh,
    controller: controller,
    banner: (context) => PairingCodeCard(controller: controller),
  );
}

/// The pairing code, the one time it exists.
class PairingCodeCard extends StatelessWidget {
  final MachinesController controller;
  const PairingCodeCard({super.key, required this.controller});

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: controller,
    builder: (context, _) {
      final offer = controller.offer;
      if (offer == null) return const SizedBox.shrink();
      final code = offer['code'] as String? ?? '';
      final theme = Theme.of(context);
      return identified(
        MachineIds.pairingCode,
        Card(
          margin: const EdgeInsets.only(bottom: 12),
          color: theme.colorScheme.secondaryContainer,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Semantics(
                  header: true,
                  child: Text(
                    'Pairing code',
                    style: theme.textTheme.titleSmall,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  'One use only, and it expires ${pairingWindowV1(offer['expiresAt'] as String? ?? '')}. Paste it into the FrockBot desktop app on the machine you want to register.',
                  style: theme.textTheme.bodySmall,
                ),
                const SizedBox(height: 12),
                SelectableText(code, style: theme.textTheme.bodySmall),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 12,
                  children: [
                    identified(
                      MachineIds.pairingCopy,
                      FilledButton.tonal(
                        onPressed: () async {
                          await Clipboard.setData(ClipboardData(text: code));
                          if (context.mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              const SnackBar(content: Text('Code copied.')),
                            );
                          }
                        },
                        child: const Text('Copy code'),
                      ),
                    ),
                    identified(
                      MachineIds.pairingDismiss,
                      TextButton(
                        onPressed: controller.forgetOffer,
                        child: const Text('Done'),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      );
    },
  );
}
