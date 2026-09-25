/// Email this Bot: whether it receives email, its address, and the addresses
/// allowed to write to it.
///
/// The server holds all of it (`app/email/backend.ts`); every command answers
/// the whole view, and this page draws what came back. A Bot's address is its
/// name and the account's username, `fox.tim@frockbot.com`, so it is never
/// made here: it follows the Bot's name, and the username has its own page
/// ([EmailUsernamePage]). The senders are the account's — one list for every
/// Bot — and are here because this is where the address they write to is. A
/// sender is confirmed by mailing the code shown here from that address,
/// never by a link sent to it.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../client/transport.dart';
import '../shell/desktop_layout.dart';
import '../shell/semantics.dart';
import '../theme/rows.dart';
import '../theme/states.dart';
import 'username.dart';

/// One address that may write to the User's Bots, as the view names it.
class BotEmailSender {
  final String address;

  /// `sign-in`, `verified`, `pending` or `expired`.
  final String status;

  /// `FROCK-XXXX-XXXX`, while the address waits for it.
  final String? code;
  const BotEmailSender({
    required this.address,
    required this.status,
    this.code,
  });

  static BotEmailSender? fromJson(Object? value) {
    if (value is! Map) return null;
    final address = value['address'];
    final status = value['status'];
    if (address is! String || status is! String) return null;
    const known = {'sign-in', 'verified', 'pending', 'expired'};
    if (!known.contains(status)) return null;
    final code = value['code'];
    return BotEmailSender(
      address: address,
      status: status,
      code: code is String ? code : null,
    );
  }
}

class BotEmailController extends ChangeNotifier {
  final NativeApi api;
  final String botId;
  BotEmailController(this.api, this.botId);

  bool loaded = false;
  bool busy = false;
  bool _closed = false;

  /// Why the last read or command did not land, in the person's words.
  String? message;

  /// Whether this deployment receives email at all.
  bool available = false;

  /// The account's username, once the person chose one.
  String? username;

  /// `<bot-slug>.<username>@<domain>`, once there is a username.
  String? address;

  /// Whether mail to [address] reaches this Bot. Off until turned on.
  bool receiving = false;
  List<BotEmailSender> senders = const [];

  String get _path => '/api/bots/${Uri.encodeComponent(botId)}/email';

  void _changed() {
    if (!_closed) notifyListeners();
  }

  void _adopt(Object? answer) {
    if (answer is! Map) throw const FormatException('email view');
    available = answer['available'] == true;
    final named = answer['username'];
    username = named is String && named.isNotEmpty ? named : null;
    final held = answer['address'];
    address = held is String && held.contains('@') ? held : null;
    receiving = answer['receiving'] == true;
    senders = [
      for (final entry in (answer['senders'] as List? ?? const []))
        if (BotEmailSender.fromJson(entry) case final BotEmailSender sender)
          sender,
    ];
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

  /// Turn this Bot's email on or off.
  Future<bool> setReceiving(bool on) =>
      _run(() => api.request('$_path/switch', body: {'receiving': on}));

  /// `add` (again, for a fresh code) or `remove`.
  Future<bool> senderCommand(String action, String sender) => _run(
    () => api.request(
      '$_path/senders',
      body: {'action': action, 'address': sender.trim()},
    ),
  );

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }
}

/// The Bot settings row that opens [BotEmailPage]. It reads nothing itself:
/// the page does, when it is opened.
Widget botEmailRow(
  BuildContext context, {
  required NativeApi api,
  required String botId,
}) => identified(
  EmailIds.settingsRow,
  FrockRow(
    icon: Icons.alternate_email_rounded,
    title: 'Email',
    subtitle: 'Write to this Bot from your own address',
    onTap: () => Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => BotEmailPage(api: api, botId: botId),
      ),
    ),
  ),
);

class BotEmailPage extends StatefulWidget {
  final NativeApi api;
  final String botId;
  const BotEmailPage({super.key, required this.api, required this.botId});

  @override
  State<BotEmailPage> createState() => _BotEmailPageState();
}

class _BotEmailPageState extends State<BotEmailPage> {
  late BotEmailController controller;
  final senderField = TextEditingController();

  @override
  void initState() {
    super.initState();
    controller = BotEmailController(widget.api, widget.botId);
    unawaited(controller.load());
  }

  @override
  void dispose() {
    controller.dispose();
    senderField.dispose();
    super.dispose();
  }

