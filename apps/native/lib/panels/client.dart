/// The client half of the conversation-panel routes (ADR 0034).
library;

import '../client/transport.dart';
import '../plugins/page.dart' show pluginToolReceiptV1;
import '../protocol/client_wire.generated.dart' as wire;
import 'plugin_page.dart' show PluginPageToolAnswerV1;

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

  /// One of a page's own tool calls. Unlike a control's press, the page is
  /// owed the tool's text, so the receipt is read rather than summarised.
  Future<PluginPageToolAnswerV1> runPageTool(
    String botId, {
    required String pluginId,
    required String tool,
    required String arguments,
  }) async {
    try {
      final answer = await api.request(
        '/api/bots/${Uri.encodeComponent(botId)}/plugins',
        body: {
          'schemaVersion': 1,
          'kind': 'plugin-tool',
          'commandId': randomId(),
          'pluginId': pluginId,
          'tool': tool,
          'arguments': arguments,
        },
      );
      final receipt = ((answer as Map?) ?? const {}).cast<String, Object?>();
      final content = receipt['content'];
      if (receipt['status'] == 'ran' && content is String) {
        return receipt['isError'] == true
            ? PluginPageToolAnswerV1.refused(content)
            : PluginPageToolAnswerV1.ran(content);
      }
      final failure = receipt['failure'];
      return PluginPageToolAnswerV1.refused(
        failure is String ? failure : 'This tool could not run.',
      );
    } on RequestFailure catch (failure) {
      return PluginPageToolAnswerV1.refused(failure.message);
    }
  }
}
