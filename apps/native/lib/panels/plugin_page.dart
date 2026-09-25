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
import 'dart:typed_data';

import 'package:flutter/foundation.dart' show defaultTargetPlatform, kIsWeb;
import 'package:flutter/material.dart';

import '../client/transport.dart' show randomId;
import '../shell/lifecycle.dart';
import '../shell/semantics.dart';
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

/// The page asks the host to open or close a device ability for it.
class PluginPageDeviceV1 extends PluginPageMessageV1 {
  final String ability;
  final bool open;
  const PluginPageDeviceV1(this.ability, this.open);
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
    case 'device':
      final open = message['open'];
      if (keys.join(',') != 'ability,frockbotPage,open,type' ||
          message['ability'] != 'microphone' ||
          open is! bool) {
        return null;
      }
      return PluginPageDeviceV1('microphone', open);
  }
  return null;
}

/// The rate and frame the host captures at for a page: 16 kHz mono PCM16 in
/// 40 ms frames, which is under two kilobytes a message in base64.
const pluginPageMicrophoneRateV1 = 16000;
const pluginPageMicrophoneFrameV1 = Duration(milliseconds: 40);

/// The microphone as a page gets it: opened by the host, never by the page.
abstract interface class PluginPageMicrophone {
  /// Opens it and answers the PCM16 frames, or throws
  /// [PluginPageMicrophoneRefused] with the sentence the page is told.
  /// [taken] runs when dictation or a call takes the microphone back.
  Future<Stream<Uint8List>> open({required Future<void> Function() taken});
  Future<void> close();
}

class PluginPageMicrophoneRefused implements Exception {
  final String reason;
  const PluginPageMicrophoneRefused(this.reason);
  @override
  String toString() => reason;
}

Map<String, Object?> pluginPageMicrophoneOpenMessageV1() => {
  'frockbotPage': pluginPageBridgeVersionV1,
  'type': 'device',
  'ability': 'microphone',
  'status': 'open',
  'sampleRate': pluginPageMicrophoneRateV1,
};

Map<String, Object?> pluginPageMicrophoneClosedMessageV1(String reason) => {
  'frockbotPage': pluginPageBridgeVersionV1,
  'type': 'device',
  'ability': 'microphone',
  'status': 'closed',
  'reason': reason,
};

Map<String, Object?> pluginPageAudioMessageV1(Uint8List pcm) => {
  'frockbotPage': pluginPageBridgeVersionV1,
  'type': 'audio',
  'pcm': base64Encode(pcm),
};

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
    case PluginPageDeviceV1():
      // The frame owns the device; it is never a request/answer exchange.
      return null;
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
  required VoidCallback onLoaded,
});

Widget _hostFrame(
  BuildContext context, {
  required String url,
  required String label,
  required String identity,
  required ValueChanged<Map<String, Object?>> onMessage,
  required Stream<Map<String, Object?>> outbox,
  required VoidCallback onLoaded,
}) => HostFrame(
  url: url,
  label: label,
  identity: identity,
  onMessage: onMessage,
  outbox: outbox,
  onLoaded: onLoaded,
  borderRadius: BorderRadius.zero,
);

/// What the page is told when it closed the microphone itself.
const pluginPageMicrophoneStoppedByPageV1 = 'You stopped the microphone.';

/// How the host ended a use of a device ability, as its audit row says it.
enum PluginPageDeviceEndingV1 { stopped, left, background, taken, failed }

/// One use of a device ability by a Plugin's page, once it has ended: the
/// host opened it, so the host is the one to say it happened (ADR 0036).
class PluginPageDeviceUseV1 {
  final String useId;
  final String ability;
  final DateTime startedAt;
  final DateTime endedAt;
  final PluginPageDeviceEndingV1 ending;
  const PluginPageDeviceUseV1({
    required this.useId,
    required this.ability,
    required this.startedAt,
    required this.endedAt,
    required this.ending,
  });
}

typedef PluginPageDeviceUseReporterV1 = void Function(PluginPageDeviceUseV1);

/// What kind of device this client is, as an audit row names it.
String pluginPageDeviceKindV1() =>
    kIsWeb ? 'web' : defaultTargetPlatform.name.toLowerCase();

