/// Compact call chrome in the conversation header: the Bot, the wave, you.
///
/// The thread and the composer stay. This row is the only extra furniture a
/// live call adds. Every in-call state uses the same cluster: connecting,
/// listening, talking, the Bot speaking, thinking, paused, muted, sleeping,
/// failed. The word under the strip changes; the box does not.
library;

import 'package:flutter/material.dart';

import '../flock/avatar.dart';
import '../shell/semantics.dart';
import 'assistant.dart';
import 'voice_mode.dart' show VoiceModeState, voiceModeStateOf;
import 'waveform.dart';

/// Circle the person's initials sit in.
const double voiceCallUserSize = 40;

/// The Bot's face in the pair. Smaller than the idle companion so the
/// thread still has a sky.
const double voiceCallBotSize = 48;

/// Same strip dictation uses: 4px bars, 2px gap, 26px tall.
const double voiceCallWaveHeight = 26;

/// Cap on the dictation strip. Same in every in-call state so the cluster
/// does not grow when the word under it changes, or when the header is wide.
const double voiceCallWaveWidth = 96;

/// Floor when the header is too narrow for the cap (a 320-wide phone
/// with Back and Computer). Still enough bars to read as a strip.
const double voiceCallWaveMinWidth = 32;

const double voiceCallHangUpSize = 36;

/// Everything besides the strip: user, gaps, Bot, hang-up.
const double voiceCallFixedWidth =
    voiceCallUserSize + 10 + 10 + voiceCallBotSize + 6 + voiceCallHangUpSize;

/// The cluster at its designed width. Connecting through hang-up all use
/// this box. The header may squeeze the strip below [voiceCallWaveWidth]
/// on a narrow phone; it never grows past this.
const double voiceCallClusterWidth = voiceCallFixedWidth + voiceCallWaveWidth;

const double voiceCallChromeHeight = 52;

/// Initials from a display name or a user id: first letter of the first
/// two tokens, the way [FrockAvatarView] does it.
String voiceUserInitials(String name) {
  final words = name
      .trim()
      .split(RegExp(r'[\s@._-]+'))
      .where((word) => word.isNotEmpty)
      .take(2);
  final letters = words.map((word) => word[0].toUpperCase()).join();
  return letters.isEmpty ? '?' : letters;
}

String voiceCallWordOf(VoiceModeState state, VoiceMeterMode mode) {
  if (state == VoiceModeState.failed) return 'Failed';
  if (state == VoiceModeState.ended) return 'Ended';
  if (state == VoiceModeState.paused) return 'Paused';
  return switch (mode) {
    VoiceMeterMode.connecting => 'Connecting',
    VoiceMeterMode.thinking => 'Thinking',
    VoiceMeterMode.asleep => 'Sleeping',
    VoiceMeterMode.muted => 'Muted',
    VoiceMeterMode.speaking => 'Listening',
    VoiceMeterMode.listening => 'Listening',
    VoiceMeterMode.resting => 'Listening',
  };
}

/// The pair that replaces the idle companion while this Bot is on a call.
class VoiceCallChrome extends StatefulWidget {
  final AssistantSessionController session;
  final String userInitials;
  final String? userImageUrl;
  final String botName;
  final String? characterId;
  final String? primary;
  final VoidCallback onEnd;
  const VoiceCallChrome({
    super.key,
    required this.session,
    required this.userInitials,
    required this.botName,
    required this.onEnd,
    this.userImageUrl,
    this.characterId,
    this.primary,
  });

  @override
  State<VoiceCallChrome> createState() => _VoiceCallChromeState();
}

class _VoiceCallChromeState extends State<VoiceCallChrome> {
  late _Shown _shown = _read();
  late final _MicLevel _mic = _MicLevel(widget.session);

  _Shown _read() => (
    state: voiceModeStateOf(widget.session),
    mode: widget.session.meterMode,
    speaking: widget.session.meterMode == VoiceMeterMode.speaking,
  );

  void _changed() {
    final next = _read();
    if (_shown == next) return;
    setState(() => _shown = next);
  }

  @override
  void initState() {
    super.initState();
    widget.session.addListener(_changed);
  }

  @override
  void didUpdateWidget(VoiceCallChrome old) {
    super.didUpdateWidget(old);
    if (old.session != widget.session) {
      old.session.removeListener(_changed);
      widget.session.addListener(_changed);
      _mic.attach(widget.session);
      _shown = _read();
    }
  }

