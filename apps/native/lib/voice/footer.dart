/// The realtime call's own controls: in the composer's place on the Bot being
/// talked to, and as a slab below the app everywhere else.
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../shell/semantics.dart';
import '../theme/frock_theme.dart';
import 'assistant.dart';
import 'motion.dart';
import 'waveform.dart';

const double voiceFooterHeight = 96;

/// The call's controls in the composer's row, where the row is the size of a
/// one-line field rather than of a slab.
const double voiceDockControlExtent = 40;

/// The composer pill's corner, so the call reads as the field it replaced.
const double voiceDockRadius = 22;

/// The same inset the composer's own controls keep from the field's edge.
const double voiceDockControlInset = 4;
const double voiceFooterStageMaxWidth = 420;
const double voiceFooterStageInset = 24;
const double voiceFooterControlsWidth = 144;
const Key voiceFooterAnimationKey = ValueKey('voice-footer-animation');

class VoiceFooter extends StatefulWidget {
  final AssistantSessionController session;
  final VoidCallback onEnd;
  const VoiceFooter({super.key, required this.session, required this.onEnd});

  @override
  State<VoiceFooter> createState() => _VoiceFooterState();
}

class _VoiceFooterState extends State<VoiceFooter> {
  late (bool, String?, String?, VoiceSessionPhase) _presentation;

  @override
  void initState() {
    super.initState();
    _presentation = _readPresentation();
    widget.session.addListener(_changed);
  }

  (bool, String?, String?, VoiceSessionPhase) _readPresentation() => (
    widget.session.muted,
    widget.session.error,
    widget.session.notice,
    widget.session.phase,
  );

  void _changed() {
    final next = _readPresentation();
    if (_presentation == next) return;
    setState(() => _presentation = next);
  }

