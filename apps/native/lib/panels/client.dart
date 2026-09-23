/// The client half of the conversation-panel routes (ADR 0034).
library;

import '../client/transport.dart';
import '../plugins/page.dart' show pluginToolReceiptV1;
import '../protocol/client_wire.generated.dart' as wire;

class PanelsApi {
  final NativeApi api;
  const PanelsApi(this.api);

  Future<wire.PanelOpenView> open(String botId) async {
    return wire.PanelOpenView.fromJson(
      await api.request('/api/bots/${Uri.encodeComponent(botId)}/panels/open'),
    );
  }

  Future<void> setFocus(
    String botId, {
    required String? pluginId,
    String? surfaceId,
  }) async {
    await api.request(
      '/api/bots/${Uri.encodeComponent(botId)}/panels/focus',
      body: {'schemaVersion': 1, 'pluginId': pluginId, 'surfaceId': ?surfaceId},
    );
  }

  Future<Map<String, Object?>> runTool(
    String botId,
    Map<String, Object?> command,
  ) async {
    final answer = await api.request(
      '/api/bots/${Uri.encodeComponent(botId)}/plugins',
      body: command,
    );
    return pluginToolReceiptV1(command['commandId'], answer);
  }
}
