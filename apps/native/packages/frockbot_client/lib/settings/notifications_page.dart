/// Notifications in a browser. The apps ask once on their own; a browser asks
/// only from a tap, and an iPhone only once the app is on its Home Screen, so
/// the web client has this page and nothing asks on load.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../activity/push.dart';
import '../brand.dart';
import '../shell/desktop_layout.dart';
import '../shell/semantics.dart';

class NotificationsPage extends StatefulWidget {
  final PushController push;
  const NotificationsPage({super.key, required this.push});

  @override
  State<NotificationsPage> createState() => _NotificationsPageState();
}

class _NotificationsPageState extends State<NotificationsPage> {
  bool busy = false;
  String? message;

  void _turnOn() {
    // Straight from the tap: the browser's prompt needs the gesture.
    final asked = widget.push.turnOnWebPush();
    setState(() {
      busy = true;
      message = null;
    });
    unawaited(
      asked.then((refusal) {
        if (!mounted) return;
        setState(() {
          busy = false;
          message = refusal;
        });
      }),
    );
  }

  Future<void> _turnOff() async {
    setState(() {
      busy = true;
      message = null;
    });
    await widget.push.turnOffWebPush();
    if (mounted) setState(() => busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final quiet = theme.textTheme.bodyMedium?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );
    final push = widget.push;
    final name = clientBrand.productName;
    final (String line, Widget? action) = switch (push.webPush.state) {
      WebPushState.needsHomeScreen => (
        'On an iPhone or iPad, $name can notify you once it’s on your Home '
            'Screen. In Safari, tap Share, then Add to Home Screen, and open '
            '$name from there.',
        null,
      ),
      WebPushState.blocked => (
        'Notifications are blocked for this site. Allow them in your '
            'browser’s site settings, then come back here.',
        null,
      ),
      WebPushState.unsupported => (
        'This browser can’t show notifications from $name.',
        null,
      ),
      _ when push.webPushOn => (
        'This browser shows a notification when a Bot sends you a message and '
            'you’re not reading it. Each Bot’s notifications turn on and off '
            'in its own settings.',
        identified(
          SettingsIds.notificationsTurnOff,
          OutlinedButton(
            onPressed: busy ? null : () => unawaited(_turnOff()),
            child: const Text('Turn off notifications'),
          ),
        ),
      ),
      _ => (
        'Get a notification in this browser when a Bot sends you a message '
            'and you’re not reading it, even with $name closed.',
        identified(
          SettingsIds.notificationsTurnOn,
          FilledButton(
            onPressed: busy ? null : _turnOn,
            child: const Text('Turn on notifications'),
          ),
        ),
      ),
    };
    return Scaffold(
      appBar: DesktopHeader(child: AppBar(title: const Text('Notifications'))),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 680),
          child: ListView(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 32),
            children: [
              Text(line, style: quiet),
              if (action != null) ...[
                const SizedBox(height: 16),
                Align(alignment: Alignment.centerLeft, child: action),
              ],
              if (message case final String refusal) ...[
                const SizedBox(height: 12),
                Text(
                  refusal,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.error,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
