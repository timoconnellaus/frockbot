import 'dart:async';

import 'package:flutter/material.dart';

import '../ui/frock_tokens.dart';
import '../ui/frock_widgets.dart';
import 'controller.dart';
import 'protocol.dart';

/// Voice, as the whole app screen.
///
/// Not a sheet over chat: talking to your Bots is the only thing happening,
/// so nothing else is on screen to argue with it. One control while live
/// (Pause) and one while paused (Resume, carrying the count of what waits).
/// Close leaves Voice entirely.
class VoicePage extends StatefulWidget {
  const VoicePage({
    super.key,
    required this.controller,
    this.botLook,
    this.lookOfBot,
  });
  final VoiceController controller;

  /// The sheep to show. The assistant is the User's, not a Bot's, so this is
  /// the Bot you came from — a face you already recognise.
  final SheepLook? botLook;

  /// Each waiting Bot's own sheep, from the flock. Unknown Bots get the plain
  /// one.
  final SheepLook? Function(String botId)? lookOfBot;

  @override
  State<VoicePage> createState() => _VoicePageState();
}

class _VoicePageState extends State<VoicePage> {
  VoiceController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.addListener(_update);
    unawaited(c.start());
  }

  void _update() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    c.removeListener(_update);
    super.dispose();
  }

  Future<void> _leave() async {
    final navigator = Navigator.of(context);
    await c.leave();
    if (mounted) navigator.pop();
  }

  String get _eyebrow => switch (c.phase) {
    VoicePhase.paused => 'Voice · paused',
    VoicePhase.resuming => 'Voice · resuming',
    VoicePhase.ended => 'Voice · off',
    _ => 'Voice · with your Bots',
  };

  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    final bottom = MediaQuery.paddingOf(context).bottom;
    final paused = c.phase == VoicePhase.paused;
    final waiting = c.waiting;
    return Scaffold(
      backgroundColor: t.window,
      body: SafeArea(
        bottom: false,
        child: Padding(
          padding: EdgeInsets.fromLTRB(
            FrockTokens.edge,
            0,
            FrockTokens.edge,
            bottom + 12,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              FrockBar(
                leading: FrockIconButton(
                  Icons.close_rounded,
                  key: const ValueKey('leave-voice'),
                  semanticLabel: 'Leave voice',
                  onTap: () => unawaited(_leave()),
                ),
                title: FrockEyebrow(_eyebrow),
              ),
              Expanded(
                child: _Stage(controller: c, look: widget.botLook),
              ),
              if (paused && waiting.isNotEmpty) ...[
                const FrockEyebrow('Waiting for you'),
                _WaitingGroup(lookOfBot: widget.lookOfBot, waiting: waiting),
                const SizedBox(height: 12),
              ],
              _Control(controller: c),
            ],
          ),
        ),
      ),
    );
  }
}

/// The sheep, the state chip, and the two lines of what was just said.
class _Stage extends StatelessWidget {
  const _Stage({required this.controller, this.look});
  final VoiceController controller;
  final SheepLook? look;

  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    final c = controller;
    final quiet = c.phase == VoicePhase.paused || c.phase == VoicePhase.ended;
    final sheep = FrockSheep(
      look: look ?? SheepLook.plain,
      size: 112,
      state: switch (c.phase) {
        VoicePhase.speaking => BotState.working,
        VoicePhase.listening => BotState.ready,
        _ => BotState.idle,
      },
    );
    final (chip, tone, dot) = switch (c.phase) {
      VoicePhase.speaking => ('Speaking', TileTone.accent, false),
      VoicePhase.listening => ('Listening', TileTone.good, true),
      VoicePhase.connecting => ('Connecting', TileTone.neutral, false),
      VoicePhase.resuming => ('Resuming', TileTone.neutral, false),
      VoicePhase.paused => ('Paused · not listening', TileTone.neutral, false),
      VoicePhase.ended => ('Voice is off', TileTone.neutral, false),
    };
    final detail = switch (c.phase) {
      VoicePhase.paused =>
        c.message ??
            'Nothing is being heard. Your Bots don’t know you stepped away; '
                'what they send waits here.',
      VoicePhase.resuming =>
        'Reconnecting. Anything that arrived is going to the agent now.',
      VoicePhase.ended => c.message ?? 'Voice is off.',
      _ => c.message,
    };
    return Stack(
      alignment: Alignment.center,
      children: [
        // The glow is a static wash, not a pulse, so it stays under reduced
        // motion; the sheep's ring does its own reducing.
        if (!quiet)
          const Positioned(top: 0, child: IgnorePointer(child: FrockGlow())),
        Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            quiet ? Opacity(opacity: 0.7, child: sheep) : sheep,
            const SizedBox(height: 18),
            FrockChip(chip, tone: tone, dot: dot),
            if (detail != null) ...[
              const SizedBox(height: 12),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 300),
                child: Text(
                  detail,
                  textAlign: TextAlign.center,
                  style: t.message.copyWith(color: t.ink2),
                ),
              ),
            ],
            // Two lines while live: the last thing you said and the last thing
            // it said. Tool use never appears here.
            if (!quiet && c.youSaid != null) ...[
              const SizedBox(height: 12),
              _Caption(c.youSaid!, color: t.ink2),
            ],
            if (!quiet && c.botSaid != null) ...[
              const SizedBox(height: 8),
              _Caption(c.botSaid!),
            ],
          ],
        ),
      ],
    );
  }
}