  @override
  void dispose() {
    widget.session.removeListener(_changed);
    _mic.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final word = voiceCallWordOf(_shown.state, _shown.mode);
    return identified(
      VoiceIds.callChrome,
      SizedBox(
        height: voiceCallChromeHeight,
        child: LayoutBuilder(
          builder: (context, constraints) {
            final cap = constraints.maxWidth;
            final waveWidth = !cap.isFinite
                ? voiceCallWaveWidth
                : (cap - voiceCallFixedWidth).clamp(
                    voiceCallWaveMinWidth,
                    voiceCallWaveWidth,
                  );
            return Row(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                identified(
                  VoiceIds.callBot,
                  SizedBox.square(
                    dimension: voiceCallBotSize,
                    child: Center(
                      child: CharacterAvatar(
                        size: voiceCallBotSize,
                        characterId: widget.characterId,
                        primary: widget.primary,
                        cropToInk: true,
                        motion: CharacterMotion.quiet,
                        activity: _shown.speaking
                            ? CharacterActivity.thinking
                            : CharacterActivity.idle,
                        semanticsLabel: '${widget.botName} on the call',
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                SizedBox(
                  width: waveWidth,
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      identified(
                        VoiceIds.callWave,
                        SizedBox(
                          height: voiceCallWaveHeight,
                          width: waveWidth,
                          child: DictationWaveform(
                            level: _mic,
                            capturing:
                                widget.session.active && !widget.session.paused,
                          ),
                        ),
                      ),
                      identified(
                        VoiceIds.callState,
                        Semantics(
                          liveRegion: true,
                          child: SizedBox(
                            width: waveWidth,
                            child: Text(
                              word,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              textAlign: TextAlign.center,
                              style: theme.textTheme.labelSmall?.copyWith(
                                fontSize: 12,
                                height: 1.2,
                                fontWeight: FontWeight.w500,
                                color: _shown.state == VoiceModeState.failed
                                    ? theme.colorScheme.error
                                    : theme.colorScheme.onSurfaceVariant,
                              ),
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 10),
                identified(
                  VoiceIds.callUser,
                  _UserDot(
                    initials: widget.userInitials,
                    imageUrl: widget.userImageUrl,
                  ),
                ),
                const SizedBox(width: 6),
                identified(
                  VoiceIds.hangUp,
                  SizedBox.square(
                    dimension: voiceCallHangUpSize,
                    child: Tooltip(
                      message: 'End the call',
                      child: IconButton(
                        onPressed: widget.onEnd,
                        tooltip: 'End the call',
                        icon: const Icon(Icons.call_end_rounded),
                        iconSize: 18,
                        style: IconButton.styleFrom(
                          foregroundColor: theme.colorScheme.primary,
                          visualDensity: VisualDensity.standard,
                          minimumSize: const Size.square(voiceCallHangUpSize),
                          maximumSize: const Size.square(voiceCallHangUpSize),
                          fixedSize: const Size.square(voiceCallHangUpSize),
                          padding: EdgeInsets.zero,
                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _UserDot extends StatelessWidget {
  final String initials;
  final String? imageUrl;
  const _UserDot({required this.initials, this.imageUrl});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final letters = voiceUserInitials(initials);
    final fill = theme.colorScheme.surfaceContainerHighest;
    return Semantics(
      label: 'You on the call',
      child: ClipOval(
        child: Container(
          width: voiceCallUserSize,
          height: voiceCallUserSize,
          color: fill,
          alignment: Alignment.center,
          child: imageUrl == null
              ? Text(
                  letters,
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: theme.colorScheme.onSurface,
                    fontWeight: FontWeight.w600,
                  ),
                )
              : Image.network(
                  imageUrl!,
                  width: voiceCallUserSize,
                  height: voiceCallUserSize,
                  fit: BoxFit.cover,
                  errorBuilder: (context, error, stack) => Text(
                    letters,
                    style: theme.textTheme.labelMedium?.copyWith(
                      color: theme.colorScheme.onSurface,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
        ),
      ),
    );
  }
}

typedef _Shown = ({VoiceModeState state, VoiceMeterMode mode, bool speaking});

/// The session's microphone as a [ValueListenable], which is what the
/// dictation strip reads. Level is zero when the call is muted or down.
class _MicLevel extends ValueNotifier<double> {
  _MicLevel(this._session) : super(_read(_session)) {
    _session.addListener(_sync);
  }

  AssistantSessionController _session;

  static double _read(AssistantSessionController session) =>
      session.muted || !session.active ? 0 : session.micLevel;

  void attach(AssistantSessionController session) {
    if (identical(_session, session)) return;
    _session.removeListener(_sync);
    _session = session;
    _session.addListener(_sync);
    _sync();
  }

  void _sync() => value = _read(_session);

  @override
  void dispose() {
    _session.removeListener(_sync);
    super.dispose();
  }
}
