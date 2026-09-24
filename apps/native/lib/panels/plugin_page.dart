/// A Plugin's own page in the conversation panel (ADR 0036).
///
/// The page is untrusted code in the host's sandboxed frame. It holds no
/// credential and speaks only the bridge below: it says `hello`, the host
/// answers with who it is and its state, and every tool call it makes is
/// made by the host, on the person's session, for this Plugin's own tools.
/// The bridge the page speaks is `core/contracts/plugin-page.ts`, injected at
/// publish; these are the host's halves of the same messages.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';

import '../theme/frock_theme.dart';
import '../view/host_frame.dart';

const pluginPageBridgeVersionV1 = 1;

/// The most a page may hand one tool call, as the `plugin-tool` command caps it.
const pluginPageArgumentsMaxBytesV1 = 8000;

final _callIdV1 = RegExp(r'^[A-Za-z0-9_-]{1,64}$');
final _toolNameV1 = RegExp(r'^[a-z][a-z0-9_]{0,63}$');

sealed class PluginPageMessageV1 {
  const PluginPageMessageV1();
}

class PluginPageHelloV1 extends PluginPageMessageV1 {
  const PluginPageHelloV1();
}

class PluginPageCallV1 extends PluginPageMessageV1 {
  final String callId;
  final String tool;
  final Map<String, Object?> input;
  const PluginPageCallV1(this.callId, this.tool, this.input);
}

/// What the page said, decoded exactly, or null for anything else: a message
/// with an extra key, the wrong version, or a type the host does not answer.
PluginPageMessageV1? decodePluginPageMessageV1(Map<String, Object?> message) {
  if (message['frockbotPage'] != pluginPageBridgeVersionV1) return null;
  final keys = message.keys.toList()..sort();
  switch (message['type']) {
    case 'hello':
      return keys.join(',') == 'frockbotPage,type'
          ? const PluginPageHelloV1()
          : null;
    case 'callTool':
      final callId = message['callId'];
      final tool = message['tool'];
      final input = message['input'];
      if (keys.join(',') != 'callId,frockbotPage,input,tool,type' ||
          callId is! String ||
          !_callIdV1.hasMatch(callId) ||
          tool is! String ||
          !_toolNameV1.hasMatch(tool) ||
          input is! Map) {
        return null;
      }
      return PluginPageCallV1(callId, tool, input.cast<String, Object?>());
  }
  return null;
}

/// What one tool call came to: its text, or the reason it did not run.
class PluginPageToolAnswerV1 {
  final bool ok;
  final String text;
  const PluginPageToolAnswerV1.ran(this.text) : ok = true;
  const PluginPageToolAnswerV1.refused(this.text) : ok = false;
}

typedef PluginPageToolRunnerV1 = Future<PluginPageToolAnswerV1> Function(
  String tool,
  String arguments,
);

Map<String, Object?> pluginPageInitMessageV1({
  required String pluginId,
  required String botId,
  required String surfaceId,
  required Map<String, String> themeTokens,
  required Map<String, Object?> state,
}) => {
  'frockbotPage': pluginPageBridgeVersionV1,
  'type': 'init',
  'pluginId': pluginId,
  'botId': botId,
  'surfaceId': surfaceId,
  'themeTokens': themeTokens,
  'state': state,
};

Map<String, Object?> pluginPageStateMessageV1(Map<String, Object?> state) => {
  'frockbotPage': pluginPageBridgeVersionV1,
  'type': 'state',
  'state': state,
};

Map<String, Object?> pluginPageResultMessageV1(
  String callId,
  PluginPageToolAnswerV1 answer,
) => {
  'frockbotPage': pluginPageBridgeVersionV1,
  'type': 'result',
  'callId': callId,
  'ok': answer.ok,
  if (answer.ok) 'output': answer.text else 'error': answer.text,
};

/// The host's answer to one page message, or null when it says nothing back.
/// A call whose input is past the command's cap is refused without running.
Future<Map<String, Object?>?> pluginPageAnswerV1(
  PluginPageMessageV1 message, {
  required Map<String, Object?> Function() init,
  required PluginPageToolRunnerV1 runTool,
}) async {
  switch (message) {
    case PluginPageHelloV1():
      return init();
    case PluginPageCallV1(:final callId, :final tool, :final input):
      final arguments = jsonEncode(input);
      if (utf8.encode(arguments).length > pluginPageArgumentsMaxBytesV1) {
        return pluginPageResultMessageV1(
          callId,
          const PluginPageToolAnswerV1.refused(
            'This call’s input is larger than 8000 bytes.',
          ),
        );
      }
      PluginPageToolAnswerV1 answer;
      try {
        answer = await runTool(tool, arguments);
      } catch (_) {
        answer = const PluginPageToolAnswerV1.refused('That didn’t work.');
      }
      return pluginPageResultMessageV1(callId, answer);
  }
}

