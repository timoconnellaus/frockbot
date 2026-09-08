import 'package:url_launcher/url_launcher.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../view/surface.dart';
import 'document.dart';

/// Reads the Connectors document and carries one action to the route it means.
///
/// Connectors is the one surface whose actions do not all land on one route: a
/// Connection command goes to `/api/connections`, a revocation to the
/// Package's own route, and a hosted grant is not a command at all. The
/// renderer is unaware of that — it dispatches the envelope it assembled, and
/// this is where the envelope becomes a request.
class ConnectionsController extends ViewSurfaceController {
  final NativeApi api;
  final String userId;
  final Future<bool> Function(Uri)? openBrowser;
  wire.ViewDocument? _document;
  bool _busy = false;
  bool _closed = false;
  String? _message;

  ConnectionsController(this.api, this.userId, {this.openBrowser});

  @override
  wire.ViewDocument? get document => _document;
  @override
  bool get busy => _busy;
  @override
  String? get message => _message;
  @override
  String get surfaceId => 'connections';

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
        await api.request('/api/settings/connections?as=document'),
      );
      if (next.surfaceId.value != surfaceId) {
        throw const FormatException('Connectors surface mismatch');
      }
      _document = next;
    } catch (_) {
      _message =
          'Couldn’t load your connectors. Check your connection and try again.';
    } finally {
      _busy = false;
      _changed();
    }
  }

  @override
  Future<Map<String, Object?>> dispatch(Map<String, Object?> command) async {
    if (connectionActionKindV1(command) == 'authorize') {
      return _authorize(command);
    }
    final request = connectionRequestV1(command);
    final answer = await api.request(request.path, body: request.body);
    final receipt = ((answer as Map?) ?? const {}).cast<String, Object?>();
    // A revocation answers with a revocation result rather than a command
    // receipt, so the command's own identity is put back on it here: the
    // retained envelope is confirmed by its id, and that route never carried
    // one.
    return receipt.containsKey('commandId')
        ? receipt
        : {'commandId': command['commandId'], 'status': 'applied'};
  }

  /// Starts a hosted grant and sends the person to it in the system browser.
  /// The destination is checked before it is opened, so a tampered answer
  /// cannot send them somewhere else wearing our name.
  Future<Map<String, Object?>> _authorize(Map<String, Object?> command) async {
    final request = startConnectionRequestV1(command);
    final answer =
        ((await api.request(request.path, body: request.body) as Map?) ??
                const {})
            .cast<String, Object?>();
    final applied = {'commandId': command['commandId'], 'status': 'applied'};
    if (answer['status'] == 'ready') return applied;
    final url = answer['redirectUrl'];
    if (url is! String) throw const FormatException('No authorization door');
    final uri = Uri.parse(url);
    if (uri.scheme != 'https' || uri.host.isEmpty || uri.userInfo.isNotEmpty) {
      throw const FormatException('Invalid authorization destination');
    }
    final opened =
        await (openBrowser?.call(uri) ??
            launchUrl(uri, mode: LaunchMode.externalApplication));
    if (!opened) throw const FormatException('Browser unavailable');
    return applied;
  }

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }
}
