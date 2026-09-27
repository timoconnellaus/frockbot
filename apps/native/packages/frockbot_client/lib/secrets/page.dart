/// Saved secrets: the passwords, card numbers and other secrets a person typed
/// on a Bot's card, and a way to delete each one.
///
/// A host over `ViewDocumentView`, the same as Your computers. The server
/// projects the account's secrets (`app/secrets/document.ts`) — their names,
/// the site each is for and whether it is a payment detail, never a value —
/// and this carries the one action, delete, to the route that owns it.
library;

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../shell/semantics.dart';
import '../view/surface.dart';

class SecretsController extends ViewSurfaceController {
  final NativeApi api;
  SecretsController(this.api);

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
  String get surfaceId => 'secrets';

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
        await api.request('/api/secrets?as=document'),
      );
      if (next.surfaceId.value != surfaceId) {
        throw const FormatException('Secrets surface mismatch');
      }
      _document = next;
    } on RequestFailure catch (failure) {
      _message = failure.message;
    } catch (_) {
      _message =
          'Couldn’t load your saved secrets. Check your connection and try again.';
    } finally {
      _busy = false;
      _changed();
    }
  }

  @override
  Future<Map<String, Object?>> dispatch(Map<String, Object?> command) async {
    final input = ((command['input'] as Map?) ?? const {})
        .cast<String, Object?>();
    final secretId = input['secretId'];
    if (input['kind'] != 'delete-secret' || secretId is! String) {
      throw const FormatException('That action is not a secrets command.');
    }
    await api.request(
      '/api/secrets/${Uri.encodeComponent(secretId)}/delete',
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

class SecretsPage extends StatefulWidget {
  final NativeApi api;
  final LocalStore store;
  final String userId;
  const SecretsPage({
    super.key,
    required this.api,
    required this.store,
    required this.userId,
  });

  @override
  State<SecretsPage> createState() => _SecretsPageState();
}

class _SecretsPageState extends State<SecretsPage> {
  late SecretsController controller;

  @override
  void initState() {
    super.initState();
    controller = SecretsController(widget.api);
  }

  @override
  void didUpdateWidget(SecretsPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.api == widget.api) return;
    final previous = controller;
    controller = SecretsController(widget.api);
    previous.dispose();
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ViewSurfacePage(
    title: 'Saved secrets',
    store: widget.store,
    userId: widget.userId,
    documentId: SecretIds.document,
    refreshId: SecretIds.refresh,
    controller: controller,
    cacheScope: 'account',
  );
}