class _Caption extends StatelessWidget {
  const _Caption(this.text, {this.color});
  final String text;
  final Color? color;
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 300),
      child: Text(
        text,
        textAlign: TextAlign.center,
        maxLines: 3,
        overflow: TextOverflow.ellipsis,
        style: t.message.copyWith(color: color),
      ),
    );
  }
}

/// What arrived while nobody was listening, one row per Bot answer.
class _WaitingGroup extends StatelessWidget {
  const _WaitingGroup({required this.waiting, this.lookOfBot});
  final List<VoicePendingAnswer> waiting;
  final SheepLook? Function(String botId)? lookOfBot;

  @override
  Widget build(BuildContext context) {
    // One row per Bot, carrying its newest answer and how many it has waiting,
    // so a Bot that answered twice is one row and not two.
    final byBot = <String, List<VoicePendingAnswer>>{};
    for (final answer in waiting) {
      byBot.putIfAbsent(answer.botId, () => []).add(answer);
    }
    return ConstrainedBox(
      constraints: const BoxConstraints(maxHeight: 220),
      child: SingleChildScrollView(
        child: FrockGroup(
          children: [
            for (final answers in byBot.values)
              FrockRow(
                key: ValueKey('waiting-${answers.first.botId}'),
                leading: FrockSheep(
                  look: lookOfBot?.call(answers.first.botId) ?? SheepLook.plain,
                  size: FrockTokens.avatarMd,
                ),
                title: answers.last.botName,
                caption: answers.last.answer,
                trailing: FrockChip('${answers.length}', tone: TileTone.accent),
              ),
          ],
        ),
      ),
    );
  }
}

/// One control, and one sentence saying what it does.
class _Control extends StatelessWidget {
  const _Control({required this.controller});
  final VoiceController controller;

  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    final c = controller;
    final count = c.waiting.length;
    final (label, icon, kind, onTap, caption) = switch (c.phase) {
      VoicePhase.paused => (
        count == 0 ? 'Resume' : 'Resume · $count waiting',
        Icons.play_arrow_rounded,
        PillKind.primary,
        () => unawaited(c.resume()),
        count == 0 ? 'Resuming starts listening again.' : 'Resuming hands these to the voice agent to work through with you.',
      ),
      VoicePhase.resuming => (
        'Resuming…',
        Icons.play_arrow_rounded,
        PillKind.primary,
        null,
        'Reconnecting to your Bots.',
      ),
      VoicePhase.ended => (
        'Leave voice',
        Icons.close_rounded,
        PillKind.tonal,
        () => unawaited(Navigator.of(context).maybePop()),
        'Open Voice again from the top of the screen.',
      ),
      VoicePhase.connecting => (
        'Pause',
        Icons.pause_rounded,
        PillKind.tonal,
        null,
        'Connecting to your Bots.',
      ),
      _ => (
        'Pause',
        Icons.pause_rounded,
        PillKind.tonal,
        () => unawaited(c.pause()),
        'Pausing stops listening. Your Bots keep working and their messages '
            'wait for you.',
      ),
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        FrockPill(
          label,
          key: const ValueKey('voice-control'),
          kind: kind,
          size: PillSize.lg,
          icon: icon,
          expand: true,
          onTap: onTap,
        ),
        const SizedBox(height: 10),
        Text(caption, textAlign: TextAlign.center, style: t.caption),
      ],
    );
  }
}