  @override
  void didUpdateWidget(VoiceFooter oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.session != widget.session) {
      oldWidget.session.removeListener(_changed);
      widget.session.addListener(_changed);
      _presentation = _readPresentation();
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
    final session = widget.session;
    final failure = session.error;
    // A failure ends the call and takes the stage for good; a notice borrows
    // it for a few seconds while the call goes on, controls and all.
    final text = failure ?? session.notice;
    return identified(
      VoiceIds.footer,
      Material(
        color: theme.colorScheme.primary,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
        clipBehavior: Clip.antiAlias,
        child: SafeArea(
          top: false,
          child: SizedBox(
            height: voiceFooterHeight,
            child: Stack(
              children: [
                Positioned.fill(
                  child: text == null
                      ? _stage()
                      : Padding(
                          padding: const EdgeInsets.fromLTRB(24, 16, 96, 16),
                          child: Center(
                            child: Semantics(
                              liveRegion: true,
                              child: Text(
                                text,
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: theme.textTheme.bodySmall?.copyWith(
                                  color: Colors.white,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ),
                          ),
                        ),
                ),
                Align(
                  alignment: Alignment.centerRight,
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (failure == null) ...[
                        identified(
                          VoiceIds.mute,
                          Semantics(
                            toggled: session.muted,
                            child: _circle(
                              label: session.muted
                                  ? 'Unmute microphone'
                                  : 'Mute microphone',
                              selected: session.muted,
                              onPressed: () =>
                                  session.setMuted(!session.userMuted),
                              icon: session.muted ? Icons.mic_off : Icons.mic,
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                      ],
                      identified(
                        VoiceIds.end,
                        _circle(
                          label: 'End voice session',
                          onPressed: widget.onEnd,
                          icon: Icons.close,
                        ),
                      ),
                      const SizedBox(width: 24),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _circle({
    required String label,
    required VoidCallback onPressed,
    required IconData icon,
    bool selected = false,
  }) => voiceCircleControl(
    context,
    label: label,
    onPressed: onPressed,
    icon: icon,
    selected: selected,
  );

  Widget _stage() => identified(
    VoiceIds.footerAnimation,
    LayoutBuilder(
      builder: (context, constraints) {
        final available =
            constraints.maxWidth -
            voiceFooterStageInset -
            voiceFooterControlsWidth;
        final width = math.min(
          voiceFooterStageMaxWidth,
          math.max(0.0, available),
        );
        if (width == 0) return const SizedBox.shrink();
        final left = ((constraints.maxWidth - width) / 2).clamp(
          voiceFooterStageInset,
          constraints.maxWidth - voiceFooterControlsWidth - width,
        );
        // The Bot being consulted is not drawn here. During a call the
        // conversation is the voice, and a character rising out of the meter
        // every time the assistant asked a Bot was a second thing moving
        // under a row whose whole job is to say "you are still on a call".
        return Stack(
          children: [
            Positioned(
              left: left,
              top: 0,
              width: width,
              height: voiceFooterHeight,
              child: VoiceWaveform(
                key: voiceFooterAnimationKey,
                source: widget.session,
                microphone: () =>
                    widget.session.muted ? 0 : widget.session.micLevel,
                playback: () => widget.session.playbackLevel,
                mode: () => widget.session.meterMode,
                enabled: widget.session.active,
                onAccent: true,
              ),
            ),
          ],
        );
      },
    ),
  );
}

/// A white-on-accent control, the one shape both surfaces use.
Widget voiceCircleControl(
  BuildContext context, {
  required String label,
  required VoidCallback onPressed,
  required IconData icon,
  bool selected = false,
  double size = 48,
}) => Semantics(
  label: label,
  button: true,
  child: Tooltip(
    message: label,
    excludeFromSemantics: true,
    child: IconButton(
      onPressed: onPressed,
      icon: voiceIconTransition(context, Icon(icon, key: ValueKey(icon))),
      iconSize: size < 48 ? 20 : 22,
      constraints: BoxConstraints.tightFor(width: size, height: size),
      padding: EdgeInsets.zero,
      style: IconButton.styleFrom(
        foregroundColor: selected ? FrockTheme.accentDeep : Colors.white,
        backgroundColor: Colors.white.withValues(alpha: selected ? 0.95 : 0.18),
        shape: const CircleBorder(),
      ),
    ),
  ),
);

/// The call where the composer was.
///
/// A call is not a mode of the draft — there is nothing to send while the
/// microphone is the conversation — so the field is not left sitting disabled
/// under a slab. It is replaced: the pill keeps the composer's frame and
/// becomes the call, the meter across it and the two controls at its end, and
/// the draft comes back untouched when the call ends.
class VoiceComposerDock extends StatefulWidget {
  final AssistantSessionController session;
  final VoidCallback onEnd;
  const VoiceComposerDock({
    super.key,
    required this.session,
    required this.onEnd,
  });

  @override
  State<VoiceComposerDock> createState() => _VoiceComposerDockState();
}

class _VoiceComposerDockState extends State<VoiceComposerDock> {
  late (bool, String?, String?, VoiceSessionPhase) _presentation;

  (bool, String?, String?, VoiceSessionPhase) _read() => (
    widget.session.muted,
    widget.session.error,
    widget.session.notice,
    widget.session.phase,
  );

  @override
  void initState() {
    super.initState();
    _presentation = _read();
    widget.session.addListener(_changed);
  }

  @override
  void didUpdateWidget(VoiceComposerDock oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.session != widget.session) {
      oldWidget.session.removeListener(_changed);
      widget.session.addListener(_changed);
      _presentation = _read();
    }
  }

  void _changed() {
    final next = _read();
    if (_presentation == next) return;
    setState(() => _presentation = next);
  }

  @override
  void dispose() {
    widget.session.removeListener(_changed);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final session = widget.session;
    final failure = session.error;
    // A failure ends the call and takes the row for good; a notice borrows it
    // for a few seconds while the call goes on, controls and all.
    final text = failure ?? session.notice;
    return identified(
      VoiceIds.footer,
      Material(
        color: theme.colorScheme.primary,
        borderRadius: BorderRadius.circular(voiceDockRadius),
        clipBehavior: Clip.antiAlias,
        child: SizedBox.expand(
          child: Row(
            children: [
              Expanded(
                child: text == null
                    ? identified(
                        VoiceIds.footerAnimation,
                        VoiceWaveform(
                          key: voiceFooterAnimationKey,
                          source: session,
                          microphone: () =>
                              session.muted ? 0 : session.micLevel,
                          playback: () => session.playbackLevel,
                          mode: () => session.meterMode,
                          enabled: session.active,
                          onAccent: true,
                        ),
                      )
                    : Padding(
                        padding: const EdgeInsets.only(left: 18),
                        child: Align(
                          alignment: Alignment.centerLeft,
                          child: Semantics(
                            liveRegion: true,
                            child: Text(
                              text,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: theme.textTheme.bodySmall?.copyWith(
                                color: Colors.white,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ),
                        ),
                      ),
              ),
              // The sound and nothing else. The way out of the call is the
              // control that started it, still in its own place beside the
              // field; a microphone here read as the one that dictates, and
              // a second X a thumb's width from the first would be two ways
              // to hang up. A failure is the one thing that earns a control:
              // the call is already over and this row is the only way out.
              if (failure != null) ...[
                identified(
                  VoiceIds.end,
                  voiceCircleControl(
                    context,
                    label: 'End voice session',
                    onPressed: widget.onEnd,
                    icon: Icons.close,
                    size: voiceDockControlExtent,
                  ),
                ),
                const SizedBox(width: voiceDockControlInset),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
