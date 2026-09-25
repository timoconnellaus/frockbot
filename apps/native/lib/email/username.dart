/// The account's email username: the part after the dot in every Bot's
/// address, `fox.tim@bots.frockbot.com`.
///
/// It is the deployment's to keep to one account (`app/email/directory.ts`),
/// so the server says whether a name is free; this page only draws what it
/// answered. Changing it changes every Bot's address at once, and the page
/// says so before it saves.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../shell/desktop_layout.dart';
import '../shell/semantics.dart';
import '../theme/dialogs.dart';
import '../theme/rows.dart';
import '../theme/states.dart';

class EmailUsernameController extends ChangeNotifier {
  final NativeApi api;
  EmailUsernameController(this.api);

  static const _path = '/api/email/username';

  bool loaded = false;
  bool busy = false;
  bool _closed = false;

  /// Why the last read or command did not land, in the person's words.
  String? message;

  /// Whether this deployment receives email at all.
  bool available = false;
  String? domain;
  String? username;

  void _changed() {
    if (!_closed) notifyListeners();
  }

  void _adopt(Object? answer) {
    if (answer is! Map) throw const FormatException('email username view');
    available = answer['available'] == true;
    final served = answer['domain'];
    domain = served is String && served.isNotEmpty ? served : null;
    final named = answer['username'];
    username = named is String && named.isNotEmpty ? named : null;
    loaded = true;
  }

  Future<bool> _run(Future<Object?> Function() request) async {
    if (busy) return false;
    busy = true;
    message = null;
    _changed();
    try {
      _adopt(await request());
      return true;
    } on RequestFailure catch (failure) {
      message = failure.message;
      return false;
    } catch (_) {
      message = 'Couldn’t reach FrockBot. Check your connection and try again.';
      return false;
    } finally {
      busy = false;
      _changed();
    }
  }

  Future<bool> load() => _run(() => api.request(_path));

  /// Hold [wanted], or give the username up with `null`.
  Future<bool> claim(String? wanted) =>
      _run(() => api.request(_path, body: {'username': wanted}));

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }
}

class EmailUsernamePage extends StatefulWidget {
  final NativeApi api;
  const EmailUsernamePage({super.key, required this.api});

  @override
  State<EmailUsernamePage> createState() => _EmailUsernamePageState();
}

class _EmailUsernamePageState extends State<EmailUsernamePage> {
  late EmailUsernameController controller;
  final field = TextEditingController();

  @override
  void initState() {
    super.initState();
    controller = EmailUsernameController(widget.api);
    unawaited(
      controller.load().then((_) {
        if (mounted) field.text = controller.username ?? '';
      }),
    );
    field.addListener(_typed);
  }

  void _typed() => setState(() {});

  @override
  void dispose() {
    field.removeListener(_typed);
    controller.dispose();
    field.dispose();
    super.dispose();
  }

  String get _wanted => field.text.trim().toLowerCase();

