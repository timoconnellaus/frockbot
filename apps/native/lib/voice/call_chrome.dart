/// Compact call chrome in the conversation header: you, the wave, the Bot.
///
/// The thread and the composer stay. This row is the only extra furniture a
/// live call adds. Sizes at the top are the tweak knobs.
library;

import 'package:flutter/material.dart';

import '../flock/avatar.dart';
import '../shell/semantics.dart';
import 'assistant.dart';
import 'voice_mode.dart' show VoiceModeState, voiceModeStateOf, voiceModeWordOf;
import 'waveform.dart';

/// Circle the person's initials sit in.
const double voiceCallUserSize = 40;

/// The Bot's face in the pair. Smaller than the idle companion so the
/// thread still has a sky.
const double voiceCallBotSize = 48;

/// Five pills, user voice only, in the Bot's primary.
const double voiceCallWaveWidth = 88;
const double voiceCallWaveHeight = 28;

const double voiceCallChromeHeight = 52;
const double voiceCallHangUpSize = 36;

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
      _shown = _read();
    }
  }

  @override
  void dispose() {
    widget.session.removeListener(_changed);
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
        child: Row(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            identified(
              VoiceIds.callUser,
              _UserDot(
                initials: widget.userInitials,
                imageUrl: widget.userImageUrl,
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
                      child: VoiceWaveform(
                        source: widget.session,
                        microphone: () =>
                            widget.session.muted ? 0 : widget.session.micLevel,
                        // User-only: the Bot's mouth is the face, not the wave.
                        playback: () => 0,
                        mode: () => widget.session.meterMode,
                        enabled: widget.session.active,
                      ),
                    ),
                  ),
                  identified(
                    VoiceIds.callState,
                    Semantics(
                      liveRegion: true,
                      child: Text(
                        word,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
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
                ],
              ),
            ),
            const SizedBox(width: 10),
            identified(
              VoiceIds.callBot,
              CharacterAvatar(
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
            const SizedBox(width: 6),
            identified(
              VoiceIds.hangUp,
              Tooltip(
                message: 'End the call',
                child: IconButton(
                  onPressed: widget.onEnd,
                  tooltip: 'End the call',
                  icon: const Icon(Icons.call_end_rounded),
                  iconSize: 18,
                  style: IconButton.styleFrom(
                    foregroundColor: theme.colorScheme.primary,
                    minimumSize: const Size.square(voiceCallHangUpSize),
                    maximumSize: const Size.square(voiceCallHangUpSize),
                    fixedSize: const Size.square(voiceCallHangUpSize),
                    padding: EdgeInsets.zero,
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                ),
              ),
            ),
          ],
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
