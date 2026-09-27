/// The live call, as a card at the top of the chat: the Bot, the wave, you,
/// then mute and hang-up.
///
/// The header keeps the companion and the name. This card is the only extra
/// furniture a live call adds, and the thread and the composer stay. Every
/// in-call state uses the same card: connecting, listening, talking, the Bot
/// speaking, thinking, paused, muted, sleeping, failed. The word under the
/// strip changes; the box does not.
library;

import 'package:flutter/material.dart';

import '../flock/avatar.dart';
import '../shell/person_avatar.dart';
import '../shell/semantics.dart';
import '../theme/frock_theme.dart';
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

const double voiceCallHangUpSize = 36;

/// The first row: Bot, gaps, strip, you. Mute and hang-up sit on the row
/// under it and do not widen the card.
const double voiceCallRowWidth =
    voiceCallBotSize + 10 + voiceCallWaveWidth + 10 + voiceCallUserSize;

const double voiceCallCardPaddingH = 14;

/// The card at its designed width. Connecting through hang-up all use this
/// box. It does not grow when the word under the strip changes.
const double voiceCallClusterWidth =
    voiceCallRowWidth + voiceCallCardPaddingH * 2;

/// Top padding, the Bot, the control row, and the bottom padding.
const double voiceCallChromeHeight =
    12 + voiceCallBotSize + voiceCallHangUpSize + 4;

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
    final scheme = theme.colorScheme;
    final word = voiceCallWordOf(_shown.state, _shown.mode);
    final muted = widget.session.muted;
    return identified(
      VoiceIds.callChrome,
      Material(
        color: scheme.surfaceContainerHighest,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(FrockTheme.radiusCard),
          side: BorderSide(color: FrockTheme.hairline(scheme)),
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            voiceCallCardPaddingH,
            12,
            voiceCallCardPaddingH,
            4,
          ),
          child: SizedBox(
            width: voiceCallRowWidth,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
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
                      width: voiceCallWaveWidth,
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          identified(
                            VoiceIds.callWave,
                            SizedBox(
                              height: voiceCallWaveHeight,
                              width: voiceCallWaveWidth,
                              child: DictationWaveform(
                                level: _mic,
                                capturing:
                                    widget.session.active &&
                                    !widget.session.paused,
                              ),
                            ),
                          ),
                          identified(
                            VoiceIds.callState,
                            Semantics(
                              liveRegion: true,
                              child: SizedBox(
                                width: voiceCallWaveWidth,
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
                                        ? scheme.error
                                        : scheme.onSurfaceVariant,
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
                      PersonAvatar(
                        name: widget.userInitials,
                        imageUrl: widget.userImageUrl,
                        size: voiceCallUserSize,
                        semanticsLabel: 'You on the call',
                      ),
                    ),
                  ],
                ),
                Row(
                  children: [
                    identified(
                      VoiceIds.mute,
                      _control(
                        tooltip: muted
                            ? 'Unmute microphone'
                            : 'Mute microphone',
                        icon: muted
                            ? Icons.mic_off_rounded
                            : Icons.mic_none_rounded,
                        color: scheme.onSurface,
                        onPressed: () =>
                            widget.session.setMuted(!widget.session.userMuted),
                      ),
                    ),
                    const Spacer(),
                    identified(
                      VoiceIds.hangUp,
                      _control(
                        tooltip: 'End the call',
                        icon: Icons.call_end_rounded,
                        color: scheme.primary,
                        onPressed: widget.onEnd,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _control({
    required String tooltip,
    required IconData icon,
    required Color color,
    required VoidCallback onPressed,
  }) {
    return SizedBox.square(
      dimension: voiceCallHangUpSize,
      child: Tooltip(
        message: tooltip,
        child: IconButton(
          onPressed: onPressed,
          tooltip: tooltip,
          icon: Icon(icon),
          iconSize: 18,
          style: IconButton.styleFrom(
            foregroundColor: color,
            visualDensity: VisualDensity.standard,
            minimumSize: const Size.square(voiceCallHangUpSize),
            maximumSize: const Size.square(voiceCallHangUpSize),
            fixedSize: const Size.square(voiceCallHangUpSize),
            padding: EdgeInsets.zero,
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
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
