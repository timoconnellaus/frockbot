/// Voice mode: the Bot on the call, where its thread would be (ADR 0031).
///
/// A call does not share the thread, so nothing is overlaid: while the call
/// is with the Bot on screen, this surface *is* the conversation area — the
/// transcript and the composer are not drawn at all. There are no captions
/// here for the same reason. What a call leaves behind is the work it
/// started, which is why the one thing this surface lists is the subagents.
///
/// Every band has a fixed height, and that is the layout's whole rule: the
/// character, the name and the word under it must not move a pixel when the
/// state changes or a chip appears, because a face that jumps as it starts
/// speaking reads as a glitch rather than as an answer.
library;

import 'package:flutter/material.dart';

import '../flock/avatar.dart';
import '../shell/semantics.dart';
import '../theme/frock_theme.dart';
import 'assistant.dart';
import 'waveform.dart';

/// The ring around the character, and the character inside it.
const double voiceModeRingSize = 168;
const double voiceModeAvatarSize = 136;

/// The activity slot: fixed, so an arriving chip moves nothing above it.
const double voiceModeActivityPhone = 132;
const double voiceModeActivityWide = 64;

/// The space above the character, and between it and the slot.
const double voiceModeTopSpace = 44;
const double voiceModeStageGap = 32;

/// The stage's own bands, fixed for the same reason.
const double voiceModeNameHeight = 34;
const double voiceModeStateHeight = 22;

/// The quiet circles at either end of the bottom bar.
const double voiceModeControlSize = 52;
const double voiceModeBarHeight = 84;

/// Below this the slot is a column of chips rather than one row.
const double voiceModeWideWidth = 700;

/// Which word the surface says, and which dot it wears.
enum VoiceModeState { listening, speaking, paused }

VoiceModeState voiceModeStateOf(AssistantSessionController session) {
  if (session.paused) return VoiceModeState.paused;
  return session.meterMode == VoiceMeterMode.speaking
      ? VoiceModeState.speaking
      : VoiceModeState.listening;
}

String voiceModeWordOf(VoiceModeState state) => switch (state) {
  VoiceModeState.listening => 'Listening',
  VoiceModeState.speaking => 'Speaking',
  VoiceModeState.paused => 'Paused',
};

class VoiceMode extends StatefulWidget {
  final AssistantSessionController session;
  final String botName;
  final String? characterId;
  final String? primary;

  /// Ends the call. The one way out of voice mode (ADR 0029).
  final VoidCallback onEnd;

  /// Opens the Work a finished subagent left behind, on that Bot.
  final void Function(String botId, String runId)? onOpenWork;
  const VoiceMode({
    super.key,
    required this.session,
    required this.botName,
    required this.onEnd,
    this.characterId,
    this.primary,
    this.onOpenWork,
  });

  @override
  State<VoiceMode> createState() => _VoiceModeState();
}

class _VoiceModeState extends State<VoiceMode> {
  late _Presentation _shown = _read();

  _Presentation _read() => (
    state: voiceModeStateOf(widget.session),
    paused: widget.session.paused,
    badge: widget.session.finishedWhilePaused,
    chips: [
      for (final entry in widget.session.delegations)
        (
          id: entry.botId,
          runId: entry.runId,
          name: entry.botName,
          finished: entry.finished,
        ),
    ],
  );

  void _changed() {
    final next = _read();
    if (_same(_shown, next)) return;
    setState(() => _shown = next);
  }

  static bool _same(_Presentation a, _Presentation b) {
    if (a.state != b.state || a.paused != b.paused || a.badge != b.badge) {
      return false;
    }
    if (a.chips.length != b.chips.length) return false;
    for (var i = 0; i < a.chips.length; i++) {
      if (a.chips[i] != b.chips[i]) return false;
    }
    return true;
  }

  @override
  void initState() {
    super.initState();
    widget.session.addListener(_changed);
  }

  @override
  void didUpdateWidget(VoiceMode old) {
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
    final scheme = Theme.of(context).colorScheme;
    return identified(
      VoiceIds.mode,
      ColoredBox(
        color: scheme.surface,
        child: SafeArea(
          top: false,
          child: LayoutBuilder(
            builder: (context, constraints) {
              final wide = constraints.maxWidth >= voiceModeWideWidth;
              return Column(
                children: [
                  const SizedBox(height: voiceModeTopSpace),
                  _stage(context),
                  const SizedBox(height: voiceModeStageGap),
                  SizedBox(
                    height: wide
                        ? voiceModeActivityWide
                        : voiceModeActivityPhone,
                    child: _activity(context, wide: wide),
                  ),
                  const Spacer(),
                  SizedBox(height: voiceModeBarHeight, child: _bar(context)),
                ],
              );
            },
          ),
        ),
      ),
    );
  }

