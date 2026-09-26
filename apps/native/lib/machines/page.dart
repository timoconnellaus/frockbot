/// Your computers: this Mac's module host, and the account's computers.
///
/// A host over `ViewDocumentView`, the same as Connectors and Routines. The
/// server projects the registry (`app/machine/machines-document.ts`) and this
/// carries its one action, revoking, to the machine's own route.
///
/// Nothing here adds a computer. The desktop app enrols its own Mac through
/// the signed-in session (`device_host.dart`), whose card sits above the list.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../shell/semantics.dart';
import '../view/surface.dart';
import 'device_host.dart';

/// The kinds `MACHINE_ACTION_KINDS_V1` declares.
const machineActionKindsV1 = <String>{'revoke-machine'};

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

  @override
  void adoptCachedDocument(wire.ViewDocument cached) {
    if (_closed || _document != null) return;
    if (cached.surfaceId.value != surfaceId) return;
    _document = cached;
    _changed();
  }

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
  late MachinesController controller;

  @override
  void initState() {
    super.initState();
    controller = MachinesController(widget.api);
  }

  @override
  void didUpdateWidget(MachinesPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.api == widget.api) return;
    final previous = controller;
    controller = MachinesController(widget.api);
    previous.dispose();
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ViewSurfacePage(
    title: 'Your computers',
    store: widget.store,
    userId: widget.userId,
    documentId: MachineIds.document,
    refreshId: MachineIds.refresh,
    controller: controller,
    banner: (context) => DeviceHostCard(controller: deviceHost),
    cacheScope: 'account',
  );
}