/// The host's design tokens, as the CSS values a page is handed: semantic
/// names, never the shell's own styles, so a page written against them is
/// themed identically in light and dark and on every client.
Map<String, String> pluginPageThemeTokensV1(BuildContext context) {
  final scheme = Theme.of(context).colorScheme;
  String hex(Color colour) =>
      // ignore: deprecated_member_use -- `toARGB32` is not in the pinned SDK.
      '#${colour.value.toRadixString(16).padLeft(8, '0').substring(2)}';
  return {
    'surface': hex(scheme.surface),
    'surface-raised': hex(scheme.surfaceContainerHighest),
    'text': hex(scheme.onSurface),
    'text-muted': hex(scheme.onSurfaceVariant),
    'border': hex(scheme.outlineVariant),
    'border-strong': hex(scheme.outline),
    'accent': hex(scheme.primary),
    'accent-surface': hex(scheme.primaryContainer),
    'on-accent': hex(scheme.onPrimary),
    'danger': hex(scheme.error),
    'radius-control': '${FrockTheme.radiusControl.toInt()}px',
    'radius-card': '${FrockTheme.radiusCard.toInt()}px',
    'font-sans': 'Inter, ui-sans-serif, system-ui, sans-serif',
    'font-mono': 'ui-monospace, SFMono-Regular, Menlo, monospace',
    'text-sm': '13px',
    'text-base': '14px',
    'text-lg': '17px',
    'motion-fast': '${FrockTheme.fast.inMilliseconds}ms',
  };
}

typedef PluginPageFrameBuilderV1 = Widget Function(
  BuildContext context, {
  required String url,
  required String label,
  required String identity,
  required ValueChanged<Map<String, Object?>> onMessage,
  required Stream<Map<String, Object?>> outbox,
});

Widget _hostFrame(
  BuildContext context, {
  required String url,
  required String label,
  required String identity,
  required ValueChanged<Map<String, Object?>> onMessage,
  required Stream<Map<String, Object?>> outbox,
}) => HostFrame(
  url: url,
  label: label,
  identity: identity,
  onMessage: onMessage,
  outbox: outbox,
  borderRadius: BorderRadius.zero,
);

class PluginPageFrame extends StatefulWidget {
  final String url;
  final Map<String, Object?> state;
  final String pluginId;
  final String botId;
  final String surfaceId;

  /// The tab's label: what the frame is called to a screen reader.
  final String label;
  final PluginPageToolRunnerV1 runTool;
  final PluginPageFrameBuilderV1 frameBuilder;
  const PluginPageFrame({
    super.key,
    required this.url,
    required this.state,
    required this.pluginId,
    required this.botId,
    required this.surfaceId,
    required this.label,
    required this.runTool,
    this.frameBuilder = _hostFrame,
  });

  @override
  State<PluginPageFrame> createState() => _PluginPageFrameState();
}

class _PluginPageFrameState extends State<PluginPageFrame> {
  final _outbox = StreamController<Map<String, Object?>>.broadcast();
  bool _greeted = false;

  @override
  void didUpdateWidget(PluginPageFrame old) {
    super.didUpdateWidget(old);
    // A new URL is a new document, which will say hello again.
    if (old.url != widget.url) {
      _greeted = false;
      return;
    }
    if (_greeted && jsonEncode(old.state) != jsonEncode(widget.state)) {
      _post(pluginPageStateMessageV1(widget.state));
    }
  }

  void _post(Map<String, Object?> message) {
    if (!_outbox.isClosed) _outbox.add(message);
  }

  Future<void> _onMessage(Map<String, Object?> raw) async {
    final message = decodePluginPageMessageV1(raw);
    if (message == null) return;
    if (message is PluginPageHelloV1) _greeted = true;
    final themeTokens = pluginPageThemeTokensV1(context);
    final answer = await pluginPageAnswerV1(
      message,
      init: () => pluginPageInitMessageV1(
        pluginId: widget.pluginId,
        botId: widget.botId,
        surfaceId: widget.surfaceId,
        themeTokens: themeTokens,
        state: widget.state,
      ),
      runTool: widget.runTool,
    );
    if (answer != null && mounted) _post(answer);
  }

  @override
  void dispose() {
    unawaited(_outbox.close());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return widget.frameBuilder(
      context,
      url: widget.url,
      label: widget.label,
      identity:
          'plugin-page:${widget.pluginId}:${widget.surfaceId}:${widget.url}',
      onMessage: (message) => unawaited(_onMessage(message)),
      outbox: _outbox.stream,
    );
  }
}