  /// The character, the name and the one word: one fixed block, whatever the
  /// state is.
  Widget _stage(BuildContext context) {
    final theme = Theme.of(context);
    final speaking = _shown.state == VoiceModeState.speaking;
    final paused = _shown.state == VoiceModeState.paused;
    return identified(
      VoiceIds.stage,
      Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(
            width: voiceModeRingSize,
            height: voiceModeRingSize,
            child: AnimatedContainer(
              duration: FrockTheme.motion(context, FrockTheme.enter),
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(
                  width: 2,
                  color: speaking
                      ? theme.colorScheme.primary.withValues(alpha: 0.55)
                      : FrockTheme.hairline(theme.colorScheme),
                ),
              ),
              child: Center(
                child: AnimatedOpacity(
                  duration: FrockTheme.motion(context, FrockTheme.fast),
                  opacity: paused ? 0.55 : 1,
                  child: CharacterAvatar(
                    size: voiceModeAvatarSize,
                    characterId: widget.characterId,
                    primary: widget.primary,
                    // Nothing is being drawn for the sake of motion: the
                    // artboard rests while the person talks and stirs while
                    // the Bot does.
                    motion: paused
                        ? CharacterMotion.still
                        : CharacterMotion.quiet,
                    activity: speaking
                        ? CharacterActivity.thinking
                        : CharacterActivity.idle,
                    semanticsLabel: '${widget.botName} on the call',
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(height: 18),
          SizedBox(
            height: voiceModeNameHeight,
            child: Center(
              child: Text(
                widget.botName,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.titleLarge?.copyWith(
                  fontSize: 24,
                  fontWeight: FontWeight.w600,
                  letterSpacing: -0.4,
                ),
              ),
            ),
          ),
          SizedBox(
            height: voiceModeStateHeight,
            child: identified(
              VoiceIds.state,
              Semantics(
                liveRegion: true,
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(
                      width: 7,
                      height: 7,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: switch (_shown.state) {
                          VoiceModeState.speaking => theme.colorScheme.primary,
                          VoiceModeState.listening =>
                            theme.colorScheme.onSurfaceVariant,
                          VoiceModeState.paused =>
                            theme.colorScheme.onSurfaceVariant.withValues(
                              alpha: 0.4,
                            ),
                        },
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      voiceModeWordOf(_shown.state),
                      style: theme.textTheme.bodyMedium?.copyWith(
                        fontSize: 13.5,
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// What the call has handed off. An empty slot stays empty: a placeholder
  /// sentence about work nobody asked for is noise.
  Widget _activity(BuildContext context, {required bool wide}) {
    final chips = _shown.chips;
    return identified(
      VoiceIds.activity,
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20),
        child: chips.isEmpty
            ? const SizedBox.expand()
            : wide
            ? Align(
                alignment: Alignment.topCenter,
                child: SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      for (final chip in chips) ...[
                        SizedBox(width: 280, child: _chip(context, chip)),
                        const SizedBox(width: 10),
                      ],
                    ],
                  ),
                ),
              )
            : ListView.separated(
                padding: EdgeInsets.zero,
                itemCount: chips.length,
                separatorBuilder: (_, _) => const SizedBox(height: 8),
                itemBuilder: (context, index) => _chip(context, chips[index]),
              ),
      ),
    );
  }

  Widget _chip(BuildContext context, _Chip chip) {
    final theme = Theme.of(context);
    final open = widget.onOpenWork;
    return identified(
      VoiceIds.chip(chip.id),
      Container(
        height: 56,
        padding: const EdgeInsets.fromLTRB(14, 0, 8, 0),
        decoration: BoxDecoration(
          color: theme.colorScheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(FrockTheme.radiusCard),
          border: Border.all(color: FrockTheme.hairline(theme.colorScheme)),
        ),
        child: Row(
          children: [
            if (chip.finished) ...[
              const Icon(
                Icons.check_rounded,
                size: 18,
                color: Color(0xff4fbf7a),
              ),
              const SizedBox(width: 8),
            ],
            Expanded(
              child: Text(
                chip.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodyMedium?.copyWith(
                  fontSize: 14,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ),
            const SizedBox(width: 10),
            if (!chip.finished)
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: Text(
                  'Working',
                  style: theme.textTheme.bodySmall?.copyWith(
                    fontSize: 12.5,
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              )
            else if (open != null)
              TextButton(
                onPressed: () => open(chip.id, chip.runId),
                style: TextButton.styleFrom(
                  minimumSize: const Size(0, 44),
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      'Work',
                      style: theme.textTheme.labelMedium?.copyWith(
                        color: theme.colorScheme.primary,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    Icon(
                      Icons.chevron_right_rounded,
                      size: 16,
                      color: theme.colorScheme.primary,
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }

  /// Pause, the meter, End — or, paused, Resume and End. No composer: there
  /// is no thread here to write into.
  Widget _bar(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(20, 12, 20, 20),
    child: _shown.paused
        ? Row(
            children: [
              Expanded(child: _resume(context)),
              const SizedBox(width: 12),
              _end(context),
            ],
          )
        : Row(
            children: [
              identified(
                VoiceIds.pause,
                _circle(
                  context,
                  label: 'Pause the call',
                  icon: Icons.pause_rounded,
                  onPressed: widget.session.pause,
                ),
              ),
              Expanded(
                child: identified(
                  VoiceIds.modeMeter,
                  SizedBox(
                    height: voiceModeControlSize,
                    child: VoiceWaveform(
                      source: widget.session,
                      microphone: () =>
                          widget.session.muted ? 0 : widget.session.micLevel,
                      playback: () => widget.session.playbackLevel,
                      mode: () => widget.session.meterMode,
                      enabled: widget.session.active,
                    ),
                  ),
                ),
              ),
              _end(context),
            ],
          ),
  );

  Widget _resume(BuildContext context) {
    final theme = Theme.of(context);
    final count = _shown.badge;
    return identified(
      VoiceIds.resume,
      Semantics(
        button: true,
        label: count == 0
            ? 'Resume the call'
            : 'Resume the call, $count finished while paused',
        child: ExcludeSemantics(
          child: FilledButton(
            onPressed: widget.session.resume,
            style: FilledButton.styleFrom(
              minimumSize: const Size(0, voiceModeControlSize),
              shape: const StadiumBorder(),
              padding: const EdgeInsets.symmetric(horizontal: 20),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.play_arrow_rounded, size: 20),
                const SizedBox(width: 8),
                const Text('Resume'),
                if (count > 0) ...[
                  const SizedBox(width: 10),
                  Container(
                    constraints: const BoxConstraints(minWidth: 22),
                    height: 22,
                    alignment: Alignment.center,
                    padding: const EdgeInsets.symmetric(horizontal: 6),
                    decoration: const BoxDecoration(
                      color: Colors.white,
                      shape: BoxShape.circle,
                    ),
                    child: Text(
                      '$count',
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: theme.colorScheme.primary,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _end(BuildContext context) => identified(
    VoiceIds.hangUp,
    _circle(
      context,
      label: 'End the call',
      icon: Icons.call_end_rounded,
      onPressed: widget.onEnd,
      tint: Theme.of(context).colorScheme.primary,
    ),
  );

  Widget _circle(
    BuildContext context, {
    required String label,
    required IconData icon,
    required VoidCallback onPressed,
    Color? tint,
  }) {
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      label: label,
      button: true,
      child: Tooltip(
        message: label,
        excludeFromSemantics: true,
        child: IconButton(
          onPressed: onPressed,
          icon: Icon(icon),
          iconSize: 22,
          constraints: const BoxConstraints.tightFor(
            width: voiceModeControlSize,
            height: voiceModeControlSize,
          ),
          style: IconButton.styleFrom(
            foregroundColor: tint ?? scheme.onSurface,
            backgroundColor: scheme.onSurface.withValues(alpha: 0.06),
            shape: const CircleBorder(),
          ),
        ),
      ),
    );
  }
}

/// The small rose mark in the header that says this Bot is on a call.
class VoiceHeaderPill extends StatelessWidget {
  const VoiceHeaderPill({super.key});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return identified(
      VoiceIds.headerPill,
      Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
        decoration: BoxDecoration(
          color: scheme.primary.withValues(alpha: 0.16),
          borderRadius: BorderRadius.circular(999),
        ),
        child: Text(
          'Voice',
          style: Theme.of(context).textTheme.labelSmall
              ?.copyWith(color: scheme.primary, fontWeight: FontWeight.w600),
        ),
      ),
    );
  }
}

typedef _Chip = ({String id, String runId, String name, bool finished});
typedef _Presentation = ({
  VoiceModeState state,
  bool paused,
  int badge,
  List<_Chip> chips,
});