  Future<bool> _confirm({
    required String id,
    required String title,
    required String body,
    required String action,
  }) async =>
      await showDialog<bool>(
        context: context,
        builder: (dialog) => identified(
          id,
          AlertDialog(
            insetPadding: frockDialogInset,
            title: frockDialogTitle(Text(title)),
            content: frockDialogBody(Text(body)),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialog, false),
                child: const Text('Cancel'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(dialog, true),
                child: Text(action),
              ),
            ],
          ),
        ),
      ) ??
      false;

  Future<void> _save() async {
    final wanted = _wanted;
    final held = controller.username;
    if (wanted.isEmpty || wanted == held) return;
    final domain = controller.domain ?? 'your domain';
    if (held != null &&
        !await _confirm(
          id: EmailIds.usernameConfirm,
          title: 'Change your username?',
          body:
              'Every Bot’s email address changes to end in .$wanted@$domain. '
              'Mail to the old addresses, ending in .$held@$domain, is refused '
              'from now on, and anyone can take “$held”.',
          action: 'Change',
        )) {
      return;
    }
    if (await controller.claim(wanted)) field.text = controller.username ?? '';
  }

  Future<void> _remove() async {
    final held = controller.username;
    if (held == null) return;
    if (!await _confirm(
      id: EmailIds.usernameRemoveConfirm,
      title: 'Remove your username?',
      body:
          'Your Bots have no email address until you choose a username again. '
          'Mail to addresses ending in .$held is refused from now on, and '
          'anyone can take “$held”.',
      action: 'Remove',
    )) {
      return;
    }
    if (await controller.claim(null)) field.text = '';
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: DesktopHeader(child: AppBar(title: const Text('Email username'))),
    body: AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        if (!controller.loaded && controller.busy) {
          return const FrockLoading(label: 'Loading your username');
        }
        if (!controller.loaded) {
          return FrockEmptyState(
            icon: Icons.cloud_off_rounded,
            title: 'Your username couldn’t load',
            detail:
                controller.message ?? 'Check your connection and try again.',
            action: 'Try again',
            onAction: () => unawaited(controller.load()),
          );
        }
        return identified(
          EmailIds.usernamePage,
          Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 680),
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
                children: [
                  if (!controller.available && controller.username == null)
                    identified(
                      EmailIds.unavailable,
                      Card(
                        margin: const EdgeInsets.only(top: 12),
                        child: Padding(
                          padding: const EdgeInsets.all(16),
                          child: Text(
                            'Email isn’t set up on this deployment.',
                            style: Theme.of(context).textTheme.bodyMedium,
                          ),
                        ),
                      ),
                    )
                  else
                    _form(context),
                ],
              ),
            ),
          ),
        );
      },
    ),
  );

  Widget _form(BuildContext context) {
    final theme = Theme.of(context);
    final quiet = theme.textTheme.bodySmall?.copyWith(
      fontSize: 12.5,
      color: theme.colorScheme.onSurfaceVariant,
    );
    final held = controller.username;
    final domain = controller.domain;
    final shown = _wanted.isEmpty ? (held ?? 'you') : _wanted;
    final changed = _wanted.isNotEmpty && _wanted != held;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 4, 4, 0),
          child: Text(
            'Each Bot’s email address is its name, a dot, and this username. '
            'It’s yours alone here: nobody else can hold it.',
            style: quiet,
          ),
        ),
        const FrockSectionLabel('Username'),
        identified(
          EmailIds.usernameField,
          TextField(
            controller: field,
            autocorrect: false,
            enableSuggestions: false,
            textInputAction: TextInputAction.done,
            onSubmitted: (_) => unawaited(_save()),
            decoration: const InputDecoration(
              labelText: 'Username',
              hintText: 'tim',
              helperText:
                  '3 to 30 lowercase letters, digits and dashes, starting '
                  'with a letter.',
            ),
          ),
        ),
        if (domain != null) ...[
          const SizedBox(height: 12),
          identified(
            EmailIds.usernamePreview,
            Text.rich(
              TextSpan(
                children: [
                  const TextSpan(text: 'A Bot called Fox would be '),
                  TextSpan(
                    text: 'fox.$shown@$domain',
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                ],
              ),
              style: theme.textTheme.bodyMedium,
            ),
          ),
        ],
        if (held != null) ...[
          const SizedBox(height: 8),
          Text(
            'Changing your username changes every Bot’s address. The old '
            'addresses stop working.',
            style: quiet,
          ),
        ],
        const SizedBox(height: 16),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            identified(
              EmailIds.usernameSave,
              FilledButton(
                onPressed: controller.busy || !changed || !controller.available
                    ? null
                    : () => unawaited(_save()),
                child: Text(held == null ? 'Save' : 'Change username'),
              ),
            ),
            if (held != null)
              identified(
                EmailIds.usernameRemove,
                OutlinedButton(
                  onPressed: controller.busy
                      ? null
                      : () => unawaited(_remove()),
                  child: const Text('Remove'),
                ),
              ),
          ],
        ),
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Semantics(
            liveRegion: true,
            child: Text(
              controller.message ?? '',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.error,
              ),
            ),
          ),
        ),
      ],
    );
  }
}