class PluginPageFrame extends StatefulWidget {
  final String url;
  final Map<String, Object?> state;
  final String pluginId;
  final String botId;
  final String surfaceId;

  /// The tab's label: what the frame is called to a screen reader.
  final String label;
  final PluginPageToolRunnerV1 runTool;

  /// The device abilities the User approved for this Plugin's page.
  final List<String> abilities;

  /// Absent where this client cannot open one for a page.
  final PluginPageMicrophone? microphone;

  /// Told once each use has ended, whichever way it ended.
  final PluginPageDeviceUseReporterV1? onDeviceUse;
  final DateTime Function() now;
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
    this.abilities = const [],
    this.microphone,
    this.onDeviceUse,
    this.now = DateTime.now,
    this.frameBuilder = _hostFrame,
  });

  @override
  State<PluginPageFrame> createState() => _PluginPageFrameState();
}

class _PluginPageFrameState extends State<PluginPageFrame>
    with WidgetsBindingObserver {
  final _outbox = StreamController<Map<String, Object?>>.broadcast();
  bool _greeted = false;

  /// Set while the host holds the microphone for this page.
  StreamSubscription<Uint8List>? _hearing;
  bool _opening = false;
  bool _stoppedWhileOpening = false;

  /// The use in progress: its id and when it began.
  ({String useId, DateTime startedAt})? _use;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (appIsAwayV1(state)) {
      unawaited(
        _closeMicrophone(
          'FrockBot went to the background.',
          PluginPageDeviceEndingV1.background,
        ),
      );
    }
  }

  @override
  void didUpdateWidget(PluginPageFrame old) {
    super.didUpdateWidget(old);
    // A new URL is a new document, which will say hello again.
    if (old.url != widget.url) {
      _greeted = false;
      unawaited(_closeMicrophone(null, PluginPageDeviceEndingV1.left));
      return;
    }
    if (_greeted && jsonEncode(old.state) != jsonEncode(widget.state)) {
      _post(pluginPageStateMessageV1(widget.state));
    }
  }

  void _post(Map<String, Object?> message) {
    if (!_outbox.isClosed) _outbox.add(message);
  }

  Map<String, Object?> _init() => pluginPageInitMessageV1(
    pluginId: widget.pluginId,
    botId: widget.botId,
    surfaceId: widget.surfaceId,
    themeTokens: pluginPageThemeTokensV1(context),
    state: widget.state,
  );

  /// A page says `hello` while it is still parsing, before a WebView forwards
  /// anything it says, so the host greets each document once it has loaded
  /// rather than waiting to be asked (ADR 0036, amended 2026-09-25).
  void _loaded() {
    if (!mounted) return;
    _greeted = true;
    _post(_init());
  }

  Future<void> _onMessage(Map<String, Object?> raw) async {
    final message = decodePluginPageMessageV1(raw);
    if (message == null) return;
    if (message is PluginPageHelloV1) _greeted = true;
    if (message is PluginPageDeviceV1) {
      if (message.open) {
        _stoppedWhileOpening = false;
        await _openMicrophone();
      } else if (_opening) {
        // The page has already let go of an open still in flight.
        _stoppedWhileOpening = true;
      } else if (_hearing == null) {
        // Nothing to give back, but the page is still waiting to hear that
        // it closed.
        _post(
          pluginPageMicrophoneClosedMessageV1(
            pluginPageMicrophoneStoppedByPageV1,
          ),
        );
      } else {
        await _closeMicrophone(
          pluginPageMicrophoneStoppedByPageV1,
          PluginPageDeviceEndingV1.stopped,
        );
      }
      return;
    }
    final init = _init();
    final answer = await pluginPageAnswerV1(
      message,
      init: () => init,
      runTool: widget.runTool,
    );
    if (answer != null && mounted) _post(answer);
  }

  /// Only an ability the User approved on the Plugin's card, only through the
  /// host, and never twice.
  Future<void> _openMicrophone() async {
    if (_hearing != null || _opening) return;
    final microphone = widget.microphone;
    if (!widget.abilities.contains('microphone')) {
      _post(
        pluginPageMicrophoneClosedMessageV1(
          'This Plugin was not allowed the microphone.',
        ),
      );
      return;
    }
    if (microphone == null) {
      _post(
        pluginPageMicrophoneClosedMessageV1(
          'The microphone can’t be opened here.',
        ),
      );
      return;
    }
    _opening = true;
    _stoppedWhileOpening = false;
    try {
      final frames = await microphone.open(
        taken: () => _closeMicrophone(
          'Voice took the microphone.',
          PluginPageDeviceEndingV1.taken,
        ),
      );
      if (!mounted || _stoppedWhileOpening) {
        await microphone.close();
        return;
      }
      setState(() {
        _use = (useId: randomId(), startedAt: widget.now());
        _hearing = frames.listen(
          (pcm) => _post(pluginPageAudioMessageV1(pcm)),
          onError: (Object _) => unawaited(
            _closeMicrophone(
              'The microphone stopped working.',
              PluginPageDeviceEndingV1.failed,
            ),
          ),
        );
      });
      _post(pluginPageMicrophoneOpenMessageV1());
    } on PluginPageMicrophoneRefused catch (refused) {
      _post(pluginPageMicrophoneClosedMessageV1(refused.reason));
    } catch (_) {
      _post(
        pluginPageMicrophoneClosedMessageV1(
          'FrockBot couldn’t open the microphone.',
        ),
      );
    } finally {
      _opening = false;
    }
  }

  /// Gives the microphone back. [reason] is what the page is told; null when
  /// the page has gone and there is nobody to tell.
  Future<void> _closeMicrophone(
    String? reason,
    PluginPageDeviceEndingV1 ending,
  ) async {
    final hearing = _hearing;
    if (hearing == null) return;
    _hearing = null;
    _ended(ending);
    if (mounted) setState(() {});
    // Closing the microphone ends the stream; nothing waits on the cancel.
    unawaited(hearing.cancel());
    await widget.microphone?.close();
    if (reason != null) _post(pluginPageMicrophoneClosedMessageV1(reason));
  }

  /// Says a use happened, once, however it ended.
  void _ended(PluginPageDeviceEndingV1 ending) {
    final use = _use;
    _use = null;
    if (use == null) return;
    widget.onDeviceUse?.call(
      PluginPageDeviceUseV1(
        useId: use.useId,
        ability: 'microphone',
        startedAt: use.startedAt,
        endedAt: widget.now(),
        ending: ending,
      ),
    );
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    // Nobody is left to tell and nothing is left to redraw.
    final hearing = _hearing;
    _hearing = null;
    if (hearing != null) {
      _ended(PluginPageDeviceEndingV1.left);
      unawaited(hearing.cancel());
      unawaited(widget.microphone?.close() ?? Future<void>.value());
    }
    unawaited(_outbox.close());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final frame = widget.frameBuilder(
      context,
      url: widget.url,
      label: widget.label,
      identity:
          'plugin-page:${widget.pluginId}:${widget.surfaceId}:${widget.url}',
      onMessage: (message) => unawaited(_onMessage(message)),
      outbox: _outbox.stream,
      onLoaded: _loaded,
    );
    // One shape whether or not the bar is up, and the frame keyed, so the bar
    // coming and going never remounts the frame — which would load the page
    // again and lose it.
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_hearing != null)
          _MicrophoneInUse(
            label: widget.label,
            onStop: () => unawaited(
              _closeMicrophone(
                'You stopped the microphone.',
                PluginPageDeviceEndingV1.stopped,
              ),
            ),
          ),
        Expanded(key: const ValueKey('plugin-page-frame'), child: frame),
      ],
    );
  }
}

/// Host chrome, never the page's: who is listening, and the way to stop it.
class _MicrophoneInUse extends StatelessWidget {
  final String label;
  final VoidCallback onStop;
  const _MicrophoneInUse({required this.label, required this.onStop});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return identified(
      'plugin-page-microphone',
      Material(
        color: scheme.primaryContainer,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 4, 4, 4),
          child: Row(
            children: [
              Icon(Icons.mic, size: 18, color: scheme.onPrimaryContainer),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  '$label is using the microphone',
                  style: TextStyle(color: scheme.onPrimaryContainer),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              identified(
                'plugin-page-microphone-stop',
                TextButton(
                  onPressed: onStop,
                  style: TextButton.styleFrom(
                    foregroundColor: scheme.onPrimaryContainer,
                    textStyle: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                  child: const Text('Stop'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
