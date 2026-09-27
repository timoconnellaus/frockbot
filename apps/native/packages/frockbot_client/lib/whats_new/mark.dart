/// The rose mark on unread What’s New: the sidebar's megaphone and each new
/// card.
library;

import 'package:flutter/material.dart';

import '../shell/semantics.dart';
import '../theme/controls.dart';

class WhatsNewUnreadMark extends StatelessWidget {
  const WhatsNewUnreadMark({super.key});

  @override
  Widget build(BuildContext context) => identified(
    WhatsNewIds.unread,
    Semantics(
      label: 'Unread',
      child: StatusDot(color: Theme.of(context).colorScheme.primary),
    ),
  );
}