  Future<void> _copy(String text, String said) async {
    await Clipboard.setData(ClipboardData(text: text));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(said)));
  }

  Future<void> _add() async {
    final typed = senderField.text.trim();
    if (typed.isEmpty) return;
    if (await controller.senderCommand('add', typed)) senderField.clear();
  }

  /// The account's username page, and this Bot's address as it left it.
  Future<void> _chooseUsername() async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => EmailUsernamePage(api: widget.api),
      ),
    );
    if (mounted) await controller.load();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: DesktopHeader(child: AppBar(title: const Text('Email'))),
    body: AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        if (!controller.loaded && controller.busy) {
          return const FrockLoading(label: 'Loading email');
        }
        if (!controller.loaded) {
          return FrockEmptyState(
            icon: Icons.cloud_off_rounded,
            title: 'Email couldn’t load',
            detail:
                controller.message ?? 'Check your connection and try again.',
            action: 'Try again',
            onAction: () => unawaited(controller.load()),
          );
        }
        return identified(
          EmailIds.page,
          RefreshIndicator(
            onRefresh: controller.load,
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 680),
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
                  children: [
                    _intro(context),
                    if (!controller.available)
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
                    else ...[
                      const FrockSectionLabel('This Bot’s address'),
                      _address(context),
                    ],
                    const FrockSectionLabel('Who can email your Bots'),
                    _senders(context),
                    _status(context),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    ),
  );

  Widget _intro(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(4, 4, 4, 0),
    child: Text(
      'Email this Bot from your own address. What you send becomes a message '
      'in its conversation, with the files attached. Its answer stays here in '
      'the app — it doesn’t email you back yet.',
      style: Theme.of(context).textTheme.bodySmall
          ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
    ),
  );

  Widget _address(BuildContext context) {
    final theme = Theme.of(context);
    final quiet = theme.textTheme.bodySmall?.copyWith(
      fontSize: 12.5,
      color: theme.colorScheme.onSurfaceVariant,
    );
    final address = controller.address;
    final busy = controller.busy;
    return Card(
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          FrockRow(
            icon: Icons.mark_email_read_outlined,
            title: 'Receive email',
            subtitle: controller.receiving
                ? 'Mail to this address reaches the Bot'
                : 'Mail to this address is refused',
            chevron: false,
            onTap: busy
                ? null
                : () =>
                      unawaited(controller.setReceiving(!controller.receiving)),
            trailing: identified(
              EmailIds.receiving,
              Semantics(
                label: 'Receive email',
                child: Switch(
                  value: controller.receiving,
                  onChanged: busy
                      ? null
                      : (next) => unawaited(controller.setReceiving(next)),
                ),
              ),
            ),
          ),
          const Divider(height: 1),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
            // Keyed apart, so the Copy button is never the Choose button
            // restyled in place.
            child: address == null
                ? Column(
                    key: const ValueKey('no-username'),
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      identified(
                        EmailIds.noUsername,
                        Text(
                          'Your account has no email username yet, so this '
                          'Bot has no address. Choose one under Account → '
                          'Email username.',
                          style: theme.textTheme.bodyMedium,
                        ),
                      ),
                      const SizedBox(height: 12),
                      identified(
                        EmailIds.chooseUsername,
                        FilledButton(
                          onPressed: () => unawaited(_chooseUsername()),
                          child: const Text('Choose a username'),
                        ),
                      ),
                    ],
                  )
                : Column(
                    key: const ValueKey('address'),
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      identified(
                        EmailIds.address,
                        SelectableText(
                          address,
                          style: theme.textTheme.bodyLarge?.copyWith(
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'This Bot’s name and your username. Rename either and '
                        'the address changes; the old one stops working.',
                        style: quiet,
                      ),
                      const SizedBox(height: 12),
                      identified(
                        EmailIds.copy,
                        FilledButton.tonalIcon(
                          style: FilledButton.styleFrom(
                            minimumSize: const Size(0, 32),
                            padding: const EdgeInsets.symmetric(horizontal: 12),
                            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            textStyle: theme.textTheme.labelMedium,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(9),
                            ),
                          ),
                          onPressed: () =>
                              unawaited(_copy(address, 'Address copied.')),
                          icon: const Icon(Icons.copy_rounded, size: 16),
                          label: const Text('Copy'),
                        ),
                      ),
                    ],
                  ),
          ),
        ],
      ),
    );
  }

  Widget _senders(BuildContext context) {
    final theme = Theme.of(context);
    final quiet = theme.textTheme.bodySmall?.copyWith(
      fontSize: 12.5,
      color: theme.colorScheme.onSurfaceVariant,
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 0, 4, 8),
          child: Text(
            'Mail reaches your Bots only from these addresses, and only when '
            'the sender’s provider proves it came from them. One list for all '
            'your Bots.',
            style: quiet,
          ),
        ),
        if (controller.senders.isNotEmpty)
          FrockRowGroup(
            rows: [
              for (final sender in controller.senders) _sender(context, sender),
            ],
          ),
        const SizedBox(height: 12),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: identified(
                EmailIds.senderField,
                TextField(
                  controller: senderField,
                  keyboardType: TextInputType.emailAddress,
                  autocorrect: false,
                  textInputAction: TextInputAction.done,
                  onSubmitted: (_) => unawaited(_add()),
                  decoration: const InputDecoration(
                    labelText: 'Add an address',
                    hintText: 'you@work.example',
                  ),
                ),
              ),
            ),
            const SizedBox(width: 8),
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: identified(
                EmailIds.senderAdd,
                FilledButton(
                  onPressed: controller.busy ? null : () => unawaited(_add()),
                  child: const Text('Add'),
                ),
              ),
            ),
          ],
        ),
      ],
    );
  }

  Widget _sender(BuildContext context, BotEmailSender sender) {
    final theme = Theme.of(context);
    final remove = identified(
      EmailIds.senderRemove(sender.address),
      IconButton(
        tooltip: 'Remove ${sender.address}',
        icon: const Icon(Icons.close_rounded, size: 18),
        onPressed: controller.busy
            ? null
            : () =>
                  unawaited(controller.senderCommand('remove', sender.address)),
      ),
    );
    switch (sender.status) {
      case 'sign-in':
        return identified(
          EmailIds.sender(sender.address),
          FrockRow(
            icon: Icons.verified_outlined,
            title: sender.address,
            subtitle: 'The address you sign in with',
            chevron: false,
          ),
        );
      case 'verified':
        return identified(
          EmailIds.sender(sender.address),
          FrockRow(
            icon: Icons.verified_outlined,
            title: sender.address,
            subtitle: 'Confirmed',
            chevron: false,
            trailing: remove,
          ),
        );
      case 'expired':
        return identified(
          EmailIds.sender(sender.address),
          FrockRow(
            icon: Icons.schedule_rounded,
            title: sender.address,
            subtitle: 'Its code expired before it came back.',
            chevron: false,
            trailing: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                identified(
                  EmailIds.senderRenew(sender.address),
                  TextButton(
                    onPressed: controller.busy
                        ? null
                        : () => unawaited(
                            controller.senderCommand('add', sender.address),
                          ),
                    child: const Text('New code'),
                  ),
                ),
                remove,
              ],
            ),
          ),
        );
    }
    // Waiting for its code. Any of the User's Bots' addresses takes it,
    // whether or not that Bot receives email.
    final code = sender.code ?? '';
    final to = controller.address ?? 'any of your Bots’ email addresses';
    return identified(
      EmailIds.sender(sender.address),
      Padding(
        padding: const EdgeInsets.fromLTRB(14, 10, 12, 12),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: 22,
              child: Icon(
                Icons.mark_email_unread_outlined,
                size: 20,
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    sender.address,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      fontSize: 14,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'To confirm it, send this code from ${sender.address} to $to. '
                    'It works for a day.',
                    style: theme.textTheme.bodySmall?.copyWith(
                      fontSize: 12.5,
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      identified(
                        EmailIds.code(sender.address),
                        SelectableText(
                          code,
                          style: theme.textTheme.titleSmall?.copyWith(
                            letterSpacing: 1.2,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                      OutlinedButton(
                        style: frockCompactButton(context),
                        onPressed: code.isEmpty
                            ? null
                            : () => unawaited(_copy(code, 'Code copied.')),
                        child: const Text('Copy code'),
                      ),
                      identified(
                        EmailIds.check,
                        TextButton(
                          onPressed: controller.busy
                              ? null
                              : () => unawaited(controller.load()),
                          child: const Text('I’ve sent it'),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            remove,
          ],
        ),
      ),
    );
  }

  Widget _status(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: Semantics(
      liveRegion: true,
      child: Text(
        controller.message ?? '',
        style: Theme.of(context).textTheme.bodySmall
            ?.copyWith(color: Theme.of(context).colorScheme.error),
      ),
    ),
  );
}
