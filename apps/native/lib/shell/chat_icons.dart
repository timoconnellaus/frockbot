import 'dart:math' as math;

import 'package:flutter/material.dart';

enum ChatIconKind {
  computer,
  routines,
  settings,
  plugins,
  applet,
  panel,
  send,
  mic,
}

/// One light stroke weight for the compact chat chrome, independent of the
/// platform's bundled Material glyph weight.
class ChatIcon extends StatelessWidget {
  final ChatIconKind kind;
  final double size;
  const ChatIcon(this.kind, {super.key, this.size = 19});

  @override
  Widget build(BuildContext context) {
    final theme = IconTheme.of(context);
    final base = theme.color ?? Theme.of(context).colorScheme.onSurface;
    final color = base.withValues(alpha: base.a * (theme.opacity ?? 1));
    return ExcludeSemantics(
      child: SizedBox.square(
        dimension: size,
        child: CustomPaint(painter: _ChatIconPainter(kind, color)),
      ),
    );
  }
}

class _ChatIconPainter extends CustomPainter {
  final ChatIconKind kind;
  final Color color;
  const _ChatIconPainter(this.kind, this.color);

  @override
  void paint(Canvas canvas, Size size) {
    canvas.scale(size.width / 24, size.height / 24);
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    final path = Path();
    switch (kind) {
      case ChatIconKind.computer:
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            const Rect.fromLTWH(3, 4, 18, 13),
            const Radius.circular(1.5),
          ),
          paint,
        );
        path.moveTo(12, 17);
        path.lineTo(12, 21);
        path.moveTo(8, 21);
        path.lineTo(16, 21);
      case ChatIconKind.routines:
        canvas.drawCircle(const Offset(12, 12), 9, paint);
        path.moveTo(12, 6);
        path.lineTo(12, 12);
        path.lineTo(16, 14);
      case ChatIconKind.settings:
        // Eight shallow teeth keep the gear legible at 19 logical pixels.
        for (var i = 0; i < 32; i++) {
          final angle = i * math.pi / 16 - math.pi / 2;
          final radius = i % 4 < 2 ? 9.5 : 7.5;
          final point = Offset(
            12 + radius * math.cos(angle),
            12 + radius * math.sin(angle),
          );
          if (i == 0) {
            path.moveTo(point.dx, point.dy);
          } else {
            path.lineTo(point.dx, point.dy);
          }
        }
        path.close();
        canvas.drawCircle(const Offset(12, 12), 3, paint);
      case ChatIconKind.panel:
        // A window with its right-hand column marked off: the panel this
        // shows and hides.
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            const Rect.fromLTWH(3, 4, 18, 16),
            const Radius.circular(2),
          ),
          paint,
        );
        path.moveTo(15, 4);
        path.lineTo(15, 20);
      case ChatIconKind.send:
        path.moveTo(12, 20);
        path.lineTo(12, 4);
        path.moveTo(6, 10);
        path.lineTo(12, 4);
        path.lineTo(18, 10);
      case ChatIconKind.mic:
        // The capsule, its cradle, the stem and the foot share one vertical
        // axis at 12 and span 3..21, so the glyph sits where the send arrow
        // does rather than where the bundled Material mic happens to.
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            const Rect.fromLTWH(9, 3, 6, 10),
            const Radius.circular(3),
          ),
          paint,
        );
        path.addArc(const Rect.fromLTWH(6, 5, 12, 12), 0, math.pi);
        path.moveTo(12, 17);
        path.lineTo(12, 21);
        path.moveTo(9, 21);
        path.lineTo(15, 21);
      case ChatIconKind.plugins:
        // A piece with two tabs: the square, and the knobs that make it a
        // Plugin rather than an Applet's window.
        path.moveTo(5, 7);
        path.lineTo(9, 7);
        path.arcToPoint(const Offset(13, 7), radius: const Radius.circular(2));
        path.lineTo(17, 7);
        path.lineTo(17, 11);
        path.arcToPoint(const Offset(17, 15), radius: const Radius.circular(2));
        path.lineTo(17, 19);
        path.lineTo(5, 19);
        path.close();
      case ChatIconKind.applet:
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            const Rect.fromLTWH(4, 4, 16, 16),
            const Radius.circular(1.5),
          ),
          paint,
        );
        path.moveTo(4, 10);
        path.lineTo(20, 10);
        path.moveTo(10, 10);
        path.lineTo(10, 20);
    }
    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(_ChatIconPainter oldDelegate) =>
      oldDelegate.kind != kind || oldDelegate.color != color;
}
