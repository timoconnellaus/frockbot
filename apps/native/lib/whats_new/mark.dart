/// The rose mark on unread What’s New: the profile row and each new card.
library;

import 'package:flutter/material.dart';

import '../shell/semantics.dart';
import '../theme/frock_theme.dart';

class WhatsNewUnreadMark extends StatelessWidget {
  const WhatsNewUnreadMark({super.key});

  @override
  Widget build(BuildContext context) => identified(
    WhatsNewIds.unread,
    Semantics(
      label: 'Unread',
      child: Container(
        width: 8,
        height: 8,
        decoration: const BoxDecoration(
          color: FrockTheme.accent,
          shape: BoxShape.circle,
        ),
      ),
    ),
  );
}
