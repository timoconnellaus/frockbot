import 'package:flutter/material.dart';

import '../theme/frock_theme.dart';

const voiceEnterDuration = Duration(milliseconds: 360);
const voiceExitDuration = Duration(milliseconds: 240);

/// Keeps the outgoing surface mounted until its exit finishes. Capture and
/// playback stop independently; an animation never delays releasing the mic.
class VoiceReveal extends StatefulWidget {
  final bool visible;
  final Widget child;
  final VoidCallback? onHidden;

  /// Space transferred from the body's SafeArea while this surface is shown.
  /// Keeping that inset reserved avoids a last-frame jump at the gesture bar.
  final double bottomInset;
  const VoiceReveal({
    super.key,
    required this.visible,
    required this.child,
    this.onHidden,
    this.bottomInset = 0,
  });

  @override
  State<VoiceReveal> createState() => _VoiceRevealState();
}

class _VoiceRevealState extends State<VoiceReveal>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller =
      AnimationController(
        vsync: this,
        duration: voiceEnterDuration,
        reverseDuration: voiceExitDuration,
      )..addStatusListener((status) {
        if (status != AnimationStatus.dismissed) return;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted && !widget.visible) widget.onHidden?.call();
        });
      });
  late final CurvedAnimation _curve = CurvedAnimation(
    parent: _controller,
    curve: Curves.easeOutCubic,
    reverseCurve: Curves.easeInOutCubic,
  );
  late final Animation<Offset> _slide = Tween(
    begin: const Offset(0, 0.18),
    end: Offset.zero,
  ).animate(_curve);

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _animate();
  }

  @override
  void didUpdateWidget(VoiceReveal oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.visible != oldWidget.visible) _animate();
  }

  void _animate() {
    if (MediaQuery.disableAnimationsOf(context)) {
      _controller.value = widget.visible ? 1 : 0;
    } else if (widget.visible) {
      _controller.forward();
    } else {
      _controller.reverse();
    }
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _controller,
    builder: (context, child) {
      if (!widget.visible && _controller.isDismissed) {
        return SizedBox(height: widget.bottomInset);
      }
      return IgnorePointer(
        ignoring: !widget.visible,
        child: ExcludeSemantics(
          excluding: !widget.visible,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ClipRect(
                child: SizeTransition(
                  sizeFactor: _curve,
                  alignment: Alignment.bottomCenter,
                  child: FadeTransition(
                    opacity: _curve,
                    child: SlideTransition(position: _slide, child: child),
                  ),
                ),
              ),
              SizedBox(height: widget.bottomInset * (1 - _curve.value)),
            ],
          ),
        ),
      );
    },
    child: widget.child,
  );

  @override
  void dispose() {
    _curve.dispose();
    _controller.dispose();
    super.dispose();
  }
}

Widget voiceIconTransition(BuildContext context, Widget icon) =>
    AnimatedSwitcher(
      duration: FrockTheme.motion(context, FrockTheme.fast),
      transitionBuilder: (child, animation) => FadeTransition(
        opacity: animation,
        child: ScaleTransition(
          scale: Tween<double>(begin: 0.75, end: 1).animate(animation),
          child: child,
        ),
      ),
      child: icon,
    );
