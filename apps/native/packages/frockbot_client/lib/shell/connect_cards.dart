/// The account's Connections, as a card's `ConnectApp` reads them, and the
/// door it opens.
///
/// A Bot that cannot reach an app offers it on a card; the person presses
/// Connect, signs in on the app's own page, and comes back. The card has to
/// say that worked, and the Card record never moves when a Connection does —
/// so, like `ApprovalsController` for a decision, this reads the answer from
/// the account itself and the component draws it.
///
/// Nothing is read until a `ConnectApp` asks: most conversations never draw
/// one, and they should not pay a Connectors read to open.
library;

import 'dart:async';

import 'package:flutter/widgets.dart';

import '../cards/connections.dart';
import '../client/transport.dart';
import '../connections/document.dart';
import '../connections/door.dart';
import '../protocol/client_wire.generated.dart' as wire;

class ConnectCardsController extends ChangeNotifier
    implements CardConnectionsV1 {
  final NativeApi api;

  /// Where the browser is opened; a test puts something else here.
  final Future<bool> Function(Uri)? openBrowser;
  ConnectCardsController({required this.api, this.openBrowser});

  /// Working accounts per Connection Type, once a read has landed.
  Map<String, int>? _ready;
  String? _opening;
  final Set<String> _opened = {};
  final Map<String, String> _failures = {};
  bool _asked = false;
  bool _reading = false;
  bool _reread = false;
  bool _disposed = false;
  int _commands = 0;
  AppLifecycleListener? _lifecycle;

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  @override
  CardConnectionStateV1? connectionStateV1(String connectionTypeId) {
    if (!_asked) {
      _asked = true;
      // The person comes back from the app's page either by switching back
      // to the app or through the return link the door closes into; both
      // are a reason to read again, and neither is until a card has asked.
      _lifecycle = AppLifecycleListener(onResume: () => unawaited(load()));
      connectReturns.addListener(_returned);
      // Not during the build that asked.
      scheduleMicrotask(() => unawaited(load()));
    }
    final ready = _ready;
    if (ready == null && _opening != connectionTypeId) return null;
    return CardConnectionStateV1(
      ready: ready?[connectionTypeId] ?? 0,
      opening: _opening == connectionTypeId,
      opened: _opened.contains(connectionTypeId),
      failure: _failures[connectionTypeId],
    );
  }

  void _returned() => unawaited(load());

  /// A deployment whose Connectors cannot be read is a card with a button
  /// and nothing to say about what the account holds, not a broken one.
  Future<void> load() async {
    if (_disposed) return;
    if (_reading) {
      // The answer in flight was asked for before whatever asks now — the
      // return link landing during the resume read — so it is read again.
      _reread = true;
      return;
    }
    _reading = true;
    try {
      do {
        _reread = false;
        try {
          final frame = wire.ConnectionsFrame.fromJson(
            await api.request('/api/settings/connections'),
          );
          final ready = <String, int>{};
          for (final account in frame.accounts) {
            if (account['state'] != 'ready') continue;
            final typeId = account['connectionTypeId'];
            if (typeId is String) ready[typeId] = (ready[typeId] ?? 0) + 1;
          }
          _ready = ready;
          _changed();
        } catch (_) {
          // Left as it was: the next resume or return reads again.
        }
      } while (_reread && !_disposed);
    } finally {
      _reading = false;
    }
  }

  @override
  Future<void> connectV1({
    required String packageId,
    required String connectionTypeId,
  }) async {
    if (_disposed || _opening != null) return;
    _opening = connectionTypeId;
    _failures.remove(connectionTypeId);
    _changed();
    try {
      final opened = await openConnectionDoorV1(api, {
        'commandId':
            'cc-${DateTime.now().microsecondsSinceEpoch}-${_commands++}',
        'input': {
          'kind': 'authorize',
          'packageId': packageId,
          'connectionTypeId': connectionTypeId,
        },
      }, openBrowser: openBrowser);
      if (opened) _opened.add(connectionTypeId);
    } catch (_) {
      _failures[connectionTypeId] =
          'Couldn’t open the sign-in. Try again, or connect it from '
          'Marketplace in Settings.';
    } finally {
      _opening = null;
      _changed();
    }
    // A Connection that was ready without a door is connected now.
    await load();
  }

  @override
  void dispose() {
    _disposed = true;
    _lifecycle?.dispose();
    connectReturns.removeListener(_returned);
    super.dispose();
  }
}
